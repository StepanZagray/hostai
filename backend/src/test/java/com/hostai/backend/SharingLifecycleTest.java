package com.hostai.backend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static org.junit.jupiter.api.Assertions.assertAll;
import static org.junit.jupiter.api.Assertions.assertThrows;

import io.netty.channel.ChannelOption;
import jakarta.validation.Validation;
import jakarta.validation.ValidatorFactory;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.function.Executable;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.http.HttpStatus;
import org.springframework.http.client.reactive.ReactorClientHttpConnector;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Flux;
import reactor.core.scheduler.Scheduler;
import reactor.core.scheduler.Schedulers;
import reactor.netty.http.client.HttpClient;
import reactor.netty.resources.LoopResources;
import tools.jackson.databind.json.JsonMapper;

class SharingLifecycleTest {
    private static final String MODEL = "fixture-shared:small";
    private static final Duration WAIT = Duration.ofSeconds(5);
    private static final Instant START = Instant.parse("2026-01-02T03:04:05Z");
    private static final JsonMapper JSON = JsonMapper.builder().build();

    @TempDir Path temporary;
    private final MutableClock clock = new MutableClock(START);
    private final InferenceRegistry registry = new InferenceRegistry();
    private final List<SharingService> services = new ArrayList<>();
    private final List<CompletableFuture<?>> pending = new ArrayList<>();
    private SharingRuntimeStub runtime;
    private LoopResources clientLoops;
    private ExecutorService executor;
    private Scheduler scheduler;
    private ValidatorFactory validators;
    private RuntimeCatalog gateway;
    private ChatService owner;

