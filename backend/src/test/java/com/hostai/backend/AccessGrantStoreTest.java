package com.hostai.backend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.hostai.backend.AccessGrantStore.Grant;
import com.hostai.backend.AccessGrantStore.IssuedGrant;
import com.hostai.backend.AccessGrantStore.StorageException;
import java.nio.channels.FileChannel;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

class AccessGrantStoreTest {
    private static final JsonMapper JSON = JsonMapper.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
    private static final Instant START = Instant.parse("2026-01-02T03:04:05Z");
    private static final Duration MINUTE = Duration.ofMinutes(1);
    private static final int MAX_BYTES = 128 * 1024;
    @TempDir Path temporary;
    private final MutableClock clock = new MutableClock(START);

    @Test
    void createAuthenticatesOnlyItsExactModelAndExposesOnlyMetadata() throws Exception {
        Path directory = temporary.resolve("store");
        try (var store = AccessGrantStore.open(directory, clock)) {
            var first = store.create("  My laptop 🔐  ", "Org/Exact.Model:Q4_0", Duration.ofDays(7));
            var second = store.create("Other", "another:tag", MINUTE);
            assertThat(store.authenticate(first.token())).contains(first.grant());
            assertThat(store.authenticate(second.token())).contains(second.grant());
            assertThat(first.grant().model()).isEqualTo("Org/Exact.Model:Q4_0");
            assertThat(first.grant().label()).isEqualTo("  My laptop 🔐  ");
            assertThat(first.grant().createdAt()).isEqualTo(START);
            assertThat(first.grant().expiresAt()).isEqualTo(START.plus(Duration.ofDays(7)));
            assertThat(first.grant().revokedAt()).isNull();
            assertThat(first.grant().channel()).isEqualTo("local");
            assertThat(second.grant().channel()).isEqualTo("local");
            assertThat(store.list()).containsExactly(second.grant(), first.grant());
            assertThatThrownBy(() -> store.list().clear()).isInstanceOf(UnsupportedOperationException.class);
            assertThat(first.token()).matches("hga1\\.[0-9a-f-]{36}\\.[A-Za-z0-9_-]{43}").hasSize(85);
            assertThat(second.token()).isNotEqualTo(first.token());
            String encodedSecret = first.token().substring(42);
            byte[] secret = Base64.getUrlDecoder().decode(encodedSecret);
            assertThat(secret).hasSize(32);
            String hash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(secret));
            var root = JSON.readTree(Files.readAllBytes(data(directory)));
            assertThat(root.propertyNames()).containsExactlyInAnyOrder("version", "grants");
            assertThat(root.get("version").intValue()).isEqualTo(2);
            assertThat(root.get("grants").get(1).get("hash").stringValue()).isEqualTo(hash);
            assertThat(root.get("grants").get(1).get("channel").stringValue()).isEqualTo("local");
            assertThat(root.get("grants").get(1).propertyNames()).containsExactlyInAnyOrder(
                    "id", "label", "model", "createdAt", "expiresAt", "revokedAt", "hash", "channel");
            assertThat(first.toString()).contains("[REDACTED]").doesNotContain(first.token(), encodedSecret, hash);
            assertThat(first.grant().toString()).doesNotContain(encodedSecret, hash);
            assertThat(store.list().toString()).doesNotContain(encodedSecret, hash);
            assertThat(store.authenticate(first.token()).toString()).doesNotContain(encodedSecret, hash);
            assertThat(store.toString()).doesNotContain(encodedSecret, hash);
            try (var files = Files.list(directory)) {
                for (Path file : files.toList()) {
                    assertThat(Files.readString(file)).doesNotContain(first.token(), encodedSecret, second.token());
                    assertMode(file, "rw-------");
                    assertThat(Files.getOwner(file)).isEqualTo(Files.getOwner(directory));
                }
            }
            assertMode(directory, "rwx------");
            assertThat(Files.size(directory.resolve("grants.lock"))).isZero();
            assertOnlyFinalFiles(directory);
        }
    }

    @Test
    void emptyDirectoryGetsVersionedEmptyFileAndReopens() throws Exception {
        Path directory = Files.createDirectory(temporary.resolve("empty"),
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        byte[] bytes;
        try (var store = AccessGrantStore.open(directory, clock)) {
            assertThat(store.list()).isEmpty();
            bytes = Files.readAllBytes(data(directory));
            assertThat(JSON.readTree(bytes).get("version").intValue()).isEqualTo(2);
            assertThat(JSON.readTree(bytes).get("grants").isArray()).isTrue();
            assertThat(JSON.readTree(bytes).get("grants").size()).isZero();
        }
        try (var store = AccessGrantStore.open(directory, clock)) {
            assertThat(store.list()).isEmpty();
            assertThat(Files.readAllBytes(data(directory))).isEqualTo(bytes);
        }
    }

    @Test
    void legacyFixtureReopensExclusivelyAsLocalWithoutRewritingOnOpenAuthenticateOrList() throws Exception {
        Path directory = temporary.resolve("legacy-read");
        var issued = writeLegacyFixture(directory);
        var expected = issued.stream().map(IssuedGrant::grant).toList();
        byte[] before = Files.readAllBytes(data(directory));
        var modified = Files.getLastModifiedTime(data(directory));
        assertThat(JSON.readTree(before).get("version").intValue()).isEqualTo(1);
        for (int attempt = 0; attempt < 2; attempt++) {
            try (var store = AccessGrantStore.open(directory, clock)) {
                assertThat(store.list()).containsExactlyElementsOf(expected)
                        .allMatch(grant -> grant.channel().equals("local"));
                assertThat(store.authenticate(issued.get(0).token())).contains(expected.get(0));
                assertThat(store.authenticate(issued.get(1).token())).isEmpty();
                assertThat(store.authenticate(issued.get(2).token())).isEmpty();
                assertThrows(StorageException.class, () -> AccessGrantStore.open(directory, clock));
                assertThat(probeInAnotherProcess(directory)).isEqualTo("DENIED");
                assertThat(Files.readAllBytes(data(directory))).isEqualTo(before);
                assertThat(Files.getLastModifiedTime(data(directory))).isEqualTo(modified);
            }
            assertThat(Files.readAllBytes(data(directory))).isEqualTo(before);
        }
        assertOnlyFinalFiles(directory);
    }

    @Test
    void internetIssuanceMigratesLegacyRowsWithoutPromotingThemAndReloadPreservesRevocation() throws Exception {
        Path directory = temporary.resolve("legacy-migrate");
        var legacy = writeLegacyFixture(directory);
        var legacyRows = JSON.readTree(Files.readAllBytes(data(directory))).get("grants");
        IssuedGrant internet;
        try (var store = AccessGrantStore.open(directory, clock)) {
            internet = store.create("Remote guest", "remote:model", MINUTE, "internet");
            assertThat(internet.grant().channel()).isEqualTo("internet");
            assertThat(store.authenticate(internet.token())).contains(internet.grant());
            var root = JSON.readTree(Files.readAllBytes(data(directory)));
            assertThat(root.get("version").intValue()).isEqualTo(2);
            assertThat(root.get("grants").size()).isEqualTo(4);
            assertThat(root.get("grants").get(0).get("channel").stringValue()).isEqualTo("internet");
            for (int i = 0; i < legacy.size(); i++) {
                var migrated = (ObjectNode) root.get("grants").get(i + 1).deepCopy();
                assertThat(migrated.get("channel").stringValue()).isEqualTo("local");
                migrated.remove("channel");
                assertThat(migrated).isEqualTo(legacyRows.get(i));
            }
            for (var issued : Stream.concat(legacy.stream(), Stream.of(internet)).toList()) {
                assertThat(Files.readString(data(directory)))
                        .doesNotContain(issued.token(), issued.token().substring(42));
            }
            assertMode(data(directory), "rw-------");
            assertOnlyFinalFiles(directory);
        }
        Grant revoked;
        byte[] committed;
        try (var store = AccessGrantStore.open(directory, clock)) {
            assertThat(store.list()).containsExactly(internet.grant(),
                    legacy.get(0).grant(), legacy.get(1).grant(), legacy.get(2).grant());
            assertThat(store.authenticate(internet.token())).contains(internet.grant());
            assertThat(store.authenticate(legacy.get(0).token())).contains(legacy.get(0).grant());
            assertThat(store.authenticate(legacy.get(1).token())).isEmpty();
            assertThat(store.authenticate(legacy.get(2).token())).isEmpty();
            clock.now = START.plusSeconds(10);
            revoked = store.revoke(internet.grant().id());
            assertThat(revoked).isEqualTo(new Grant(internet.grant().id(), internet.grant().label(),
                    internet.grant().model(), internet.grant().createdAt(), internet.grant().expiresAt(),
                    clock.now, "internet"));
            assertThat(store.authenticate(internet.token())).isEmpty();
            committed = Files.readAllBytes(data(directory));
        }
        try (var store = AccessGrantStore.open(directory, clock)) {
            assertThat(store.list()).containsExactly(revoked,
                    legacy.get(0).grant(), legacy.get(1).grant(), legacy.get(2).grant());
            assertThat(store.authenticate(internet.token())).isEmpty();
            assertThat(store.authenticate(legacy.get(0).token())).contains(legacy.get(0).grant());
            assertThat(store.authenticate(legacy.get(1).token())).isEmpty();
            assertThat(store.authenticate(legacy.get(2).token())).isEmpty();
            assertThat(store.revoke(revoked.id())).isEqualTo(revoked);
            assertThat(Files.readAllBytes(data(directory))).isEqualTo(committed);
        }
    }

    @Test
    void revocationAlsoMigratesLegacyRowsButAnIdempotentRevocationDoesNotRewrite() throws Exception {
        Path directory = temporary.resolve("legacy-revoke");
        var legacy = writeLegacyFixture(directory);
        byte[] before = Files.readAllBytes(data(directory));
        Grant revoked;
        try (var store = AccessGrantStore.open(directory, clock)) {
            assertThat(store.revoke(legacy.get(1).grant().id())).isEqualTo(legacy.get(1).grant());
            assertThat(Files.readAllBytes(data(directory))).isEqualTo(before);
            revoked = store.revoke(legacy.get(0).grant().id());
            assertThat(revoked.channel()).isEqualTo("local");
            var root = JSON.readTree(Files.readAllBytes(data(directory)));
            assertThat(root.get("version").intValue()).isEqualTo(2);
            var expectedRows = JSON.readTree(before).get("grants");
            for (int i = 0; i < legacy.size(); i++) {
                var expected = (ObjectNode) expectedRows.get(i).deepCopy();
                expected.put("channel", "local");
                if (i == 0) expected.put("revokedAt", START.toString());
                assertThat(root.get("grants").get(i)).isEqualTo(expected);
            }
        }
        try (var store = AccessGrantStore.open(directory, clock)) {
            assertThat(store.list()).containsExactly(revoked, legacy.get(1).grant(), legacy.get(2).grant());
            for (var issued : legacy) assertThat(store.authenticate(issued.token())).isEmpty();
        }
    }

    @Test
    void existingApisAlwaysIssueLocalAndCopiedTokensReturnTheStoredChannel() throws Exception {
        Path directory = temporary.resolve("channels");
        IssuedGrant local;
        IssuedGrant internet;
        List<Grant> expected;
        try (var store = AccessGrantStore.open(directory, clock)) {
            internet = store.create("Same", "model", MINUTE, "internet");
            local = store.create("Same", "model", MINUTE);
            var explicitLocal = store.create("Same", "model", MINUTE, "local");
            assertThat(local.grant()).isEqualTo(new Grant(local.grant().id(), "Same", "model",
                    START, START.plus(MINUTE), null));
            assertThat(local.grant().channel()).isEqualTo("local");
            assertThat(explicitLocal.grant().channel()).isEqualTo("local");
            expected = List.of(explicitLocal.grant(), local.grant(), internet.grant());
        }
        try (var store = AccessGrantStore.open(directory, clock)) {
            byte[] before = Files.readAllBytes(data(directory));
            assertThat(store.list()).isEqualTo(expected);
            // Copying a bearer credential preserves its stored channel; the service checks arrival.
            assertThat(store.authenticate(new String(local.token().toCharArray()))).contains(local.grant());
            assertThat(store.authenticate(new String(internet.token().toCharArray()))).contains(internet.grant());
            assertThat(store.authenticate("hga1." + internet.grant().id() + local.token().substring(41))).isEmpty();
            assertThat(store.authenticate("hga1." + local.grant().id() + internet.token().substring(41))).isEmpty();
            assertThat(Files.readAllBytes(data(directory))).isEqualTo(before);
        }
    }

    static Stream<String> invalidChannels() {
        return Stream.of(null, "", " ", "LOCAL", "Internet", " local", "internet ", "local\n",
                "internet\0", "remote", "local,internet", "іnternet", "x".repeat(1025));
    }

    @ParameterizedTest @MethodSource("invalidChannels")
    void invalidChannelIssuanceAndMetadataAreRejectedWithoutPoisoning(String channel) throws Exception {
        Path directory = temporary.resolve("invalid-channel");
        var legacy = writeLegacyFixture(directory);
        try (var store = AccessGrantStore.open(directory, clock)) {
            byte[] before = Files.readAllBytes(data(directory));
            assertThatThrownBy(() -> store.create("Label", "model", MINUTE, channel))
                    .isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> new Grant(UUID.randomUUID(), "Label", "model",
                    START, START.plus(MINUTE), null, channel)).isInstanceOf(IllegalArgumentException.class);
            assertThat(store.list()).isEqualTo(legacy.stream().map(IssuedGrant::grant).toList());
            assertThat(store.authenticate(legacy.get(0).token())).contains(legacy.get(0).grant());
            assertThat(Files.readAllBytes(data(directory))).isEqualTo(before);
            var accepted = store.create("Accepted", "model", MINUTE, "internet");
            assertThat(store.authenticate(accepted.token())).contains(accepted.grant());
        }
    }

    @ParameterizedTest @MethodSource("invalidChannels")
    void invalidVersionTwoChannelsFailClosedWithoutLegacyFallback(String channel) throws Exception {
        Path directory = withGrant("invalid-persisted-channel");
        changeDocument(directory, root -> ((ObjectNode) root.get("grants").get(0)).put("channel", channel));
        byte[] before = Files.readAllBytes(data(directory));
        for (int attempt = 0; attempt < 2; attempt++) {
            assertSanitized(assertThrows(StorageException.class, () -> AccessGrantStore.open(directory, clock)), directory);
            assertThat(Files.readAllBytes(data(directory))).isEqualTo(before);
        }
    }

    @ParameterizedTest @ValueSource(strings = {"missing", "number", "boolean", "array", "object", "duplicate", "mixed"})
    void versionTwoRequiresExactlyOneStringChannelOnEveryRow(String kind) throws Exception {
        Path directory = withGrant("channel-shape");
        if (kind.equals("duplicate")) {
            Files.writeString(data(directory), Files.readString(data(directory))
                    .replace("\"channel\":\"local\"", "\"channel\":\"local\",\"channel\":\"internet\""));
        } else {
            changeDocument(directory, root -> {
                var row = (ObjectNode) root.get("grants").get(0);
                switch (kind) {
                    case "missing" -> row.remove("channel");
                    case "number" -> row.put("channel", 1);
                    case "boolean" -> row.put("channel", true);
                    case "array" -> row.putArray("channel").add("local");
                    case "object" -> row.putObject("channel").put("channel", "local");
                    case "mixed" -> {
                        var legacyRow = row.deepCopy().put("id", UUID.randomUUID().toString());
                        legacyRow.remove("channel");
                        root.withArray("grants").add(legacyRow);
                    }
                    default -> throw new AssertionError(kind);
                }
            });
        }
        byte[] before = Files.readAllBytes(data(directory));
        assertSanitized(assertThrows(StorageException.class, () -> AccessGrantStore.open(directory, clock)), directory);
        assertThat(Files.readAllBytes(data(directory))).isEqualTo(before);
    }

    @ParameterizedTest @ValueSource(strings = {"local", "internet"})
    void versionOneRejectsAnExplicitChannelEvenIfValid(String channel) throws Exception {
        Path directory = temporary.resolve("legacy-extra-channel");
        writeLegacyFixture(directory);
        changeDocument(directory, root -> ((ObjectNode) root.get("grants").get(0)).put("channel", channel));
        byte[] before = Files.readAllBytes(data(directory));
        assertSanitized(assertThrows(StorageException.class, () -> AccessGrantStore.open(directory, clock)), directory);
        assertThat(Files.readAllBytes(data(directory))).isEqualTo(before);
    }

    @Test
    void expiryIsExclusiveAndAuthenticationNeverChangesDiskOrRenews() throws Exception {
        Path directory = temporary.resolve("expiry");
        String token;
        Grant grant;
        byte[] bytes;
        try (var store = AccessGrantStore.open(directory, clock)) {
            var issued = store.create("Expiry", "model", MINUTE);
            token = issued.token();
            grant = issued.grant();
            bytes = Files.readAllBytes(data(directory));
            var modified = Files.getLastModifiedTime(data(directory));
            clock.now = grant.expiresAt().minusNanos(1);
            assertThat(store.authenticate(token)).contains(grant);
            clock.now = grant.expiresAt();
            assertThat(store.authenticate(token)).isEmpty();
            clock.now = grant.expiresAt().plusNanos(1);
            assertThat(store.authenticate(token)).isEmpty();
            assertThat(store.list()).containsExactly(grant);
            assertThat(Files.readAllBytes(data(directory))).isEqualTo(bytes);
            assertThat(Files.getLastModifiedTime(data(directory))).isEqualTo(modified);
        }
        try (var store = AccessGrantStore.open(directory, clock)) {
            assertThat(store.authenticate(token)).isEmpty();
            assertThat(store.list()).containsExactly(grant);
            assertThat(Files.readAllBytes(data(directory))).isEqualTo(bytes);
        }
    }

    @Test
    void revocationIsDurableAndIdempotentIncludingAfterRestart() throws Exception {
        Path directory = temporary.resolve("revoke");
        String revokedToken;
        String activeToken;
        Grant revoked;
        byte[] bytes;
        try (var store = AccessGrantStore.open(directory, clock)) {
            var first = store.create("Revoke", "first", Duration.ofHours(1));
            var second = store.create("Keep", "second", Duration.ofHours(1));
            revokedToken = first.token();
            activeToken = second.token();
            clock.now = START.plusSeconds(12);
            revoked = store.revoke(first.grant().id());
            assertThat(revoked.revokedAt()).isEqualTo(clock.now);
            assertThat(store.authenticate(revokedToken)).isEmpty();
            assertThat(store.authenticate(activeToken)).contains(second.grant());
            bytes = Files.readAllBytes(data(directory));
            clock.now = START.plusSeconds(20);
            assertThat(store.revoke(revoked.id())).isEqualTo(revoked);
            assertThat(Files.readAllBytes(data(directory))).isEqualTo(bytes);
        }
        try (var store = AccessGrantStore.open(directory, clock)) {
            assertThat(store.authenticate(revokedToken)).isEmpty();
            assertThat(store.authenticate(activeToken)).isPresent();
            assertThat(store.revoke(revoked.id())).isEqualTo(revoked);
            assertThat(store.list()).contains(revoked);
            assertThat(Files.readAllBytes(data(directory))).isEqualTo(bytes);
            assertThatThrownBy(() -> store.revoke(UUID.randomUUID())).isInstanceOf(IllegalArgumentException.class);
            assertThatThrownBy(() -> store.revoke(null)).isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    void newestFirstOrderAndClockRegressionContractSurviveRestart() {
        Path directory = temporary.resolve("ordering");
        List<Grant> expected;
        try (var store = AccessGrantStore.open(directory, clock)) {
            var first = store.create("First", "model", MINUTE);
            var tied = store.create("Tied", "model", MINUTE);
            clock.now = START.plusSeconds(1);
            var latest = store.create("Latest", "model", MINUTE);
            clock.now = START.minusSeconds(1);
            var older = store.create("Earlier clock", "model", MINUTE);
            var revoked = store.revoke(latest.grant().id());
            assertThat(revoked.revokedAt()).isEqualTo(latest.grant().createdAt());
            expected = List.of(revoked, tied.grant(), first.grant(), older.grant());
            assertThat(store.list()).isEqualTo(expected);
        }
        try (var store = AccessGrantStore.open(directory, clock)) {
            assertThat(store.list()).isEqualTo(expected);
        }
    }

    static Stream<String> invalidLabels() {
        return Stream.of(null, "", " ", "\t", "a".repeat(81), "line\nbreak", "nul\0", "del\u007f", "c1\u0085", "\ud800");
    }

    @ParameterizedTest @MethodSource("invalidLabels")
    void rejectsInvalidLabelsWithoutPoisoning(String label) throws Exception {
        try (var store = AccessGrantStore.open(temporary.resolve("labels"), clock)) {
            byte[] before = Files.readAllBytes(data(temporary.resolve("labels")));
            assertThatThrownBy(() -> store.create(label, "model", MINUTE)).isInstanceOf(IllegalArgumentException.class);
            assertThat(store.list()).isEmpty();
            assertThat(Files.readAllBytes(data(temporary.resolve("labels")))).isEqualTo(before);
            assertThat(store.authenticate(store.create("a".repeat(80), "model", MINUTE).token())).isPresent();
        }
    }

    static Stream<String> invalidModels() {
        return Stream.of(null, "", " ", "a b", "/leading", "🙂", "x".repeat(129), "a:cloud", "a-cloud", "a\n");
    }

    @ParameterizedTest @MethodSource("invalidModels")
    void usesExistingModelAdmissionAndLengthBound(String model) {
        try (var store = AccessGrantStore.open(temporary.resolve("models"), clock)) {
            assertThatThrownBy(() -> store.create("Label", model, MINUTE)).isInstanceOf(IllegalArgumentException.class);
            assertThat(store.list()).isEmpty();
            var accepted = store.create("Label", "a".repeat(128), MINUTE);
            assertThat(store.authenticate(accepted.token())).contains(accepted.grant());
        }
    }

    static Stream<Duration> invalidLifetimes() {
        return Stream.of(null, Duration.ZERO, Duration.ofSeconds(-1), MINUTE.minusNanos(1),
                Duration.ofDays(7).plusNanos(1), Duration.ofSeconds(Long.MAX_VALUE));
    }

    @ParameterizedTest @MethodSource("invalidLifetimes")
    void rejectsOutOfRangeLifetimeWithoutPoisoning(Duration lifetime) {
        try (var store = AccessGrantStore.open(temporary.resolve("lifetime"), clock)) {
            assertThatThrownBy(() -> store.create("Label", "model", lifetime)).isInstanceOf(IllegalArgumentException.class);
            assertThat(store.list()).isEmpty();
            assertThat(store.create("Minimum", "model", MINUTE).grant().expiresAt()).isEqualTo(START.plus(MINUTE));
            assertThat(store.create("Maximum", "model", Duration.ofDays(7)).grant().expiresAt())
                    .isEqualTo(START.plus(Duration.ofDays(7)));
        }
    }

    @Test
    void rejectsExpiryOverflowAndMissingOpenArguments() {
        assertThatThrownBy(() -> AccessGrantStore.open(null, clock)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> AccessGrantStore.open(temporary.resolve("missing"), null)).isInstanceOf(IllegalArgumentException.class);
        try (var store = AccessGrantStore.open(temporary.resolve("overflow"), clock)) {
            clock.now = Instant.MAX;
            assertThatThrownBy(() -> store.create("Overflow", "model", MINUTE)).isInstanceOf(IllegalArgumentException.class);
            clock.now = START;
            assertThat(store.list()).isEmpty();
            assertThat(store.authenticate(store.create("Okay", "model", MINUTE).token())).isPresent();
        }
    }

    @Test
    void malformedUnknownAndWrongCredentialsUniformlyFailWithoutSideEffects() throws Exception {
        Path directory = temporary.resolve("tokens");
        try (var store = AccessGrantStore.open(directory, clock)) {
            var issued = store.create("Label", "model", MINUTE);
            var other = store.create("Other", "other", MINUTE);
            String token = issued.token();
            byte[] bytes = Files.readAllBytes(data(directory));
            var timestamp = Files.getLastModifiedTime(data(directory));
            String alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
            char alias = alphabet.charAt(alphabet.indexOf(token.charAt(84)) + 1);
            List<String> bad = new ArrayList<>(Arrays.asList(null, "", " ", "Bearer " + token, token + "\n",
                    " " + token, token + "=", token.substring(1), token + "x", "hga2" + token.substring(4),
                    "HGA1" + token.substring(4), token.substring(0, 84) + "+", token.substring(0, 84) + "/",
                    token.substring(0, 84) + alias, token.substring(0, 84) + "\0", "x".repeat(MAX_BYTES + 1),
                    "hga1." + UUID.randomUUID() + token.substring(41),
                    "hga1." + other.grant().id() + token.substring(41)));
            byte[] secret = Base64.getUrlDecoder().decode(token.substring(42));
            for (int position : new int[] {0, 16, 31}) {
                byte[] wrong = secret.clone();
                wrong[position] ^= 1;
                bad.add(token.substring(0, 42) + Base64.getUrlEncoder().withoutPadding().encodeToString(wrong));
            }
            for (String value : bad) assertThat(store.authenticate(value)).isEmpty();
            assertThat(store.authenticate(token)).contains(issued.grant());
            assertThat(Files.readAllBytes(data(directory))).isEqualTo(bytes);
            assertThat(Files.getLastModifiedTime(data(directory))).isEqualTo(timestamp);
        }
    }

    @Test
    void hundredGrantCapIncludesActiveRevokedAndExpiredGrantsAcrossRestart() throws Exception {
        Path directory = temporary.resolve("capacity");
        String active;
        try (var store = AccessGrantStore.open(directory, clock)) {
            var first = store.create("First", "model", MINUTE);
            active = first.token();
            var tokens = new HashSet<String>();
            tokens.add(active);
            for (int i = 1; i < 100; i++) tokens.add(store.create("Grant " + i, "model", MINUTE).token());
            assertThat(tokens).hasSize(100);
            assertThat(store.list()).hasSize(100);
            assertThatThrownBy(() -> store.create("Full", "model", MINUTE)).isInstanceOf(IllegalStateException.class)
                    .isNotInstanceOf(StorageException.class).hasMessageContaining("100");
            assertThat(store.authenticate(active)).isPresent();
            store.revoke(first.grant().id());
            clock.now = START.plus(MINUTE);
            byte[] bytes = Files.readAllBytes(data(directory));
            assertThatThrownBy(() -> store.create("Still full", "model", MINUTE)).isInstanceOf(IllegalStateException.class);
            assertThat(store.list()).hasSize(100);
            assertThat(Files.readAllBytes(data(directory))).isEqualTo(bytes);
            assertThat(bytes.length).isLessThan(MAX_BYTES);
        }
        try (var store = AccessGrantStore.open(directory, clock)) {
            assertThat(store.authenticate(active)).isEmpty();
            assertThat(store.list()).hasSize(100);
            assertThatThrownBy(() -> store.create("Still full", "model", MINUTE)).isInstanceOf(IllegalStateException.class);
        }
    }

    static Stream<String> invalidDocuments() {
        return Stream.of("", " ", "{", "null", "[]", "{}", "{\"version\":1}",
                "{\"version\":1,\"grants\":[],\"extra\":true}",
                "{\"version\":3,\"grants\":[]}", "{\"version\":0,\"grants\":[]}",
                "{\"version\":4294967297,\"grants\":[]}", "{\"version\":1.0,\"grants\":[]}",
                "{\"version\":\"1\",\"grants\":[]}", "{\"version\":null,\"grants\":[]}",
                "{\"version\":1,\"version\":1,\"grants\":[]}",
                "{\"version\":1,\"grants\":[],\"grants\":[]}",
                "{\"version\":1,\"grants\":null}", "{\"version\":1,\"grants\":{}}",
                "{\"version\":1,\"grants\":[null]}", "{\"version\":1,\"grants\":[{}]}",
                "{\"version\":1,\"grants\":[[[[[[]]]]]]}",
                "{\"version\":1,\"grants\":[]} {}", "{\"version\":1,\"grants\":[]} trailing")
                .flatMap(document -> Stream.of(document, document.replace("\"version\":1", "\"version\":2")))
                .distinct();
    }

    @ParameterizedTest @MethodSource("invalidDocuments")
    void corruptSchemaIsNeverResetAndFailedOpenReleasesResources(String invalid) throws Exception {
        Path directory = initialized("corrupt");
        byte[] valid = Files.readAllBytes(data(directory));
        Files.writeString(data(directory), invalid);
        for (int attempt = 0; attempt < 2; attempt++) {
            assertSanitized(assertThrows(StorageException.class, () -> AccessGrantStore.open(directory, clock)), directory);
            assertThat(Files.readString(data(directory))).isEqualTo(invalid);
        }
        Files.write(data(directory), valid);
        try (var store = AccessGrantStore.open(directory, clock)) { assertThat(store.list()).isEmpty(); }
        assertOnlyFinalFiles(directory);
    }

    static Stream<Arguments> invalidRows() {
        return Stream.of(
                Arguments.of("id", "bad"), Arguments.of("id", "1-1-1-1-1"),
                Arguments.of("id", "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"), Arguments.of("id", null),
                Arguments.of("label", ""), Arguments.of("label", " "), Arguments.of("label", "a".repeat(81)),
                Arguments.of("label", "control\u0085"), Arguments.of("label", null),
                Arguments.of("model", "a:cloud"), Arguments.of("model", "bad model"),
                Arguments.of("model", "a".repeat(129)), Arguments.of("model", null),
                Arguments.of("hash", "a".repeat(63)), Arguments.of("hash", "A".repeat(64)),
                Arguments.of("hash", "z".repeat(64)), Arguments.of("hash", null),
                Arguments.of("createdAt", "bad"), Arguments.of("createdAt", null),
                Arguments.of("createdAt", "2026-01-02T03:04:05+00:00"),
                Arguments.of("expiresAt", START.toString()), Arguments.of("expiresAt", START.plusSeconds(59).toString()),
                Arguments.of("expiresAt", START.plus(Duration.ofDays(7)).plusNanos(1).toString()),
                Arguments.of("expiresAt", null), Arguments.of("revokedAt", START.minusNanos(1).toString()),
                Arguments.of("revokedAt", "bad"))
                .flatMap(invalid -> Stream.of(1, 2)
                        .map(version -> Arguments.of(version, invalid.get()[0], invalid.get()[1])));
    }

    @ParameterizedTest @MethodSource("invalidRows")
    void rejectsInvalidRows(int version, String field, String value) throws Exception {
        Path directory = withGrant("rows", version);
        changeDocument(directory, root -> ((ObjectNode) root.get("grants").get(0)).put(field, value));
        byte[] bytes = Files.readAllBytes(data(directory));
        assertSanitized(assertThrows(StorageException.class, () -> AccessGrantStore.open(directory, clock)), directory);
        assertThat(Files.readAllBytes(data(directory))).isEqualTo(bytes);
    }

    static Stream<Arguments> invalidRowShapes() {
        return Stream.of(1, 2).flatMap(version ->
                Stream.of("missing", "extra", "wrong-type", "duplicate-key", "duplicate-id", "too-many")
                        .map(kind -> Arguments.of(version, kind)));
    }

    @ParameterizedTest @MethodSource("invalidRowShapes")
    void rejectsRowShapeDuplicatesAndExcessRows(int version, String kind) throws Exception {
        Path directory = withGrant("shape", version);
        if (kind.equals("duplicate-key")) {
            String bytes = Files.readString(data(directory));
            Files.writeString(data(directory), bytes.replace("\"label\":", "\"label\":\"Duplicate\",\"label\":"));
        } else {
            changeDocument(directory, root -> {
                var row = (ObjectNode) root.get("grants").get(0);
                switch (kind) {
                    case "missing" -> row.remove("revokedAt");
                    case "extra" -> row.put("token", "unexpected");
                    case "wrong-type" -> row.put("label", 123);
                    case "duplicate-id" -> root.withArray("grants").add(row.deepCopy());
                    case "too-many" -> {
                        for (int i = 0; i < 100; i++) root.withArray("grants").add(row.deepCopy().put("id", UUID.randomUUID().toString()));
                    }
                    default -> throw new AssertionError(kind);
                }
            });
        }
        byte[] before = Files.readAllBytes(data(directory));
        assertThrows(StorageException.class, () -> AccessGrantStore.open(directory, clock));
        assertThat(Files.readAllBytes(data(directory))).isEqualTo(before);
    }

    @Test
    void enforcesByteLimitIncludingSparseOversizedFiles() throws Exception {
        Path directory = initialized("size");
        String valid = Files.readString(data(directory));
        Files.writeString(data(directory), valid + " ".repeat(MAX_BYTES - valid.length()));
        try (var store = AccessGrantStore.open(directory, clock)) { assertThat(store.list()).isEmpty(); }
        Files.writeString(data(directory), " ", StandardOpenOption.APPEND);
        assertThrows(StorageException.class, () -> AccessGrantStore.open(directory, clock));
        assertThat(Files.size(data(directory))).isEqualTo(MAX_BYTES + 1);
        try (var channel = FileChannel.open(data(directory), StandardOpenOption.WRITE)) {
            channel.position(1L << 30);
            channel.write(java.nio.ByteBuffer.wrap(new byte[] {0}));
        }
        assertThrows(StorageException.class, () -> AccessGrantStore.open(directory, clock));
        assertThat(Files.size(data(directory))).isEqualTo((1L << 30) + 1);
    }

    @ParameterizedTest @ValueSource(strings = {"rwxr-xr-x", "rwxr-x---", "rwx--x---", "r-x------"})
    void rejectsNonPrivateOrUnwritableDirectoryWithoutRepair(String mode) throws Exception {
        Path directory = initialized("directory-mode");
        Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString(mode));
        try {
            assertThrows(StorageException.class, () -> AccessGrantStore.open(directory, clock));
            assertMode(directory, mode);
        } finally { Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------")); }
        try (var store = AccessGrantStore.open(directory, clock)) { assertThat(store.list()).isEmpty(); }
    }

    static Stream<Arguments> invalidFileModes() {
        return Stream.of("grants.json", "grants.lock")
                .flatMap(file -> Stream.of("rw-r--r--", "rw-r-----", "r--------")
                        .map(mode -> Arguments.of(file, mode)));
    }

    @ParameterizedTest @MethodSource("invalidFileModes")
    void rejectsInsecureOrUnwritableFinalFileWithoutRepair(String file, String mode) throws Exception {
        Path directory = initialized("file-mode");
        Files.setPosixFilePermissions(directory.resolve(file), PosixFilePermissions.fromString(mode));
        assertThrows(StorageException.class, () -> AccessGrantStore.open(directory, clock));
        assertMode(directory.resolve(file), mode);
        Files.setPosixFilePermissions(directory.resolve(file), PosixFilePermissions.fromString("rw-------"));
        try (var store = AccessGrantStore.open(directory, clock)) { assertThat(store.list()).isEmpty(); }
    }

    @Test
    void failsClosedOnFilesystemWithoutPosixPermissions() throws Exception {
        try (var zip = FileSystems.newFileSystem(temporary.resolve("non-posix.zip"), Map.of("create", "true"))) {
            assertThrows(StorageException.class, () -> AccessGrantStore.open(zip.getPath("/store"), clock));
        }
    }

    @ParameterizedTest @ValueSource(strings = {"directory", "ancestor", "grants.json", "grants.lock", "dangling", "other"})
    void rejectsStorageDirectoryAncestorAndFileSymlinks(String kind) throws Exception {
        Path directory = initialized("links");
        Path target = directory;
        switch (kind) {
            case "directory" -> target = Files.createSymbolicLink(temporary.resolve("alias"), directory);
            case "ancestor" -> {
                Path alias = Files.createSymbolicLink(temporary.resolve("parent-alias"), temporary);
                target = alias.resolve("links");
            }
            case "grants.json", "grants.lock" -> {
                Path outside = temporary.resolve("outside");
                Files.move(directory.resolve(kind), outside);
                Files.createSymbolicLink(directory.resolve(kind), outside);
            }
            case "dangling" -> {
                Files.delete(data(directory));
                Files.createSymbolicLink(data(directory), temporary.resolve("absent"));
            }
            case "other" -> Files.createSymbolicLink(directory.resolve("unexpected"), data(directory));
            default -> throw new AssertionError(kind);
        }
        Path attempted = target;
        assertThrows(StorageException.class, () -> AccessGrantStore.open(attempted, clock));
    }

    @ParameterizedTest @ValueSource(strings = {"directory-instead-of-file", "unexpected-file", "nonempty-lock", "missing-state"})
    void rejectsOtherUnsafeStorageLayouts(String kind) throws Exception {
        Path directory = initialized("layout");
        switch (kind) {
            case "directory-instead-of-file" -> {
                Files.delete(data(directory));
                Files.createDirectory(data(directory), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
            }
            case "unexpected-file" -> privateFile(directory.resolve("unexpected"), "data");
            case "nonempty-lock" -> Files.writeString(directory.resolve("grants.lock"), "bad");
            case "missing-state" -> Files.delete(data(directory));
            default -> throw new AssertionError(kind);
        }
        assertThrows(StorageException.class, () -> AccessGrantStore.open(directory, clock));
        if (kind.equals("missing-state")) assertThat(Files.exists(data(directory))).isFalse();
    }

    @Test
    void secondOpenIsDeniedWithinAndAcrossProcessesWithoutReleasingFirstLock() throws Exception {
        Path directory = temporary.resolve("locked");
        try (var first = AccessGrantStore.open(directory, clock)) {
            var issued = first.create("First", "model", MINUTE);
            assertThrows(StorageException.class, () -> AccessGrantStore.open(directory, clock));
            assertThrows(StorageException.class, () -> AccessGrantStore.open(directory.resolve("."), clock));
            assertThat(probeInAnotherProcess(directory)).isEqualTo("DENIED");
            assertThat(first.authenticate(issued.token())).contains(issued.grant());
            assertThat(first.revoke(issued.grant().id()).revokedAt()).isEqualTo(START);
        }
        assertThat(probeInAnotherProcess(directory)).isEqualTo("OPEN");
        try (var reopened = AccessGrantStore.open(directory, clock)) { assertThat(reopened.list()).hasSize(1); }
    }

    @Test
    void closeIsIdempotentFailsClosedAndReleasesLock() {
        Path directory = temporary.resolve("closed");
        var store = AccessGrantStore.open(directory, clock);
        var issued = store.create("Close", "model", MINUTE);
        store.close();
        store.close();
        assertThat(store.authenticate(issued.token())).isEmpty();
        assertThatThrownBy(store::list).isInstanceOf(StorageException.class).hasMessageContaining("closed");
        assertThatThrownBy(() -> store.create("New", "model", MINUTE)).isInstanceOf(StorageException.class);
        assertThatThrownBy(() -> store.revoke(issued.grant().id())).isInstanceOf(StorageException.class);
        try (var reopened = AccessGrantStore.open(directory, clock)) {
            assertThat(reopened.authenticate(issued.token())).contains(issued.grant());
        }
    }

    @Test
    void failedOpenReleasesOperatingSystemLockAndCanBeRepairedExplicitly() throws Exception {
        Path directory = initialized("failed-open");
        byte[] valid = Files.readAllBytes(data(directory));
        Files.writeString(data(directory), "corrupt");
        assertThrows(StorageException.class, () -> AccessGrantStore.open(directory, clock));
        Files.write(data(directory), valid);
        assertThat(probeInAnotherProcess(directory)).isEqualTo("OPEN");
        try (var reopened = AccessGrantStore.open(directory, clock)) { assertThat(reopened.list()).isEmpty(); }
    }

    @ParameterizedTest @ValueSource(strings = {"create", "revoke"})
    void filesystemWriteFailureNeverReturnsSuccessAndPermanentlyPoisonsInstance(String operation) throws Exception {
        Path directory = temporary.resolve("write-failure");
        String oldToken;
        Grant original;
        Path saved = temporary.resolve("saved.json");
        try (var store = AccessGrantStore.open(directory, clock)) {
            var issued = store.create("Original", "model", MINUTE);
            oldToken = issued.token();
            original = issued.grant();
            Files.move(data(directory), saved);
            Files.createDirectory(data(directory), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
            StorageException failure = assertThrows(StorageException.class, () -> {
                if (operation.equals("create")) store.create("Never returned", "model", MINUTE);
                else store.revoke(original.id());
            });
            assertSanitized(failure, directory);
            assertThat(failure.getMessage()).contains("disabled");
            assertThat(store.authenticate(oldToken)).isEmpty();
            assertThatThrownBy(store::list).isInstanceOf(StorageException.class).hasMessageContaining("disabled");
            Files.delete(data(directory));
            Files.move(saved, data(directory));
            assertThat(store.authenticate(oldToken)).isEmpty();
            assertThatThrownBy(() -> store.create("Still disabled", "model", MINUTE)).isInstanceOf(StorageException.class);
            assertThatThrownBy(() -> store.revoke(original.id())).isInstanceOf(StorageException.class);
            assertOnlyFinalFiles(directory);
        }
        // This injected failure happened before replacement; callers were never told revoke succeeded.
        try (var reopened = AccessGrantStore.open(directory, clock)) {
            assertThat(reopened.list()).containsExactly(original);
            assertThat(reopened.authenticate(oldToken)).contains(original);
        }
    }

    @ParameterizedTest @ValueSource(strings = {"create", "revoke"})
    void realWriteErrorCleansTemporaryFilePoisonsStoreAndReleasesLock(String operation) throws Exception {
        Path directory = temporary.resolve("file-size-limit");
        String token;
        Grant grant;
        try (var store = AccessGrantStore.open(directory, clock)) {
            var issued = store.create("Original", "model", MINUTE);
            token = issued.token();
            grant = issued.grant();
        }
        byte[] before = Files.readAllBytes(data(directory));
        // Only this child JVM gets RLIMIT_FSIZE=0. Ignoring SIGXFSZ makes write return EFBIG
        // instead of terminating it, exercising the actual FileChannel.write failure path.
        Process process = new ProcessBuilder("/bin/bash", "-c",
                "trap '' XFSZ; ulimit -f 0; exec \"$@\"", "grant-write-failure",
                Path.of(System.getProperty("java.home"), "bin", "java").toString(), "-XX:-UsePerfData",
                "-cp", System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")),
                WriteFailureProbe.class.getName(), directory.toString(), operation)
                .redirectErrorStream(true).start();
        long pid = process.pid();
        try {
            // The synthetic test credential travels over a pipe, never an argument or file.
            try (var input = process.getOutputStream()) {
                input.write((token + "\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));
            }
            assertThat(process.waitFor(15, TimeUnit.SECONDS)).as("write probe PID %s finished", pid).isTrue();
            String output = new String(process.getInputStream().readNBytes(4096), java.nio.charset.StandardCharsets.UTF_8);
            assertThat(process.exitValue()).as("write probe result: %s", output).isZero();
            assertThat(output).isEqualTo("FAILED_CLOSED");
        } finally {
            if (process.isAlive()) process.destroyForcibly();
            assertThat(process.waitFor(10, TimeUnit.SECONDS)).as("write probe PID %s cleaned up", pid).isTrue();
            assertThat(process.isAlive()).isFalse();
            process.getInputStream().close();
            process.getErrorStream().close();
        }
        assertThat(Files.readAllBytes(data(directory))).isEqualTo(before);
        assertOnlyFinalFiles(directory);
        try (var reopened = AccessGrantStore.open(directory, clock)) {
            assertThat(reopened.list()).containsExactly(grant);
            assertThat(reopened.authenticate(token)).contains(grant);
        }
    }

    @ParameterizedTest @ValueSource(strings = {"directory-permission", "data-permission", "lock-replaced", "data-replaced"})
    void mutationsFailClosedWhenStorageSecurityChanges(String change) throws Exception {
        Path directory = temporary.resolve("changed");
        try (var store = AccessGrantStore.open(directory, clock)) {
            var issued = store.create("Original", "model", MINUTE);
            switch (change) {
                case "directory-permission" -> Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("r-x------"));
                case "data-permission" -> Files.setPosixFilePermissions(data(directory), PosixFilePermissions.fromString("rw-r-----"));
                case "lock-replaced", "data-replaced" -> {
                    Path file = change.equals("lock-replaced") ? directory.resolve("grants.lock") : data(directory);
                    byte[] bytes = Files.readAllBytes(file);
                    Files.move(file, temporary.resolve("previous"));
                    privateFile(file, new String(bytes, java.nio.charset.StandardCharsets.UTF_8));
                }
                default -> throw new AssertionError(change);
            }
            assertThrows(StorageException.class, () -> store.revoke(issued.grant().id()));
            assertThat(store.authenticate(issued.token())).isEmpty();
            assertThrows(StorageException.class, store::list);
        } finally {
            Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
        }
    }

    @Test
    void onlyCleansRecognizedPrivateCrashTemporaryFilesAfterAcquiringLock() throws Exception {
        Path directory = temporary.resolve("temporary-files");
        Path stale = directory.resolve(".grants-crash.tmp");
        try (var store = AccessGrantStore.open(directory, clock)) {
            store.create("Keep", "model", MINUTE);
            privateFile(stale, "partial write");
            assertThrows(StorageException.class, () -> AccessGrantStore.open(directory, clock));
            assertThat(Files.exists(stale)).isTrue();
        }
        try (var store = AccessGrantStore.open(directory, clock)) {
            assertThat(store.list()).hasSize(1);
            assertThat(Files.exists(stale)).isFalse();
            assertOnlyFinalFiles(directory);
        }
    }

    @Test
    void readersObserveOnlyCompleteVersionedSnapshotsDuringAtomicReplacement() throws Exception {
        Path directory = temporary.resolve("atomic");
        try (var store = AccessGrantStore.open(directory, clock);
             var reader = Executors.newSingleThreadExecutor()) {
            CountDownLatch started = new CountDownLatch(1);
            AtomicBoolean running = new AtomicBoolean(true);
            var observed = reader.submit(() -> {
                int snapshots = 0;
                do {
                    var root = JSON.readTree(Files.readAllBytes(data(directory)));
                    assertThat(root.get("version").intValue()).isEqualTo(2);
                    assertThat(root.get("grants").isArray()).isTrue();
                    var ids = new HashSet<String>();
                    for (var row : root.get("grants")) {
                        assertThat(row.size()).isEqualTo(8);
                        assertThat(row.get("channel").stringValue()).isIn("local", "internet");
                        assertThat(row.get("hash").stringValue()).matches("[0-9a-f]{64}");
                        assertThat(ids.add(row.get("id").stringValue())).isTrue();
                    }
                    assertMode(data(directory), "rw-------");
                    snapshots++;
                    started.countDown();
                } while (running.get());
                return snapshots;
            });
            try {
                assertThat(started.await(10, TimeUnit.SECONDS)).isTrue();
                for (int i = 0; i < 30; i++) {
                    var issued = store.create("Atomic " + i, "model", MINUTE, i % 2 == 0 ? "local" : "internet");
                    store.revoke(issued.grant().id());
                }
            } finally { running.set(false); }
            assertThat(observed.get(10, TimeUnit.SECONDS)).isPositive();
            assertThat(store.list()).hasSize(30).allMatch(grant -> grant.revokedAt() != null);
            assertOnlyFinalFiles(directory);
        }
        try (var reopened = AccessGrantStore.open(directory, clock)) {
            assertThat(reopened.list()).hasSize(30).allMatch(grant -> grant.revokedAt() != null);
        }
    }

    /** Generates the old exact schema independently of the current store writer, using test-only secrets. */
    private List<IssuedGrant> writeLegacyFixture(Path directory) throws Exception {
        Files.createDirectory(directory,
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        var grants = List.of(
                new Grant(UUID.randomUUID(), "  Legacy laptop 🔐  ", "Org/Exact.Model:Q4_0",
                        START.minusSeconds(30), START.plusSeconds(3570), null),
                new Grant(UUID.randomUUID(), "Revoked", "other:model", START.minusSeconds(60),
                        START.plusSeconds(3540), START.minusSeconds(15)),
                new Grant(UUID.randomUUID(), "Expired", "old-model", START.minusSeconds(180),
                        START.minusSeconds(60), null));
        var root = JSON.createObjectNode().put("version", 1);
        var rows = root.putArray("grants");
        var issued = new ArrayList<IssuedGrant>();
        var random = new SecureRandom();
        for (var grant : grants) {
            byte[] secret = new byte[32];
            random.nextBytes(secret);
            try {
                rows.addObject().put("id", grant.id().toString()).put("label", grant.label())
                        .put("model", grant.model()).put("createdAt", grant.createdAt().toString())
                        .put("expiresAt", grant.expiresAt().toString())
                        .put("revokedAt", grant.revokedAt() == null ? null : grant.revokedAt().toString())
                        .put("hash", HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(secret)));
                issued.add(new IssuedGrant(grant, "hga1." + grant.id() + "."
                        + Base64.getUrlEncoder().withoutPadding().encodeToString(secret)));
            } finally { Arrays.fill(secret, (byte) 0); }
        }
        privateFile(data(directory), JSON.writeValueAsString(root));
        return List.copyOf(issued);
    }

    private Path initialized(String name) {
        Path directory = temporary.resolve(name);
        try (var ignored = AccessGrantStore.open(directory, clock)) { return directory; }
    }

    private Path withGrant(String name) throws Exception {
        return withGrant(name, 2);
    }

    private Path withGrant(String name, int version) throws Exception {
        Path directory = temporary.resolve(name);
        try (var store = AccessGrantStore.open(directory, clock)) {
            store.create("Valid", "model", MINUTE);
        }
        if (version == 1) {
            changeDocument(directory, root -> {
                root.put("version", 1);
                ((ObjectNode) root.get("grants").get(0)).remove("channel");
            });
        }
        return directory;
    }

    private static Path data(Path directory) { return directory.resolve("grants.json"); }

    private static void changeDocument(Path directory, Consumer<ObjectNode> change) throws Exception {
        var root = (ObjectNode) JSON.readTree(Files.readAllBytes(data(directory)));
        change.accept(root);
        Files.write(data(directory), JSON.writeValueAsBytes(root));
    }

    private static void privateFile(Path path, String content) throws Exception {
        Files.createFile(path, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
        Files.writeString(path, content);
    }

    private static void assertMode(Path path, String mode) throws Exception {
        assertThat(Files.getPosixFilePermissions(path)).isEqualTo(PosixFilePermissions.fromString(mode));
    }

    private static void assertOnlyFinalFiles(Path directory) throws Exception {
        try (var files = Files.list(directory)) {
            assertThat(files.map(path -> path.getFileName().toString()).toList())
                    .containsExactlyInAnyOrder("grants.json", "grants.lock");
        }
    }

    private static void assertSanitized(StorageException failure, Path directory) {
        assertThat(failure.getMessage()).doesNotContain(directory.toString(), "hash", "token");
        assertThat(failure.getCause()).isNull();
        assertThat(failure.getSuppressed()).isEmpty();
    }

    private String probeInAnotherProcess(Path directory) throws Exception {
        Path output = temporary.resolve("probe-" + UUID.randomUUID() + ".txt");
        Process process = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-XX:-UsePerfData", "-cp", System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")),
                LockProbe.class.getName(), directory.toString()).redirectErrorStream(true).redirectOutput(output.toFile()).start();
        long pid = process.pid();
        try {
            assertThat(process.waitFor(15, TimeUnit.SECONDS)).as("lock probe PID %s finished", pid).isTrue();
            assertThat(process.exitValue()).isZero();
            return Files.readString(output).strip();
        } finally {
            if (process.isAlive()) process.destroyForcibly();
            assertThat(process.waitFor(10, TimeUnit.SECONDS)).as("lock probe PID %s cleaned up", pid).isTrue();
            assertThat(process.isAlive()).isFalse();
        }
    }

    /** Separate JVM to exercise the operating-system lock through the public interface. */
    public static final class LockProbe {
        public static void main(String[] args) {
            try (var ignored = AccessGrantStore.open(Path.of(args[0]), Clock.fixed(START, ZoneOffset.UTC))) {
                System.out.print("OPEN");
            } catch (StorageException denied) { System.out.print("DENIED"); }
        }
    }

    public static final class WriteFailureProbe {
        public static void main(String[] args) throws Exception {
            String token = new java.io.BufferedReader(new java.io.InputStreamReader(
                    System.in, java.nio.charset.StandardCharsets.UTF_8)).readLine();
            try (var store = AccessGrantStore.open(Path.of(args[0]), Clock.fixed(START, ZoneOffset.UTC))) {
                UUID id = store.list().getFirst().id();
                if (store.authenticate(token).isEmpty()) throw new AssertionError("Fixture must authenticate before failure.");
                try {
                    if (args[1].equals("create")) store.create("Never returned", "model", MINUTE);
                    else store.revoke(id);
                    throw new AssertionError("Write failure must not return success.");
                } catch (StorageException expected) {
                    if (!expected.getMessage().contains("commit failed") || expected.getCause() != null) {
                        throw new AssertionError("Expected a sanitized commit failure.");
                    }
                }
                if (store.authenticate(token).isPresent()) throw new AssertionError("Poisoned store authenticated.");
                try {
                    store.list();
                    throw new AssertionError("Poisoned store listed grants.");
                } catch (StorageException expected) { /* permanently disabled */ }
                try {
                    store.revoke(id);
                    throw new AssertionError("Poisoned store mutated grants.");
                } catch (StorageException expected) { /* permanently disabled */ }
            }
            System.out.print("FAILED_CLOSED");
        }
    }

    private static final class MutableClock extends Clock {
        private Instant now;
        private MutableClock(Instant now) { this.now = now; }
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return Clock.fixed(now, zone); }
        @Override public Instant instant() { return now; }
    }
}
