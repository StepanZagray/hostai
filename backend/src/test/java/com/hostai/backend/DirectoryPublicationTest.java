package com.hostai.backend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class DirectoryPublicationTest {
    private static final Duration WAIT = Duration.ofSeconds(4);
    private static final DirectoryPublication.Shared SHARED = new DirectoryPublication.Shared(true, "Fixture host", "fixture:small");
    @TempDir Path temporary;

    @Test void absentAndInvalidConfigurationNeverOpenIdentityOrCallSharing() {
        for (String configured : List.of("", "http://registry.invalid", "https://secret@registry.invalid")) {
            var transport = new Transport();
            var config = DirectoryClient.Configuration.parse(configured, "false");
            try (var directory = new DirectoryPublication(config, () -> { throw new AssertionError("Sharing was accessed"); },
                    transport.internet, () -> { throw new AssertionError("Identity was accessed"); })) {
                assertThat(directory.status().configured()).isFalse();
                assertThat(directory.status().canPublish()).isFalse();
                assertThat(directory.start().error()).isEqualTo(config.error());
                assertThat(directory.stop().enabled()).isFalse();
                var json = DirectoryClient.JSON.valueToTree(directory.status());
                assertThat(json.propertyNames()).containsExactlyInAnyOrder("state", "configured", "registryUrl", "enabled",
                        "canPublish", "identityId", "updatedAt", "expiresAt", "error");
                for (String field : List.of("registryUrl", "identityId", "updatedAt", "expiresAt")) assertThat(json.get(field).isNull()).isTrue();
            }
            assertThat(transport.observers).isEmpty();
        }
    }

    @Test void springConstructionWithInvalidDirectorySettingsIsNonfatalAndLazy() {
        var transport = new Transport();
        var sharing = mock(SharingService.class);
        new org.springframework.boot.test.context.runner.ApplicationContextRunner()
                .withBean(SharingService.class, () -> sharing)
                .withBean(InternetSharing.class, () -> transport.internet)
                .withUserConfiguration(DirectoryPublication.class, DirectoryController.class)
                .withPropertyValues("hostai.directory-url=https://private@registry.invalid",
                        "hostai.directory-allow-loopback=invalid",
                        "hostai.access-directory=" + temporary.resolve("unused-access"))
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context.getBean(DirectoryPublication.class).status().error()).isEqualTo(DirectoryClient.INVALID);
                    assertThat(Files.exists(temporary.resolve("unused-access"))).isFalse();
                    assertThat(Files.exists(temporary.resolve("directory-identity"))).isFalse();
                    verify(sharing, never()).status();
                });
        assertThat(transport.observers).isEmpty();
    }

    @Test void onlyExplicitOptInOnVerifiedLiveLocalSharingCreatesIdentity() throws Exception {
        try (var fixture = new DirectoryClientTest.Fixture()) {
            var transport = new Transport();
            var opens = new AtomicInteger();
            var shared = new AtomicReference<>(SHARED);
            Path identityPath = temporary.resolve("identity");
            try (var directory = new DirectoryPublication(fixture.configuration(), shared::get, transport.internet,
                    () -> { opens.incrementAndGet(); return new DirectoryIdentity(identityPath); })) {
                assertThat(directory.start().error()).isEqualTo(DirectoryPublication.REQUIRE_LIVE);
                transport.emit("live", 1, DirectoryClientTest.GUEST);
                assertThat(directory.status().canPublish()).isTrue();
                assertThat(Files.exists(identityPath)).isFalse();
                shared.set(new DirectoryPublication.Shared(false, "Fixture host", "fixture:small"));
                assertThat(directory.start().enabled()).isFalse();
                assertThat(opens.get()).isZero();
                shared.set(SHARED);
                long before = System.nanoTime();
                assertThat(directory.start().state()).isEqualTo("publishing");
                assertThat(Duration.ofNanos(System.nanoTime() - before)).isLessThan(Duration.ofSeconds(1));
                listed(directory);
                assertThat(opens.get()).isEqualTo(1);
                assertThat(directory.status().enabled()).isTrue();
                assertThat(directory.status().identityId()).matches("[0-9a-f]{64}");
                assertThat(fixture.operations).containsExactly("publish");
            }
            assertThat(fixture.operations).containsExactly("publish", "withdraw");
            assertThat(transport.observers).isEmpty();
            verify(transport.internet, never()).stop();
            verify(transport.internet, never()).close();
        }
    }

    @Test void removeKeepsTransportAndGrantsAndOnlyVerifiedEventsTriggerHeartbeat() throws Exception {
        try (var fixture = new DirectoryClientTest.Fixture()) {
            var transport = new Transport(); transport.emit("live", 7, DirectoryClientTest.GUEST);
            try (var directory = publication(fixture, transport)) {
                directory.start(); listed(directory);
                await().during(Duration.ofMillis(120)).atMost(WAIT).untilAsserted(() -> assertThat(fixture.operations).containsExactly("publish"));
                transport.emit("live", 7, DirectoryClientTest.GUEST);
                await().atMost(WAIT).untilAsserted(() -> assertThat(fixture.operations).containsExactly("publish", "publish"));
                listed(directory);
                long before = System.nanoTime();
                assertThat(directory.stop().enabled()).isFalse();
                assertThat(Duration.ofNanos(System.nanoTime() - before)).isLessThan(Duration.ofSeconds(1));
                off(directory);
                assertThat(transport.current.get().status().state()).isEqualTo("live");
                transport.emit("live", 7, DirectoryClientTest.GUEST);
                await().during(Duration.ofMillis(120)).atMost(WAIT).untilAsserted(() -> assertThat(fixture.operations)
                        .containsExactly("publish", "publish", "withdraw"));
                assertThat(directory.status().updatedAt()).isNull();
                assertThat(directory.status().expiresAt()).isNull();
                assertThat(directory.status().canPublish()).isTrue();
                verify(transport.internet, never()).stop();
            }
        }
    }

    @Test void temporaryInterruptionWithdrawsAndCanRecoverOnlyTheExistingOptIn() throws Exception {
        try (var fixture = new DirectoryClientTest.Fixture()) {
            var transport = new Transport(); transport.emit("live", 1, DirectoryClientTest.GUEST);
            try (var directory = publication(fixture, transport)) {
                directory.start(); listed(directory);
                transport.emit("interrupted", 1, null);
                await().atMost(WAIT).untilAsserted(() -> assertThat(fixture.operations).containsExactly("publish", "withdraw"));
                assertThat(directory.status().state()).isEqualTo("interrupted");
                assertThat(directory.status().enabled()).isTrue();
                assertThat(directory.status().canPublish()).isFalse();
                transport.emit("live", 1, DirectoryClientTest.GUEST);
                listed(directory);
                assertThat(fixture.operations).containsExactly("publish", "withdraw", "publish");
                transport.emit("interrupted", 1, null);
                directory.stop(); off(directory);
                transport.emit("live", 1, DirectoryClientTest.GUEST);
                await().during(Duration.ofMillis(120)).atMost(WAIT).untilAsserted(() -> assertThat(directory.status().state()).isEqualTo("off"));
            }
        }
    }

    @Test void restartNewOriginAndAllTerminalTransportStatesClearOptIn() throws Exception {
        for (String cause : List.of("starting", "stopping", "off", "failed", "origin", "attempt")) {
            try (var fixture = new DirectoryClientTest.Fixture()) {
                var transport = new Transport(); transport.emit("live", 1, DirectoryClientTest.GUEST);
                try (var directory = publication(fixture, transport)) {
                    directory.start(); listed(directory);
                    transport.emit(cause.equals("origin") || cause.equals("attempt") ? "live" : cause,
                            cause.equals("attempt") ? 2 : 1,
                            cause.equals("origin") ? "https://new-fixture.trycloudflare.com/" : DirectoryClientTest.GUEST);
                    assertThat(directory.status().enabled()).isFalse();
                    // Coalescing a later live event must not erase the terminal transition.
                    transport.emit("live", 3, DirectoryClientTest.GUEST);
                    off(directory);
                    assertThat(fixture.operations).containsExactly("publish", "withdraw");
                    assertThat(directory.status().canPublish()).isTrue();
                }
            }
        }
    }

    @Test void staleSuccessAfterStopIsDiscardedAndWithdrawnWithoutAutomaticRepublish() throws Exception {
        try (var fixture = new DirectoryClientTest.Fixture()) {
            fixture.publishEntered = new CountDownLatch(1); fixture.releasePublish = new CountDownLatch(1);
            var transport = new Transport(); transport.emit("live", 1, DirectoryClientTest.GUEST);
            try (var directory = publication(fixture, transport)) {
                directory.start();
                assertThat(fixture.publishEntered.await(2, TimeUnit.SECONDS)).isTrue();
                long before = System.nanoTime();
                assertThat(directory.stop().enabled()).isFalse();
                assertThat(Duration.ofNanos(System.nanoTime() - before)).isLessThan(Duration.ofSeconds(1));
                off(directory); // Cancellation and withdrawal complete even while the old response is held.
                fixture.releasePublish.countDown();
                for (int index = 0; index < 200; index++) transport.emit("live", 1, DirectoryClientTest.GUEST);
                await().during(Duration.ofMillis(150)).atMost(WAIT).untilAsserted(() -> {
                    assertThat(directory.status().state()).isEqualTo("off");
                    assertThat(fixture.operations).containsExactly("publish", "withdraw");
                });
                assertThat(fixture.client().listings().listings()).isEmpty();
            }
        }
    }

    @Test void registryFailureCanRecoverOnANewVerifiedCheckWithoutAffectingTransport() throws Exception {
        try (var fixture = new DirectoryClientTest.Fixture()) {
            var transport = new Transport(); transport.emit("live", 1, DirectoryClientTest.GUEST);
            fixture.override = request -> new DirectoryClientTest.Reply(503, "application/json", "private-fixture-error");
            try (var directory = publication(fixture, transport)) {
                directory.start();
                await().atMost(WAIT).untilAsserted(() -> assertThat(directory.status().state()).isEqualTo("failed"));
                assertThat(directory.status().enabled()).isTrue();
                assertThat(directory.status().error()).contains("90 seconds").doesNotContain("private-fixture-error");
                assertThat(directory.status().updatedAt()).isNull();
                assertThat(directory.status().expiresAt()).isNull(); // No invented host-clock expiry for an uncertain remote update.
                assertThat(transport.current.get().status().state()).isEqualTo("live");
                await().during(Duration.ofMillis(120)).atMost(WAIT).untilAsserted(() -> assertThat(fixture.paths).hasSize(1));
                fixture.override = request -> null;
                transport.emit("live", 1, DirectoryClientTest.GUEST);
                listed(directory);
                assertThat(fixture.operations).containsExactly("publish");
                verify(transport.internet, never()).stop();
            }
        }
    }

    @Test void aNewOriginDuringPublishingDiscardsTheResponseAndClearsConsent() throws Exception {
        try (var fixture = new DirectoryClientTest.Fixture()) {
            fixture.publishEntered = new CountDownLatch(1); fixture.releasePublish = new CountDownLatch(1);
            var transport = new Transport(); transport.emit("live", 1, DirectoryClientTest.GUEST);
            try (var directory = publication(fixture, transport)) {
                directory.start(); assertThat(fixture.publishEntered.await(2, TimeUnit.SECONDS)).isTrue();
                transport.emit("live", 1, "https://new-fixture.trycloudflare.com/");
                assertThat(directory.status().enabled()).isFalse();
                off(directory); fixture.releasePublish.countDown();
                assertThat(fixture.operations).containsExactly("publish", "withdraw");
                assertThat(fixture.client().listings().listings()).isEmpty();
            }
        }
    }

    @Test void withdrawalFailureReportsBoundedUncertaintyAndRequiresNewOptIn() throws Exception {
        try (var fixture = new DirectoryClientTest.Fixture()) {
            var transport = new Transport(); transport.emit("live", 1, DirectoryClientTest.GUEST);
            try (var directory = publication(fixture, transport)) {
                directory.start(); listed(directory);
                Long previousExpiry = directory.status().expiresAt();
                fixture.failWithdraw = true;
                directory.stop();
                await().atMost(WAIT).untilAsserted(() -> {
                    assertThat(directory.status().state()).isEqualTo("failed");
                    assertThat(directory.status().error()).isEqualTo(DirectoryPublication.EXPIRY);
                });
                assertThat(directory.status().enabled()).isFalse();
                assertThat(directory.status().expiresAt()).isBetween(System.currentTimeMillis(), System.currentTimeMillis() + 90_000);
                assertThat(directory.status().expiresAt()).isEqualTo(previousExpiry);
                assertThat(fixture.client().listings().listings()).hasSize(1);
                transport.emit("live", 1, DirectoryClientTest.GUEST);
                await().during(Duration.ofMillis(120)).atMost(WAIT).untilAsserted(() -> assertThat(fixture.operations).containsExactly("publish", "withdraw"));
                fixture.failWithdraw = false;
                directory.stop(); off(directory);
            }
        }
    }

    @Test void identityFailureCannotStopChatOrInternetAndNeverLeaksTheUnderlyingException() throws Exception {
        try (var fixture = new DirectoryClientTest.Fixture()) {
            var transport = new Transport(); transport.emit("live", 1, DirectoryClientTest.GUEST);
            var sharing = mock(SharingService.class);
            when(sharing.status()).thenReturn(new SharingService.Status("local", "Fixture host", "fixture:small", null, null, List.of(), null, null));
            try (var directory = new DirectoryPublication(fixture.configuration(), () -> {
                var status = sharing.status();
                return new DirectoryPublication.Shared(status.state().equals("local"), status.hostLabel(), status.model());
            }, transport.internet, () -> { throw new IllegalStateException("private-fixture-secret"); })) {
                directory.start();
                await().atMost(WAIT).untilAsserted(() -> assertThat(directory.status().error()).isEqualTo(DirectoryPublication.IDENTITY_ERROR));
                assertThat(directory.status().enabled()).isFalse();
                assertThat(fixture.paths).isEmpty();
                assertThat(sharing.status().state()).isEqualTo("local");
                verify(sharing, never()).stop(); verify(sharing, never()).close();
                verify(transport.internet, never()).stop(); verify(transport.internet, never()).close();
            }
        }
    }

    @Test void identitySurvivesGatewayRestartButOptInDoesNot() throws Exception {
        try (var fixture = new DirectoryClientTest.Fixture()) {
            var transport = new Transport(); transport.emit("live", 1, DirectoryClientTest.GUEST);
            String firstId;
            try (var first = publication(fixture, transport)) {
                first.start(); listed(first); firstId = first.status().identityId();
                assertThatThrownBy(() -> new DirectoryIdentity(temporary.resolve("identity"))).isInstanceOf(DirectoryIdentity.StorageException.class);
            }
            try (var restarted = publication(fixture, transport)) {
                assertThat(restarted.status().state()).isEqualTo("off");
                assertThat(restarted.status().enabled()).isFalse();
                assertThat(restarted.status().identityId()).isNull(); // Lazy; no identity read on restart.
                assertThat(fixture.operations).containsExactly("publish", "withdraw");
                restarted.start(); listed(restarted);
                assertThat(restarted.status().identityId()).isEqualTo(firstId);
            }
            assertThat(transport.observers).isEmpty();
            assertThat(fixture.violation.get()).isFalse();
        }
    }

    @Test void closeReapsItsWorkerAndReleasesIdentityEvenWhenWithdrawalFails() throws Exception {
        try (var fixture = new DirectoryClientTest.Fixture()) {
            var transport = new Transport(); transport.emit("live", 1, DirectoryClientTest.GUEST);
            var directory = publication(fixture, transport);
            directory.start(); listed(directory); fixture.failWithdraw = true;
            assertThatThrownBy(directory::close).hasMessage(DirectoryPublication.EXPIRY);
            assertThat(transport.observers).isEmpty();
            try (var identity = new DirectoryIdentity(temporary.resolve("identity"))) {
                assertThat(identity.id()).isEqualTo(directory.status().identityId());
            }
            verify(transport.internet, never()).close();
        }
    }

    @Test void observerDeliveryIsOutsideInternetMonitorAndFailuresCannotAffectTransport() throws Exception {
        try (var internet = new InternetSharing("/missing-fixture-cloudflared")) {
            var events = new CopyOnWriteArrayList<InternetSharing.Observation>();
            try (var observation = internet.observe(event -> {
                assertThat(Thread.holdsLock(internet)).isFalse(); events.add(event);
            }); var throwing = internet.observe(event -> { throw new IllegalStateException("observer fixture"); })) {
                assertThat(internet.stop().state()).isEqualTo("off");
                assertThat(events).hasSize(2);
                assertThat(events.get(1).sequence()).isGreaterThan(events.get(0).sequence());
            }
            internet.stop(); assertThat(events).hasSize(2);
        }
    }

    @Test void privateIdentitySiblingsAreUniqueAndDoNotChangeTheAccessStore() throws Exception {
        String accessA = temporary.resolve("access-a").toString();
        String accessB = temporary.resolve("access-b").toString();
        Path identityA = DirectoryPublication.identityDirectory(accessA);
        assertThat(identityA).isNotEqualTo(DirectoryPublication.identityDirectory(accessB));
        String first;
        try (var a = DirectoryPublication.openIdentity(accessA); var b = DirectoryPublication.openIdentity(accessB)) {
            first = a.id();
            assertThat(a.id()).isNotEqualTo(b.id());
            assertThat(Files.exists(Path.of(accessA))).isFalse();
            assertThat(Files.exists(Path.of(accessB))).isFalse();
        }
        try (var reopened = DirectoryPublication.openIdentity(accessA)) { assertThat(reopened.id()).isEqualTo(first); }
    }

    @Test void customStoreUnderSharedParentCreatesOnlyItsOwnPrivateWrapper() throws Exception {
        Path shared = Files.createDirectory(temporary.resolve("shared"));
        var publicPermissions = java.nio.file.attribute.PosixFilePermissions.fromString("rwxr-xr-x");
        Files.setPosixFilePermissions(shared, publicPermissions);
        String access = shared.resolve("access").toString();
        try (var identity = DirectoryPublication.openIdentity(access)) { assertThat(identity.id()).hasSize(64); }
        assertThat(Files.getPosixFilePermissions(shared)).isEqualTo(publicPermissions);
        Path wrapper = DirectoryPublication.identityDirectory(access).getParent();
        Files.setPosixFilePermissions(wrapper, publicPermissions);
        assertThatThrownBy(() -> DirectoryPublication.openIdentity(access)).hasMessage(DirectoryPublication.IDENTITY_ERROR);
        assertThat(Files.getPosixFilePermissions(wrapper)).isEqualTo(publicPermissions);
    }

    @Test void identityWrapperRejectsSymlinksBeforeCreatingAnything() throws Exception {
        Path actual = Files.createDirectory(temporary.resolve("actual"));
        Path alias = Files.createSymbolicLink(temporary.resolve("alias"), actual);
        assertThatThrownBy(() -> DirectoryPublication.openIdentity(alias.resolve("access").toString()))
                .hasMessage(DirectoryPublication.IDENTITY_ERROR);
        try (var entries = Files.list(actual)) { assertThat(entries.count()).isZero(); }
    }

    private DirectoryPublication publication(DirectoryClientTest.Fixture fixture, Transport transport) {
        return new DirectoryPublication(fixture.configuration(), () -> SHARED, transport.internet,
                () -> new DirectoryIdentity(temporary.resolve("identity")));
    }

    @Test void concurrentReadersCannotFanOutRegistryConnections() throws Exception {
        try (var fixture = new DirectoryClientTest.Fixture()) {
            var entered = new CountDownLatch(1);
            var release = new CountDownLatch(1);
            fixture.override = request -> {
                entered.countDown();
                try { release.await(2, TimeUnit.SECONDS); }
                catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
                return null;
            };
            try (var directory = publication(fixture, new Transport())) {
                var error = new AtomicReference<Throwable>();
                Thread reader = Thread.ofVirtual().start(() -> {
                    try { directory.listings(); } catch (Throwable failure) { error.set(failure); }
                });
                try {
                    assertThat(entered.await(1, TimeUnit.SECONDS)).isTrue();
                    assertThatThrownBy(directory::listings).isInstanceOf(DirectoryClient.Failure.class);
                    assertThat(fixture.paths).containsExactly("GET /registry/v1/listings");
                } finally { release.countDown(); reader.join(Duration.ofSeconds(5)); }
                assertThat(reader.isAlive()).isFalse();
                assertThat(error.get()).isNull();
                var listed = directory.listings();
                assertThat(listed.listings()).isEmpty();
                assertThat(listed.registryUrl()).isEqualTo(fixture.configuration().origin().toString());
            }
        }
    }

    @Test void changedModelOrLabelWithdrawsWithoutPublishingDriftedMetadata() throws Exception {
        for (var changed : List.of(new DirectoryPublication.Shared(true, "Different label", "fixture:small"),
                new DirectoryPublication.Shared(true, "Fixture host", "fixture:other"))) {
            try (var fixture = new DirectoryClientTest.Fixture()) {
                var selected = new AtomicReference<>(SHARED);
                var transport = new Transport(); transport.emit("live", 1, DirectoryClientTest.GUEST);
                try (var directory = new DirectoryPublication(fixture.configuration(), selected::get, transport.internet,
                        () -> DirectoryPublication.openIdentity(temporary.resolve("access").toString()))) {
                    directory.start(); listed(directory);
                    selected.set(changed);
                    transport.emit("live", 1, DirectoryClientTest.GUEST);
                    off(directory);
                    assertThat(directory.status().enabled()).isFalse();
                    assertThat(fixture.operations).containsExactly("publish", "withdraw");
                    assertThat(fixture.client().listings().listings()).isEmpty();
                }
            }
        }
    }
    private static void listed(DirectoryPublication directory) {
        await().atMost(WAIT).untilAsserted(() -> assertThat(directory.status().state()).isEqualTo("listed"));
    }
    private static void off(DirectoryPublication directory) {
        await().atMost(WAIT).untilAsserted(() -> assertThat(directory.status().state()).isEqualTo("off"));
    }

    static final class Transport {
        final InternetSharing internet = mock(InternetSharing.class);
        final AtomicReference<InternetSharing.Observation> current = new AtomicReference<>(
                new InternetSharing.Observation(new InternetSharing.Status("off", "fixture", true, null, null, null), 0, 0));
        final List<Consumer<InternetSharing.Observation>> observers = new CopyOnWriteArrayList<>();
        Transport() {
            when(internet.observation()).thenAnswer(ignored -> current.get());
            doAnswer(invocation -> {
                Consumer<InternetSharing.Observation> callback = invocation.getArgument(0);
                observers.add(callback); callback.accept(current.get());
                return (AutoCloseable) () -> observers.remove(callback);
            }).when(internet).observe(org.mockito.ArgumentMatchers.any());
        }
        void emit(String state, long attempt, String origin) {
            var event = new InternetSharing.Observation(new InternetSharing.Status(state, "fixture", true,
                    state.equals("live") ? origin : null, Instant.now(), null), attempt, current.get().sequence() + 1);
            current.set(event); observers.forEach(observer -> observer.accept(event));
        }
    }
}