    @BeforeEach void prepare() throws Exception {
        Files.setPosixFilePermissions(temporary, PosixFilePermissions.fromString("rwx------"));
        runtime = new SharingRuntimeStub();
        clientLoops = LoopResources.create("sharing-lifecycle-client", 1, true);
        executor = Executors.newThreadPerTaskExecutor(
                Thread.ofVirtual().name("sharing-lifecycle-inference-", 0).factory());
        scheduler = Schedulers.fromExecutorService(executor);
        validators = Validation.buildDefaultValidatorFactory();
        // Match the gateway's one-connection-per-exchange convention, with test-owned loops.
        HttpClient transport = HttpClient.newConnection().runOn(clientLoops)
                .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, 2_000)
                .followRedirect(false).disableRetry(true)
                .responseTimeout(Duration.ofSeconds(30));
        WebClient client = WebClient.builder().baseUrl(runtime.origin())
                .clientConnector(new ReactorClientHttpConnector(transport))
                .codecs(codecs -> codecs.defaultCodecs().maxInMemorySize(BackendConfiguration.MAX_BODY_BYTES))
                .build();
        // Stream deadlines must not be mistaken for an access lifecycle cancellation.
        gateway = RuntimeCatalog.single(client, scheduler, WAIT, Duration.ofSeconds(30), Duration.ofSeconds(60));
        owner = new ChatService(registry, gateway);
    }

    @Test
    void storedKeysAreReadableBackAcrossRestartUntilTheyAreRevokedOrExpire() {
        Path directory = temporary.resolve("access");
        SharingService first = service(directory);
        start(first);
        var kept = first.create("Keep this visitor", 168);
        var expiring = first.create("Short visitor", 1);
        var revoked = first.create("Revoke this visitor", 168);
        assertThat(first.key(kept.grant().id()).token()).isEqualTo(kept.token());
        assertThat(first.key(expiring.grant().id()).token()).isEqualTo(expiring.token());
        first.revoke(revoked.grant().id());
        assertRejected(HttpStatus.CONFLICT, () -> first.key(revoked.grant().id()));
        assertRejected(HttpStatus.NOT_FOUND, () -> first.key(UUID.randomUUID()));
        first.close();

        SharingService restarted = service(directory);
        // Stopped, unpublished, and freshly restarted: the key is still exactly the issued one.
        assertThat(restarted.status().state()).isEqualTo("stopped");
        assertThat(restarted.key(kept.grant().id()).token()).isEqualTo(kept.token());
        assertThat(restarted.key(kept.grant().id()).toString()).doesNotContain(kept.token());
        // Revocation drops key material; the two live keys keep theirs.
        assertThat(restarted.status().grants()).filteredOn(AccessGrantStore.Grant::recoverable).hasSize(2);
        clock.set(START.plus(Duration.ofHours(1)));
        assertRejected(HttpStatus.CONFLICT, () -> restarted.key(expiring.grant().id()));
        assertThat(restarted.key(kept.grant().id()).token()).isEqualTo(kept.token());
        assertRejected(HttpStatus.CONFLICT, () -> restarted.key(revoked.grant().id()));
    }

    @ParameterizedTest @ValueSource(booleans = {false, true})
    void durableRevocationAndDisabledStateSurviveStoreAndServiceReopen(boolean stopBeforeClose) throws Exception {
        Path directory = temporary.resolve("access");
        SharingService first = service(directory);
        start(first);
        var revoked = first.create("Revoke this visitor", 1);
        var valid = first.create("Keep this visitor", 1);
        assertThat(first.authenticate(revoked.token())).isEqualTo(revoked.grant());
        clock.set(START.plusSeconds(10));
        var committed = first.revoke(revoked.grant().id()).grants();
        assertThat(committed).filteredOn(grant -> grant.id().equals(revoked.grant().id()))
                .singleElement().satisfies(grant -> assertThat(grant.revokedAt()).isEqualTo(clock.instant()));
        assertRejected(HttpStatus.UNAUTHORIZED, () -> first.authenticate(revoked.token()));
        assertThat(first.authenticate(valid.token())).isEqualTo(valid.grant());
        if (stopBeforeClose) assertThat(first.stop().state()).isEqualTo("stopped");
        first.close();

        // Reopening the real store also proves that service.close released its exclusive lock.
        try (var reopened = AccessGrantStore.open(directory, clock)) {
            assertThat(reopened.list()).isEqualTo(committed);
            assertThat(reopened.authenticate(revoked.token())).isEmpty();
            assertThat(reopened.authenticate(valid.token())).contains(valid.grant());
        }
        assertThat(Files.readString(directory.resolve("grants.json")))
                .doesNotContain(revoked.token(), valid.token());

        SharingService restarted = service(directory);
        int metadataBefore = runtime.metadata.get();
        var stopped = restarted.status();
        assertThat(stopped.state()).isEqualTo("stopped");
        assertThat(stopped.error()).isNull();
        assertThat(stopped.guestUrl()).isNull();
        assertThat(stopped.model()).isNull();
        assertThat(stopped.grants()).isEqualTo(committed);
        // A valid persisted key must not enable publication by authentication or subscription.
        assertRejected(HttpStatus.SERVICE_UNAVAILABLE, () -> restarted.authenticate(valid.token()));
        assertRejected(HttpStatus.SERVICE_UNAVAILABLE, () -> restarted.session(valid.token()).block(WAIT));
        assertRejected(HttpStatus.SERVICE_UNAVAILABLE,
                () -> restarted.chat(valid.token(), request(MODEL)).blockLast(WAIT));
        assertThat(runtime.metadata.get()).isEqualTo(metadataBefore);
        assertThat(runtime.chats.get()).isZero();

        start(restarted);
        assertRejected(HttpStatus.UNAUTHORIZED, () -> restarted.authenticate(revoked.token()));
        assertRejected(HttpStatus.UNAUTHORIZED,
                () -> restarted.chat(revoked.token(), request(MODEL)).blockLast(WAIT));
        assertThat(restarted.authenticate(valid.token())).isEqualTo(valid.grant());
        assertCompleted(restarted.chat(valid.token(), request(MODEL)).collectList().block(WAIT));
        awaitIdle();
        assertThat(registry.counters()).isEqualTo(new InferenceRegistry.Counters(0, 1, 0));
    }

    @Test void activeGuestExpiresAndClosesItsActualUpstreamConnection() throws Exception {
        SharingService sharing = service(temporary.resolve("access"));
        start(sharing);
        var invite = sharing.create("Expires during generation", 1);
        assertThat(Duration.between(invite.grant().createdAt(), invite.grant().expiresAt()))
                .isEqualTo(Duration.ofHours(1));
        runtime.records = SharingRuntimeStub.hold();
        // Keep issuance within the public lifetime contract, then exercise the real expiry timer.
        clock.set(invite.grant().expiresAt().minusSeconds(1));
        RunningChat guest = observe(sharing.chat(invite.token(), request(MODEL)));
        awaitPartial(guest);
        assertAccessEnded(guest.completion().get(5, TimeUnit.SECONDS));

        // Check disposal while both the service and stub are still open. Teardown cannot pass this.
        awaitCancelledGuest();
        assertThat(sharing.status().state()).isEqualTo("local");
        assertThat(runtime.chats.get()).isEqualTo(1);
        // The injected clock is deliberately fixed between advances; move it to the expiry boundary
        // to check admission separately from the already-fired real-time cancellation deadline.
        clock.set(invite.grant().expiresAt());
        assertRejected(HttpStatus.UNAUTHORIZED, () -> sharing.authenticate(invite.token()));
        assertRejected(HttpStatus.UNAUTHORIZED,
                () -> sharing.chat(invite.token(), request(MODEL)).blockLast(WAIT));
        assertThat(runtime.chats.get()).isEqualTo(1);
    }

    @Test void cleanupWhileStoppedPreservesPausedPermissionsAndNeverStartsRuntimeOrListeners() throws Exception {
        Path directory = temporary.resolve("access");
        AccessGrantStore.IssuedGrant activeLocal;
        AccessGrantStore.IssuedGrant activeInternet;
        AccessGrantStore.IssuedGrant expired;
        AccessGrantStore.IssuedGrant revoked;
        try (var store = AccessGrantStore.open(directory, clock)) {
            activeLocal = store.create("Paused local", "another:model", Duration.ofHours(2));
            activeInternet = store.create("Paused internet", "other:model", Duration.ofHours(2), "internet");
            expired = store.create("Expired", MODEL, Duration.ofHours(1));
            revoked = store.create("Revoked", MODEL, Duration.ofHours(2), "internet");
            store.revoke(revoked.grant().id());
        }
        SharingService sharing = service(directory);
        clock.set(expired.grant().expiresAt().minusNanos(1));
        assertThat(sharing.status().removableKeys()).isEqualTo(1);
        clock.set(expired.grant().expiresAt());
        var before = Files.readAllBytes(directory.resolve("grants.json"));
        assertThat(sharing.status().removableKeys()).isEqualTo(2);
        assertThat(sharing.status().grants()).hasSize(4);
        assertThat(Files.readAllBytes(directory.resolve("grants.json"))).isEqualTo(before);
        var result = sharing.cleanup();
        assertThat(result.removedCount()).isEqualTo(2);
        assertThat(result.status().state()).isEqualTo("stopped");
        assertThat(result.status().guestUrl()).isNull();
        assertThat(result.status().model()).isNull();
        assertThat(result.status().internet().state()).isEqualTo("off");
        assertThat(result.status().removableKeys()).isZero();
        assertThat(result.status().requests().remainingGrantSlots()).isEqualTo(98);
        assertThat(result.status().grants()).containsExactly(activeInternet.grant(), activeLocal.grant());
        assertThat(sharing.cleanup().removedCount()).isZero();
        assertThat(runtime.metadata.get()).isZero();
        assertThat(runtime.chats.get()).isZero();
        sharing.close();
        clock.set(START);
        try (var reopened = AccessGrantStore.open(directory, clock)) {
            assertThat(reopened.authenticate(expired.token())).isEmpty();
            assertThat(reopened.authenticate(revoked.token())).isEmpty();
            assertThat(reopened.authenticate(activeLocal.token())).contains(activeLocal.grant());
            assertThat(reopened.authenticate(activeInternet.token())).contains(activeInternet.grant());
        }
    }

    @Test void cleanupEndsOnlyRemovedExpiredSessionsAndReleasesGuestCapacity() throws Exception {
        SharingService sharing = service(temporary.resolve("access"));
        start(sharing);
        var expired = sharing.create("Expires during generation", 1);
        var active = sharing.create("Keep active", 2);
        runtime.records = SharingRuntimeStub.hold();
        RunningChat guest = observe(sharing.chat(expired.token(), request(MODEL)));
        awaitPartial(guest);
        // The session's already-scheduled real-time deadline is an hour away.
        clock.set(expired.grant().expiresAt());
        var result = sharing.cleanup();
        assertThat(result.removedCount()).isEqualTo(1);
        assertThat(result.status().state()).isEqualTo("local");
        assertThat(result.status().grants()).containsExactly(active.grant());
        assertAccessEnded(guest.completion().get(5, TimeUnit.SECONDS));
        awaitCancelledGuest();
        clock.set(START);
        assertRejected(HttpStatus.UNAUTHORIZED, () -> sharing.authenticate(expired.token()));
        runtime.records = SharingRuntimeStub.complete();
        assertCompleted(sharing.chat(active.token(), request(MODEL)).collectList().block(WAIT));
        awaitIdle();
    }

    @Test void cleanupPreservesActiveGuestStreamAndItsRateLimit() throws Exception {
        SharingService sharing = service(temporary.resolve("access"));
        start(sharing);
        var retired = sharing.create("Remove", 1);
        sharing.revoke(retired.grant().id());
        var active = sharing.create("Keep", 1);
        for (int i = 1; i < SharingService.REQUESTS_PER_MINUTE; i++) {
            assertCompleted(sharing.chat(active.token(), request(MODEL)).collectList().block(WAIT));
            awaitIdle();
        }
        runtime.records = SharingRuntimeStub.hold();
        RunningChat guest = observe(sharing.chat(active.token(), request(MODEL)));
        awaitPartial(guest);
        var result = sharing.cleanup();
        assertThat(result.removedCount()).isEqualTo(1);
        assertThat(result.status().grants()).containsExactly(active.grant());
        assertThat(sharing.authenticate(active.token())).isEqualTo(active.grant());
        awaitPartial(guest);
        guest.completion().cancel(true);
        awaitIdle();
        runtime.records = SharingRuntimeStub.complete();
        assertThrows(SharingService.GuestBusyException.class,
                () -> sharing.chat(active.token(), request(MODEL)).blockLast(WAIT));
        assertThat(runtime.chats.get()).isEqualTo(SharingService.REQUESTS_PER_MINUTE);
    }

    @ParameterizedTest @ValueSource(strings = {"create", "revoke", "cleanup"})
    void storageMutationFailureStopsGuestsAndLeavesOwnerChatUsable(String operation) throws Exception {
        Path directory = temporary.resolve("access");
        SharingService sharing = service(directory);
        start(sharing);
        if (operation.equals("cleanup")) {
            var retired = sharing.create("Remove", 1);
            sharing.revoke(retired.grant().id());
        }
        var invite = sharing.create("Active visitor", 1);
        byte[] committed = Files.readAllBytes(directory.resolve("grants.json"));
        runtime.records = SharingRuntimeStub.hold();
        RunningChat guest = observe(sharing.chat(invite.token(), request(MODEL)));
        awaitPartial(guest);

        // Strict POSIX checks make this deterministic even for a privileged test runner.
        // Only fixture storage changes, and restoring permissions must not unpoison this service.
        try {
            Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("r-x------"));
            assertRejected(HttpStatus.SERVICE_UNAVAILABLE, () -> {
                if (operation.equals("create")) sharing.create("Must not be issued", 1);
                else if (operation.equals("cleanup")) sharing.cleanup();
                else sharing.revoke(invite.grant().id());
            });
        } finally {
            Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
        }
        assertAccessEnded(guest.completion().get(5, TimeUnit.SECONDS));
        awaitCancelledGuest();
        assertThat(Files.readAllBytes(directory.resolve("grants.json"))).isEqualTo(committed);
        var unavailable = sharing.status();
        assertThat(unavailable.state()).isEqualTo("unavailable");
        assertThat(unavailable.removableKeys()).isZero();
        assertRejected(HttpStatus.SERVICE_UNAVAILABLE, sharing::cleanup);
        assertThat(unavailable.error()).contains("Client access is stopped", "local chat still works");
        assertRejected(HttpStatus.SERVICE_UNAVAILABLE, () -> sharing.authenticate(invite.token()));
        assertRejected(HttpStatus.SERVICE_UNAVAILABLE, () -> sharing.session(invite.token()).block(WAIT));
        assertRejected(HttpStatus.SERVICE_UNAVAILABLE,
                () -> sharing.chat(invite.token(), request(MODEL)).blockLast(WAIT));
        assertThat(runtime.chats.get()).isEqualTo(1);

        runtime.records = SharingRuntimeStub.complete();
        assertCompleted(owner.chat(request("private-owner:small")).collectList().block(WAIT));
        awaitIdle();
        assertThat(registry.counters()).isEqualTo(new InferenceRegistry.Counters(0, 2, 0));
        assertThat(registry.requests().getFirst().model()).isEqualTo("private-owner:small");
        assertThat(registry.requests().getFirst().status()).isEqualTo("completed");
        assertThat(registry.requests().getFirst().outputTokens()).isEqualTo(3L);
        assertThat(runtime.chats.get()).isEqualTo(2);
        assertRejected(HttpStatus.SERVICE_UNAVAILABLE, () -> sharing.start(MODEL, "Fixture host").block(WAIT));
        assertThat(sharing.status().state()).isEqualTo("unavailable");
    }

    @Test void revocationBeforeFirstRecordCancelsTheConnectionAndReleasesGuestCapacity() throws Exception {
        SharingService sharing = service(temporary.resolve("access"));
        start(sharing);
        var revoked = sharing.create("Silent visitor", 1);
        var replacement = sharing.create("Next visitor", 1);
        runtime.records = Flux.never();
        RunningChat guest = observe(sharing.chat(revoked.token(), request(MODEL)));
        await().atMost(WAIT).untilAsserted(() -> {
            assertThat(runtime.chats.get()).isEqualTo(1);
            assertThat(runtime.connections.get()).isEqualTo(1);
            assertThat(registry.counters().activeRequests()).isEqualTo(1);
        });
        assertThat(guest.chunks()).isEmpty();
        assertThat(guest.completion()).isNotDone();
        sharing.revoke(revoked.grant().id());
        var failure = assertThrows(ExecutionException.class, () -> guest.completion().get(5, TimeUnit.SECONDS));
        assertThat(failure.getCause()).isInstanceOf(ChatService.AccessEndedException.class);
        assertThat(guest.chunks()).isEmpty();
        awaitCancelledGuest();

        runtime.records = SharingRuntimeStub.complete();
        assertCompleted(sharing.chat(replacement.token(), request(MODEL)).collectList().block(WAIT));
        awaitIdle();
        assertThat(registry.counters()).isEqualTo(new InferenceRegistry.Counters(0, 2, 0));
        assertThat(runtime.chats.get()).isEqualTo(2);
    }

    @Test void synchronousMetadataAssemblyFailureDoesNotOrphanGuestCapacity() {
        var probe = org.mockito.Mockito.spy(gateway);
        var sharing = new SharingService(probe, owner, validators.getValidator(), JSON,
                scheduler, temporary.resolve("access"), 0, clock);
        services.add(sharing);
        start(sharing);
        var invite = sharing.create("Visitor", 1);
        org.mockito.Mockito.doThrow(new IllegalStateException("Fixture assembly failure"))
                .doCallRealMethod().when(probe).read();
        assertThrows(IllegalStateException.class, () -> sharing.chat(invite.token(), request(MODEL)).blockLast(WAIT));
        assertCompleted(sharing.chat(invite.token(), request(MODEL)).collectList().block(WAIT));
        awaitIdle();
    }

    private SharingService service(Path directory) {
        var sharing = new SharingService(gateway, owner, validators.getValidator(), JSON,
                scheduler, directory, 0, clock);
        services.add(sharing);
        return sharing;
    }

    private void start(SharingService sharing) {
        var started = sharing.start(MODEL, "Fixture host").block(WAIT);
        assertThat(started).isNotNull();
        assertThat(started.state()).isEqualTo("local");
        assertThat(started.guestUrl()).startsWith("http://127.0.0.1:");
        awaitIdle();
    }

    private static Api.ChatRequest request(String model) {
        return new Api.ChatRequest(model, List.of(new Api.Message("user", "Fixture prompt")), 0.7, 128);
    }

    private RunningChat observe(Flux<Api.ChatChunk> source) {
        List<Api.ChatChunk> chunks = new CopyOnWriteArrayList<>();
        var completion = source.doOnNext(chunks::add).collectList().toFuture();
        pending.add(completion);
        return new RunningChat(chunks, completion);
    }

    private void awaitPartial(RunningChat guest) {
        await().pollInterval(Duration.ofMillis(10)).atMost(WAIT).untilAsserted(() -> {
            assertThat(guest.chunks()).singleElement().satisfies(chunk -> {
                assertThat(chunk.content()).isEqualTo("Partial guest reply");
                assertThat(chunk.done()).isFalse();
                assertThat(chunk.error()).isNull();
            });
            assertThat(guest.completion()).isNotDone();
            assertThat(registry.counters().activeRequests()).isEqualTo(1);
            assertThat(runtime.connections.get()).isEqualTo(1);
        });
    }

    private static void assertAccessEnded(List<Api.ChatChunk> chunks) {
        assertThat(chunks).hasSize(2);
        assertThat(chunks.getFirst().content()).isEqualTo("Partial guest reply");
        assertThat(chunks.getLast().done()).isTrue();
        assertThat(chunks.getLast().error()).contains("Client access ended.");
        assertThat(chunks.getLast().outputTokens()).isNull();
    }

    private static void assertCompleted(List<Api.ChatChunk> chunks) {
        assertThat(chunks).singleElement().satisfies(chunk -> {
            assertThat(chunk.content()).isEqualTo("Guest fixture reply");
            assertThat(chunk.done()).isTrue();
            assertThat(chunk.error()).isNull();
            assertThat(chunk.outputTokens()).isEqualTo(3L);
        });
    }

    private void awaitCancelledGuest() {
        awaitIdle();
        assertThat(registry.counters()).isEqualTo(new InferenceRegistry.Counters(0, 1, 0));
        assertThat(registry.requests()).singleElement().satisfies(request -> {
            assertThat(request.model()).isEqualTo(MODEL);
            assertThat(request.status()).isEqualTo("cancelled");
            assertThat(request.outputTokens()).isNull();
        });
    }

    private void awaitIdle() {
        await().atMost(WAIT).untilAsserted(() -> {
            assertThat(registry.counters().activeRequests()).isZero();
            assertThat(runtime.connections.get()).isZero();
        });
    }

    private static void assertRejected(HttpStatus status, Executable operation) {
        assertThat(assertThrows(GatewayException.class, operation).status()).isEqualTo(status);
    }

    @AfterEach void closeOwnedResources() {
        // assertAll attempts every cleanup even after a failed assertion or partially failed setup.
        // Service.close owns the guest listener and grant-store lock. The stub owns its listener
        // and loops; this fixture owns client loops, subscriptions, scheduler and executor.
        // GuestServer's shared Reactor HTTP loops and shared timer schedulers are not ours to stop.
        assertAll("sharing lifecycle resource cleanup",
                () -> assertAll(services.reversed().stream().map(service -> (Executable) service::close)),
                () -> pending.forEach(future -> future.cancel(true)),
                () -> { if (runtime != null) awaitIdle(); },
                () -> { if (runtime != null) runtime.close(); },
                () -> {
                    if (clientLoops != null)
                        clientLoops.disposeLater(Duration.ZERO, WAIT).block(WAIT.plusSeconds(1));
                },
                () -> { if (scheduler != null) scheduler.dispose(); },
                () -> {
                    if (executor != null) {
                        executor.shutdownNow();
                        assertThat(executor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
                    }
                },
                () -> { if (validators != null) validators.close(); },
                () -> {
                    if (runtime != null) {
                        assertThat(runtime.server.isDisposed()).isTrue();
                        assertThat(runtime.loops.isDisposed()).isTrue();
                        assertThat(runtime.connections.get()).isZero();
                        assertThat(runtime.unexpected.get()).isZero();
                    }
                    if (clientLoops != null) assertThat(clientLoops.isDisposed()).isTrue();
                    if (scheduler != null) assertThat(scheduler.isDisposed()).isTrue();
                    if (executor != null) assertThat(executor.isTerminated()).isTrue();
                    pending.forEach(future -> assertThat(future).isDone());
                });
    }

    private record RunningChat(List<Api.ChatChunk> chunks, CompletableFuture<List<Api.ChatChunk>> completion) {}

    private static final class MutableClock extends Clock {
        private final AtomicReference<Instant> now;
        private final ZoneId zone;
        private MutableClock(Instant now) { this(new AtomicReference<>(now), ZoneOffset.UTC); }
        private MutableClock(AtomicReference<Instant> now, ZoneId zone) { this.now = now; this.zone = zone; }
        void set(Instant instant) { now.set(instant); }
        @Override public ZoneId getZone() { return zone; }
        @Override public Clock withZone(ZoneId zone) { return new MutableClock(now, zone); }
        @Override public Instant instant() { return now.get(); }
    }
}
