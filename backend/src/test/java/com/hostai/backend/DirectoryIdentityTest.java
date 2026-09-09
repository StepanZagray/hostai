package com.hostai.backend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertAll;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.AdditionalAnswers.delegatesTo;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.mock;

import com.hostai.backend.DirectoryIdentity.StorageException;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileSystem;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.nio.file.spi.FileSystemProvider;
import java.security.KeyFactory;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.time.Clock;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.FutureTask;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BiPredicate;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

class DirectoryIdentityTest {
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final Base64.Encoder BASE64 = Base64.getUrlEncoder().withoutPadding();
    @TempDir Path temporary;

    @BeforeEach
    void privateFixtureParent() throws Exception {
        Files.setPosixFilePermissions(temporary, PosixFilePermissions.fromString("rwx------"));
    }

    @Test
    void createsPrivateIdentitySignsExactBytesAndSurvivesRestartWithoutRewriting() throws Exception {
        Path directory = temporary.resolve("identity");
        byte[] payload = { 0, 1, -1, -128, 10, 13, 32, 123, 125 };
        byte[] original = payload.clone();
        String publicKey;
        String id;
        String signed;
        byte[] persisted;
        try (var identity = new DirectoryIdentity(directory)) {
            publicKey = identity.publicKey();
            id = identity.id();
            signed = identity.sign(payload);
            assertThat(payload).isEqualTo(original);
            byte[] der = Base64.getUrlDecoder().decode(publicKey);
            assertThat(der).hasSize(44);
            assertThat(publicKey).isEqualTo(BASE64.encodeToString(der)).matches("[A-Za-z0-9_-]{59}");
            assertThat(id).isEqualTo(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(der)))
                    .matches("[0-9a-f]{64}");
            byte[] signature = Base64.getUrlDecoder().decode(signed);
            assertThat(signature).hasSize(64);
            assertThat(signed).isEqualTo(BASE64.encodeToString(signature)).matches("[A-Za-z0-9_-]{86}");
            PublicKey key = decodePublic(publicKey);
            assertThat(verify(key, payload, signed)).isTrue();
            payload[1] ^= 1;
            assertThat(verify(key, payload, signed)).isFalse();
            assertThat(verify(key, Arrays.copyOf(original, original.length - 1), signed)).isFalse();
            assertThat(verify(key, Arrays.copyOf(original, original.length + 1), signed)).isFalse();
            signature[32] ^= 1;
            assertThat(verify(key, original, BASE64.encodeToString(signature))).isFalse();
            assertThat(verify(key, new byte[0], identity.sign(new byte[0]))).isTrue();
            var anotherKey = KeyPairGenerator.getInstance("Ed25519").generateKeyPair().getPublic();
            assertThat(verify(anotherKey, original, signed)).isFalse();
            persisted = Files.readAllBytes(data(directory));
            var root = JSON.readTree(persisted);
            assertThat(root.propertyNames()).containsExactlyInAnyOrder("version", "publicKey", "privateKey");
            assertThat(root.get("version").intValue()).isEqualTo(1);
            assertThat(root.get("publicKey").stringValue()).isEqualTo(publicKey);
            assertThat(Base64.getUrlDecoder().decode(root.get("privateKey").stringValue())).hasSize(48);
            assertThat(identity.toString()).doesNotContain(root.get("privateKey").stringValue(), directory.toString());
            assertMode(directory, "rwx------");
            assertMode(data(directory), "rw-------");
            assertMode(lock(directory), "rw-------");
            assertThat(Files.getOwner(data(directory))).isEqualTo(Files.getOwner(directory));
            assertThat(Files.size(lock(directory))).isZero();
            assertOnlyFinalFiles(directory);
        }
        var modified = Files.getLastModifiedTime(data(directory));
        for (int attempt = 0; attempt < 2; attempt++) {
            try (var reopened = new DirectoryIdentity(directory)) {
                assertThat(reopened.publicKey()).isEqualTo(publicKey);
                assertThat(reopened.id()).isEqualTo(id);
                assertThat(reopened.sign(original)).isEqualTo(signed);
                assertThat(Files.readAllBytes(data(directory))).isEqualTo(persisted);
                assertThat(Files.getLastModifiedTime(data(directory))).isEqualTo(modified);
            }
        }
    }

    @Test
    void independentlyEncodedFixtureHasExpectedEmptyMessageSignature() throws Exception {
        Path directory = privateDirectory(temporary.resolve("fixed"));
        String publicKey = BASE64.encodeToString(HexFormat.of().parseHex(
                "302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"));
        String privateKey = BASE64.encodeToString(HexFormat.of().parseHex(
                "302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"));
        privateFile(lock(directory), "");
        privateFile(data(directory), JSON.writeValueAsString(JSON.createObjectNode()
                .put("version", 1).put("publicKey", publicKey).put("privateKey", privateKey)));
        try (var identity = new DirectoryIdentity(directory)) {
            assertThat(HexFormat.of().formatHex(Base64.getUrlDecoder().decode(identity.sign(new byte[0]))))
                    .isEqualTo("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555"
                            + "fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
        }
    }

    @Test
    void existingEmptyPrivateDirectoryIsAllowedAndIndependentDirectoriesGetDifferentIdentities() throws Exception {
        Path empty = privateDirectory(temporary.resolve("empty"));
        try (var first = new DirectoryIdentity(empty);
             var second = new DirectoryIdentity(temporary.resolve("other"))) {
            assertThat(first.id()).isNotEqualTo(second.id());
            assertThat(first.publicKey()).isNotEqualTo(second.publicKey());
        }
    }

    @Test
    void subdirectoryDoesNotChangeOrContendWithParentGrantStorage() throws Exception {
        Path parent = privateDirectory(temporary.resolve("access"));
        Path grantsDirectory = parent.resolve("grants");
        try (var grants = AccessGrantStore.open(grantsDirectory, Clock.systemUTC())) {
            var mode = Files.getPosixFilePermissions(parent);
            byte[] grantBytes = Files.readAllBytes(grantsDirectory.resolve("grants.json"));
            try (var identity = new DirectoryIdentity(parent.resolve("directory-identity"))) {
                assertThat(identity.id()).hasSize(64);
                assertThat(grants.list()).isEmpty();
                assertThat(Files.getPosixFilePermissions(parent)).isEqualTo(mode);
                assertThat(Files.readAllBytes(grantsDirectory.resolve("grants.json"))).isEqualTo(grantBytes);
                assertThat(Files.size(grantsDirectory.resolve("grants.lock"))).isZero();
                var grant = grants.create("Fixture", "model", java.time.Duration.ofMinutes(1));
                assertThat(grants.revoke(grant.grant().id()).revokedAt()).isNotNull();
                assertThat(identity.sign(new byte[] { 1 })).hasSize(86);
            }
        }
    }

    @Test
    void lockIsExclusiveAcrossJvmAliasesAndProcessesAndReleasedOnClose() throws Exception {
        Path directory = temporary.resolve("locked");
        String id;
        try (var identity = new DirectoryIdentity(directory)) {
            id = identity.id();
            assertThrows(StorageException.class, () -> new DirectoryIdentity(directory));
            assertThrows(StorageException.class, () -> new DirectoryIdentity(directory.resolve(".")));
            // A second JVM distinguishes the required OS lock from only an in-memory guard;
            // run after rejected JVM opens to detect accidental release of POSIX process locks.
            assertThat(runProbe(new ProcessBuilder(javaCommand(), "-XX:-UsePerfData", "-cp", classPath(),
                    LockProbe.class.getName(), directory.toString()))).isEqualTo("DENIED");
            assertThat(identity.id()).isEqualTo(id);
        }
        assertThat(runProbe(new ProcessBuilder(javaCommand(), "-XX:-UsePerfData", "-cp", classPath(),
                LockProbe.class.getName(), directory.toString()))).isEqualTo(id);
    }

    @Test
    void closeIsIdempotentAndNullPayloadDoesNotDisableIdentity() {
        assertThrows(IllegalArgumentException.class, () -> new DirectoryIdentity(null));
        var identity = new DirectoryIdentity(temporary.resolve("close"));
        try (identity) {
            assertThrows(IllegalArgumentException.class, () -> identity.sign(null));
            assertThat(identity.sign(new byte[0])).hasSize(86);
        }
        identity.close();
        assertThrows(StorageException.class, identity::publicKey);
        assertThrows(StorageException.class, identity::id);
        assertThrows(StorageException.class, () -> identity.sign(new byte[0]));
    }

    @ParameterizedTest @ValueSource(booleans = {false, true})
    void preInterruptedConstructorCompletesAndPreservesDurableIdentity(boolean existing) throws Exception {
        Path directory = existing ? initialized("interrupted-open") : temporary.resolve("interrupted-open");
        Map<String, byte[]> before = existing ? snapshot(directory) : null;
        StorageException failure = null;
        String expected = null;
        Thread.currentThread().interrupt();
        try (var identity = new DirectoryIdentity(directory)) {
            expected = identity.publicKey();
            assertThat(Thread.currentThread().isInterrupted()).isTrue();
        } catch (StorageException caught) {
            failure = caught;
        } finally {
            assertThat(Thread.interrupted()).as("constructor and close preserve interruption").isTrue();
        }
        assertThat(Files.exists(data(directory))).as("cancellation must not leave only an initialization marker").isTrue();
        assertThat(failure).isNull();
        assertOnlyFinalFiles(directory);
        if (existing) assertSnapshot(directory, before);
        try (var reopened = new DirectoryIdentity(directory)) {
            assertThat(reopened.publicKey()).isEqualTo(expected);
            assertThat(verify(decodePublic(expected), new byte[0], reopened.sign(new byte[0]))).isTrue();
        }
    }

    @ParameterizedTest @ValueSource(strings = {"sign", "id", "publicKey"})
    void preInterruptedCallsPreserveFlagAndDoNotPoisonIdentity(String operation) throws Exception {
        Path directory = temporary.resolve("interrupted-call");
        try (var identity = new DirectoryIdentity(directory)) {
            String expected = invoke(identity, operation);
            byte[] before = Files.readAllBytes(data(directory));
            StorageException failure = null;
            String result = null;
            Thread.currentThread().interrupt();
            try {
                result = invoke(identity, operation);
            } catch (StorageException caught) {
                failure = caught;
            } finally {
                assertThat(Thread.interrupted()).as("caller interrupt flag").isTrue();
            }
            StorageException caught = failure;
            String actual = result;
            assertAll(
                    () -> assertThat(caught).as("routine cancellation is not a storage failure").isNull(),
                    () -> assertThat(actual).isEqualTo(expected),
                    () -> assertThat(invoke(identity, operation)).as("identity remains usable").isEqualTo(expected));
            assertThat(Files.readAllBytes(data(directory))).isEqualTo(before);
            assertThrows(StorageException.class, () -> new DirectoryIdentity(directory.resolve(".")));
            assertThat(runProbe(new ProcessBuilder(javaCommand(), "-XX:-UsePerfData", "-cp", classPath(),
                    LockProbe.class.getName(), directory.toString()))).isEqualTo("DENIED");
        }
    }

    private static String invoke(DirectoryIdentity identity, String operation) {
        return switch (operation) {
            case "sign" -> identity.sign(new byte[] { 0, -1, 1 });
            case "id" -> identity.id();
            case "publicKey" -> identity.publicKey();
            default -> throw new AssertionError(operation);
        };
    }

    @ParameterizedTest @ValueSource(strings = {"marker-force", "directory-force", "parent-force", "write", "file-force",
            "commit-force", "read"})
    void interruptionDuringInitializationCompletesDurablyAndKeepsLock(String boundary) throws Exception {
        Path directory = temporary.resolve("interrupted-initialization");
        var io = new GatedFileSystem(directory);
        IoGate gate = io.arm((path, method) -> switch (boundary) {
            case "marker-force" -> path.equals(lock(directory)) && method.equals("force");
            case "directory-force", "commit-force" -> path.equals(directory) && method.equals("force");
            case "parent-force" -> path.equals(temporary) && method.equals("force");
            case "write", "file-force" -> path.getFileName().toString().endsWith(".tmp")
                    && method.equals(boundary.equals("write") ? "write" : "force");
            case "read" -> path.equals(data(directory)) && method.equals("read");
            default -> throw new AssertionError(boundary);
        }, boundary.equals("commit-force") ? 2 : 1);
        var opening = new FutureTask<>(() -> {
            DirectoryIdentity identity = new DirectoryIdentity(io.path());
            try {
                assertThat(Thread.currentThread().isInterrupted()).isTrue();
                return identity;
            } catch (Throwable failure) {
                identity.close();
                throw failure;
            }
        });
        Thread caller = Thread.ofPlatform().name("identity-open-caller").start(opening);
        try {
            gate.awaitEntry();
            assertThat(Files.exists(lock(directory))).isTrue();
            caller.interrupt();
            assertThat(caller.isAlive()).as("open must await its durable outcome").isTrue();
        } finally {
            gate.release.countDown();
            joinCaller(caller);
        }
        try (var identity = opening.get(1, TimeUnit.SECONDS)) {
            assertThat(gate.ioThread.isAlive()).as("operation worker terminated before return").isFalse();
            assertOnlyFinalFiles(directory);
            byte[] before = Files.readAllBytes(data(directory));
            String expected = identity.publicKey();
            assertThat(verify(decodePublic(expected), new byte[0], identity.sign(new byte[0]))).isTrue();
            assertThrows(StorageException.class, () -> new DirectoryIdentity(io.path().resolve(".")));
            assertThat(runProbe(new ProcessBuilder(javaCommand(), "-XX:-UsePerfData", "-cp", classPath(),
                    LockProbe.class.getName(), directory.toString()))).isEqualTo("DENIED");
            identity.close();
            try (var reopened = new DirectoryIdentity(directory)) {
                assertThat(reopened.publicKey()).isEqualTo(expected);
                assertThat(Files.readAllBytes(data(directory))).isEqualTo(before);
            }
        }
    }

    @ParameterizedTest @ValueSource(strings = {"sign", "sign-after", "id", "publicKey"})
    void interruptionDuringValidationDoesNotDisableIdentityOrReleaseLock(String operation) throws Exception {
        Path directory = temporary.resolve("interrupted-validation");
        var io = new GatedFileSystem(directory);
        String call = operation.equals("sign-after") ? "sign" : operation;
        try (var identity = new DirectoryIdentity(io.path())) {
            byte[] before = Files.readAllBytes(data(directory));
            String expected = invoke(identity, call);
            IoGate gate = io.arm((path, method) -> path.equals(data(directory))
                    && method.equals(operation.equals("sign-after") ? "size" : "read"),
                    operation.equals("sign-after") ? 2 : 1);
            var result = new FutureTask<>(() -> {
                String value = invoke(identity, call);
                assertThat(Thread.currentThread().isInterrupted()).isTrue();
                return value;
            });
            Thread caller = Thread.ofPlatform().name("identity-call-caller").start(result);
            try {
                gate.awaitEntry();
                caller.interrupt();
                caller.interrupt();
            } finally {
                gate.release.countDown();
                joinCaller(caller);
            }
            assertThat(result.get(1, TimeUnit.SECONDS)).isEqualTo(expected);
            assertThat(gate.ioThread.isAlive()).isFalse();
            assertThat(invoke(identity, call)).isEqualTo(expected);
            assertThat(Files.readAllBytes(data(directory))).isEqualTo(before);
            assertThrows(StorageException.class, () -> new DirectoryIdentity(io.path().resolve(".")));
            assertThat(runProbe(new ProcessBuilder(javaCommand(), "-XX:-UsePerfData", "-cp", classPath(),
                    LockProbe.class.getName(), directory.toString()))).isEqualTo("DENIED");
        }
        try (var reopened = new DirectoryIdentity(directory)) {
            assertThat(reopened.sign(new byte[0])).hasSize(86);
        }
    }

    @Test
    void interruptedCloseWaitsForInFlightValidationBeforeReleasingOwnership() throws Exception {
        Path directory = temporary.resolve("interrupted-stop");
        var io = new GatedFileSystem(directory);
        try (var identity = new DirectoryIdentity(io.path())) {
            String expected = identity.id();
            IoGate gate = io.arm((path, method) -> path.equals(data(directory)) && method.equals("read"), 1);
            var signing = new FutureTask<>(() -> identity.sign(new byte[0]));
            Thread caller = Thread.ofPlatform().name("identity-sign-caller").start(signing);
            var closingStarted = new CountDownLatch(1);
            var closing = new FutureTask<>(() -> {
                Thread.currentThread().interrupt();
                closingStarted.countDown();
                identity.close();
                assertThat(Thread.currentThread().isInterrupted()).isTrue();
                return null;
            });
            Thread closer = Thread.ofPlatform().name("identity-close-caller").unstarted(closing);
            try {
                gate.awaitEntry();
                caller.interrupt();
                closer.start();
                assertThat(closingStarted.await(10, TimeUnit.SECONDS)).isTrue();
                assertThat(closing.isDone()).as("close waits for the active operation").isFalse();
                assertThat(runProbe(new ProcessBuilder(javaCommand(), "-XX:-UsePerfData", "-cp", classPath(),
                        LockProbe.class.getName(), directory.toString()))).isEqualTo("DENIED");
            } finally {
                gate.release.countDown();
                joinCaller(caller);
                joinCaller(closer);
            }
            assertThat(signing.get(1, TimeUnit.SECONDS)).hasSize(86);
            closing.get(1, TimeUnit.SECONDS);
            assertThrows(StorageException.class, identity::id);
            try (var reopened = new DirectoryIdentity(directory)) {
                assertThat(reopened.id()).isEqualTo(expected);
            }
        }
    }

    @ParameterizedTest @ValueSource(strings = {"corrupt", "unsafe", "oversized"})
    void interruptionDoesNotSuppressStorageFailureOrRestorePoisonedIdentity(String change) throws Exception {
        Path directory = temporary.resolve("interrupted-tamper");
        try (var identity = new DirectoryIdentity(directory)) {
            byte[] before = Files.readAllBytes(data(directory));
            String expected = identity.publicKey();
            switch (change) {
                case "corrupt" -> Files.writeString(data(directory), "{}");
                case "unsafe" -> Files.setPosixFilePermissions(data(directory), PosixFilePermissions.fromString("rw-r-----"));
                case "oversized" -> Files.writeString(data(directory), " ".repeat(2049));
                default -> throw new AssertionError(change);
            }
            Thread.currentThread().interrupt();
            try {
                assertSanitized(assertThrows(StorageException.class, () -> identity.sign(new byte[0])), directory);
            } finally {
                boolean interrupted = Thread.interrupted();
                Files.setPosixFilePermissions(data(directory), PosixFilePermissions.fromString("rw-------"));
                Files.write(data(directory), before);
                assertThat(interrupted).isTrue();
            }
            assertThrows(StorageException.class, identity::id);
            assertThrows(StorageException.class, identity::publicKey);
            assertThrows(StorageException.class, () -> identity.sign(new byte[0]));
            identity.close();
            try (var reopened = new DirectoryIdentity(directory)) {
                assertThat(reopened.publicKey()).isEqualTo(expected);
            }
        }
    }

    @ParameterizedTest @ValueSource(strings = {"rwxr-xr-x", "rwxrwx---", "r-x------"})
    void rejectsUnsafeDirectoryAndParentPermissionsWithoutChangingThem(String mode) throws Exception {
        Path directory = privateDirectory(temporary.resolve("unsafe"));
        Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString(mode));
        try {
            assertSanitized(assertThrows(StorageException.class, () -> new DirectoryIdentity(directory)), directory);
            assertMode(directory, mode);
            assertThrows(StorageException.class, () -> new DirectoryIdentity(directory.resolve("new")));
            assertMode(directory, mode);
            assertThat(Files.exists(directory.resolve("new"))).isFalse();
        } finally { Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------")); }
    }

    @ParameterizedTest @ValueSource(strings = {"data", "lock", "directory", "parent", "ancestor", "hardlink"})
    void rejectsSymlinksAndHardlinksWithoutFollowingOrRepairingThem(String kind) throws Exception {
        Path directory = initialized("links");
        Path opened = directory;
        switch (kind) {
            case "data", "lock" -> {
                Path file = kind.equals("data") ? data(directory) : lock(directory);
                Path target = temporary.resolve("target");
                Files.move(file, target);
                Files.createSymbolicLink(file, target);
            }
            case "directory" -> {
                Path target = temporary.resolve("target");
                Files.move(directory, target);
                Files.createSymbolicLink(directory, target);
            }
            case "parent", "ancestor" -> {
                Path alias = temporary.resolve("alias");
                Files.createSymbolicLink(alias, temporary);
                if (kind.equals("parent")) opened = alias.resolve("links");
                else {
                    privateDirectory(temporary.resolve("nested"));
                    opened = alias.resolve("nested/identity");
                }
            }
            case "hardlink" -> Files.createLink(temporary.resolve("alias"), data(directory));
            default -> throw new AssertionError(kind);
        }
        Path requested = opened;
        assertSanitized(assertThrows(StorageException.class, () -> new DirectoryIdentity(requested)), directory);
        assertSanitized(assertThrows(StorageException.class, () -> new DirectoryIdentity(requested)), directory);
    }

    @ParameterizedTest @ValueSource(strings = {"identity.json", "identity.lock"})
    void rejectsUnsafeFilePermissionsWithoutRepair(String name) throws Exception {
        Path directory = initialized("file-mode");
        Path file = directory.resolve(name);
        Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-r-----"));
        byte[] bytes = Files.readAllBytes(file);
        assertThrows(StorageException.class, () -> new DirectoryIdentity(directory));
        assertMode(file, "rw-r-----");
        assertThat(Files.readAllBytes(file)).isEqualTo(bytes);
    }

    @ParameterizedTest @ValueSource(strings = {"directory", "data", "lock"})
    void rejectsSpecialPermissionBits(String kind) throws Exception {
        Path directory = initialized("special-bits");
        Path path = kind.equals("directory") ? directory : kind.equals("data") ? data(directory) : lock(directory);
        int mode = (Integer) Files.getAttribute(path, "unix:mode");
        Files.setAttribute(path, "unix:mode", mode | 01000);
        try {
            assertThrows(StorageException.class, () -> new DirectoryIdentity(directory));
            assertThat((Integer) Files.getAttribute(path, "unix:mode") & 01000).isNotZero();
        } finally { Files.setAttribute(path, "unix:mode", mode); }
    }

    @Test
    void rejectsMissingParentNonPosixFilesystemAndRegularFileDirectory() throws Exception {
        Path missing = temporary.resolve("missing");
        assertThrows(StorageException.class, () -> new DirectoryIdentity(missing.resolve("identity")));
        assertThat(Files.exists(missing)).isFalse();
        Path file = temporary.resolve("file");
        privateFile(file, "untouched");
        assertThrows(StorageException.class, () -> new DirectoryIdentity(file));
        assertThat(Files.readString(file)).isEqualTo("untouched");
        try (var zip = FileSystems.newFileSystem(temporary.resolve("fixture.zip"), Map.of("create", "true"))) {
            assertSanitized(assertThrows(StorageException.class,
                    () -> new DirectoryIdentity(zip.getPath("/identity"))), zip.getPath("/identity"));
        }
    }

    @ParameterizedTest @ValueSource(strings = {"missing-data", "missing-lock", "nonempty-lock", "unknown",
            "stale-temp", "data-directory", "oversized"})
    void incompleteOrUnexpectedStorageNeverRegeneratesOrCleansExistingFiles(String change) throws Exception {
        Path directory = initialized("incomplete");
        switch (change) {
            case "missing-data" -> Files.delete(data(directory));
            case "missing-lock" -> Files.delete(lock(directory));
            case "nonempty-lock" -> Files.writeString(lock(directory), "unexpected");
            case "unknown" -> privateFile(directory.resolve("unknown"), "untouched");
            case "stale-temp" -> privateFile(directory.resolve(".identity-crash.tmp"), "partial");
            case "data-directory" -> {
                Files.delete(data(directory));
                privateDirectory(data(directory));
            }
            case "oversized" -> Files.writeString(data(directory), " ".repeat(2049));
            default -> throw new AssertionError(change);
        }
        Map<String, byte[]> before = snapshot(directory);
        for (int attempt = 0; attempt < 2; attempt++) {
            assertSanitized(assertThrows(StorageException.class, () -> new DirectoryIdentity(directory)), directory);
            assertSnapshot(directory, before);
        }
    }

    @ParameterizedTest @ValueSource(strings = {"truncated", "empty", "null", "array", "duplicate", "trailing",
            "unknown-field", "missing-field", "wrong-version", "float-version", "string-version",
            "null-key", "numeric-key", "padded-public", "padded-private", "padding-bits", "base64-alphabet",
            "public-whitespace", "short-public", "private-seed", "public-der-tail", "private-der-tail",
            "public-null-parameters", "private-null-parameters", "public-ber-length", "private-ber-length",
            "wrong-algorithm", "mismatched-pair", "corrupt-private", "invalid-point", "long-string", "deep"})
    void rejectsCorruptOrNoncanonicalIdentityWithoutRewritingAndReleasesFailedOpenLock(String change) throws Exception {
        Path directory = initialized("corrupt");
        byte[] valid = Files.readAllBytes(data(directory));
        String expectedPublic = JSON.readTree(valid).get("publicKey").stringValue();
        String expectedPrivate = JSON.readTree(valid).get("privateKey").stringValue();
        ObjectNode root = (ObjectNode) JSON.readTree(valid);
        String document = switch (change) {
            case "truncated" -> "{";
            case "empty" -> "";
            case "null" -> "null";
            case "array" -> "[]";
            case "duplicate" -> JSON.writeValueAsString(root).replace("\"version\":1", "\"version\":1,\"version\":1");
            case "trailing" -> JSON.writeValueAsString(root) + " {}";
            case "deep" -> "{\"version\":1,\"publicKey\":[[[[[]]]]],\"privateKey\":null}";
            default -> {
                switch (change) {
                    case "unknown-field" -> root.put("extra", true);
                    case "missing-field" -> root.remove("privateKey");
                    case "wrong-version" -> root.put("version", 2);
                    case "float-version" -> root.put("version", 1.0);
                    case "string-version" -> root.put("version", "1");
                    case "null-key" -> root.putNull("privateKey");
                    case "numeric-key" -> root.put("publicKey", 123);
                    case "padded-public" -> root.put("publicKey", root.get("publicKey").stringValue() + "=");
                    case "padded-private" -> root.put("privateKey", root.get("privateKey").stringValue() + "=");
                    case "padding-bits" -> {
                        String value = root.get("publicKey").stringValue();
                        String alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
                        root.put("publicKey", value.substring(0, value.length() - 1)
                                + alphabet.charAt(alphabet.indexOf(value.charAt(value.length() - 1)) + 1));
                    }
                    case "base64-alphabet" -> root.put("privateKey", "/" + root.get("privateKey").stringValue().substring(1));
                    case "public-whitespace" -> root.put("publicKey", " " + root.get("publicKey").stringValue());
                    case "short-public" -> root.put("publicKey", BASE64.encodeToString(new byte[32]));
                    case "private-seed" -> root.put("privateKey", BASE64.encodeToString(new byte[32]));
                    case "public-der-tail", "private-der-tail" -> mutateKey(root,
                            change.startsWith("public") ? "publicKey" : "privateKey", bytes ->
                                    Arrays.copyOf(bytes, bytes.length + 1));
                    case "public-null-parameters" -> replacePrefix(root, "publicKey", 12, "302c300706032b65700500032100");
                    case "private-null-parameters" -> replacePrefix(root, "privateKey", 16, "3030020100300706032b6570050004220420");
                    case "public-ber-length" -> replacePrefix(root, "publicKey", 12, "30812a300506032b6570032100");
                    case "private-ber-length" -> replacePrefix(root, "privateKey", 16, "30812e020100300506032b657004220420");
                    case "wrong-algorithm" -> mutateKey(root, "publicKey", bytes -> { bytes[8] = 0x6e; return bytes; });
                    case "mismatched-pair" -> root.put("publicKey", BASE64.encodeToString(
                            KeyPairGenerator.getInstance("Ed25519").generateKeyPair().getPublic().getEncoded()));
                    case "corrupt-private" -> mutateKey(root, "privateKey", bytes -> { bytes[47] ^= 1; return bytes; });
                    case "invalid-point" -> mutateKey(root, "publicKey", bytes -> { Arrays.fill(bytes, 12, 44, (byte) 0xff); return bytes; });
                    case "long-string" -> root.put("privateKey", "a".repeat(129));
                    default -> throw new AssertionError(change);
                }
                yield JSON.writeValueAsString(root);
            }
        };
        Files.writeString(data(directory), document);
        for (int attempt = 0; attempt < 2; attempt++) {
            StorageException failure = assertThrows(StorageException.class, () -> new DirectoryIdentity(directory));
            assertSanitized(failure, directory);
            assertThat(failure.getMessage()).doesNotContain(expectedPublic, expectedPrivate);
            assertThat(Files.readString(data(directory))).isEqualTo(document);
            assertOnlyFinalFiles(directory);
        }
        // Only this fixture restores bytes; failed constructors must have released every claim/lock.
        Files.write(data(directory), valid);
        try (var reopened = new DirectoryIdentity(directory)) {
            assertThat(reopened.publicKey()).isEqualTo(expectedPublic);
        }
    }

    @ParameterizedTest @ValueSource(strings = {"data-bytes", "data-replaced", "lock-replaced", "data-mode",
            "lock-mode", "directory-mode", "parent-mode", "lock-bytes", "unknown-file"})
    void storageChangesPermanentlyDisableSigningEvenAfterFixtureRestoresStorage(String change) throws Exception {
        Path directory = temporary.resolve("tampered");
        try (var identity = new DirectoryIdentity(directory)) {
            String expected = identity.publicKey();
            byte[] bytes = Files.readAllBytes(data(directory));
            Path target = switch (change) {
                case "lock-replaced", "lock-mode", "lock-bytes" -> lock(directory);
                case "directory-mode" -> directory;
                case "parent-mode" -> temporary;
                case "unknown-file" -> directory.resolve("unknown");
                default -> data(directory);
            };
            Path saved = temporary.resolve("saved");
            switch (change) {
                case "data-bytes" -> Files.writeString(target, "{}");
                case "lock-bytes" -> Files.writeString(target, "changed");
                case "data-replaced", "lock-replaced" -> {
                    Files.move(target, saved);
                    privateFile(target, change.equals("data-replaced") ? new String(bytes, StandardCharsets.UTF_8) : "");
                }
                case "unknown-file" -> privateFile(target, "unexpected");
                default -> Files.setPosixFilePermissions(target, PosixFilePermissions.fromString("rwxr-x---"));
            }
            try {
                assertSanitized(assertThrows(StorageException.class, () -> identity.sign(new byte[] { 1 })), directory);
            } finally {
                switch (change) {
                    case "data-bytes" -> Files.write(target, bytes);
                    case "lock-bytes" -> Files.writeString(target, "");
                    case "data-replaced", "lock-replaced" -> { Files.delete(target); Files.move(saved, target); }
                    case "unknown-file" -> Files.delete(target);
                    default -> Files.setPosixFilePermissions(target, PosixFilePermissions.fromString(
                            Files.isDirectory(target) ? "rwx------" : "rw-------"));
                }
            }
            assertThrows(StorageException.class, () -> identity.sign(new byte[] { 1 }));
            assertThrows(StorageException.class, identity::publicKey);
            assertThrows(StorageException.class, identity::id);
            identity.close();
            try (var reopened = new DirectoryIdentity(directory)) {
                assertThat(reopened.publicKey()).isEqualTo(expected);
            }
        }
    }

    @ParameterizedTest @ValueSource(booleans = {false, true})
    void actualInitializationWriteErrorLeavesOnlyMarkerAndNeverRegeneratesOnRetry(boolean interrupted) throws Exception {
        Path directory = temporary.resolve("write-failure");
        // RLIMIT_FSIZE is child-only; ignored SIGXFSZ makes FileChannel.write fail with EFBIG.
        // No returned instance can sign, so initialization failure needs no mutable write API.
        assertThat(runProbe(new ProcessBuilder("/bin/bash", "-c", "trap '' XFSZ; ulimit -f 0; exec \"$@\"",
                "identity-write-failure", javaCommand(), "-XX:-UsePerfData", "-cp", classPath(),
                WriteFailureProbe.class.getName(), directory.toString(), Boolean.toString(interrupted)))).isEqualTo("FAILED_CLOSED");
        try (var files = Files.list(directory)) {
            assertThat(files.map(path -> path.getFileName().toString()).toList()).containsExactly("identity.lock");
        }
        assertMode(directory, "rwx------");
        assertMode(lock(directory), "rw-------");
        for (int attempt = 0; attempt < 2; attempt++) {
            assertThrows(StorageException.class, () -> new DirectoryIdentity(directory));
            assertThat(Files.exists(data(directory))).isFalse();
        }
        try (var channel = java.nio.channels.FileChannel.open(lock(directory), java.nio.file.StandardOpenOption.WRITE);
             var held = channel.tryLock()) {
            assertThat(held).isNotNull();
        }
    }

    @Test
    void replacementDirectoryDisablesSigningEvenWithIdenticalKeyBytes() throws Exception {
        Path directory = temporary.resolve("replaced-directory");
        Path saved = temporary.resolve("original-directory");
        try (var identity = new DirectoryIdentity(directory)) {
            byte[] bytes = Files.readAllBytes(data(directory));
            Files.move(directory, saved);
            privateDirectory(directory);
            privateFile(data(directory), new String(bytes, StandardCharsets.UTF_8));
            privateFile(lock(directory), "");
            try {
                assertThrows(StorageException.class, () -> identity.sign(new byte[0]));
            } finally {
                Files.delete(data(directory));
                Files.delete(lock(directory));
                Files.delete(directory);
                Files.move(saved, directory);
            }
            assertThrows(StorageException.class, () -> identity.sign(new byte[0]));
        }
    }

    private Path initialized(String name) {
        Path directory = temporary.resolve(name);
        try (var ignored = new DirectoryIdentity(directory)) { return directory; }
    }

    private static Path data(Path directory) { return directory.resolve("identity.json"); }
    private static Path lock(Path directory) { return directory.resolve("identity.lock"); }

    private static Path privateDirectory(Path path) throws Exception {
        return Files.createDirectory(path, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
    }

    private static void privateFile(Path path, String value) throws Exception {
        Files.createFile(path, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
        Files.writeString(path, value);
    }

    private static PublicKey decodePublic(String encoded) throws Exception {
        return KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(Base64.getUrlDecoder().decode(encoded)));
    }

    private static boolean verify(PublicKey key, byte[] bytes, String encodedSignature) throws Exception {
        Signature verifier = Signature.getInstance("Ed25519");
        verifier.initVerify(key);
        verifier.update(bytes);
        return verifier.verify(Base64.getUrlDecoder().decode(encodedSignature));
    }

    private static void mutateKey(ObjectNode root, String field, java.util.function.UnaryOperator<byte[]> mutation) {
        root.put(field, BASE64.encodeToString(mutation.apply(Base64.getUrlDecoder().decode(root.get(field).stringValue()))));
    }

    private static void replacePrefix(ObjectNode root, String field, int prefixLength, String hex) {
        mutateKey(root, field, bytes -> {
            byte[] prefix = HexFormat.of().parseHex(hex);
            byte[] changed = Arrays.copyOf(prefix, prefix.length + bytes.length - prefixLength);
            System.arraycopy(bytes, prefixLength, changed, prefix.length, bytes.length - prefixLength);
            return changed;
        });
    }

    private static void assertMode(Path path, String mode) throws Exception {
        assertThat(Files.getPosixFilePermissions(path)).isEqualTo(PosixFilePermissions.fromString(mode));
    }

    private static void assertOnlyFinalFiles(Path directory) throws Exception {
        try (var files = Files.list(directory)) {
            assertThat(files.map(path -> path.getFileName().toString()).toList())
                    .containsExactlyInAnyOrder("identity.json", "identity.lock");
        }
    }

    private static Map<String, byte[]> snapshot(Path directory) throws Exception {
        Map<String, byte[]> result = new java.util.HashMap<>();
        try (var paths = Files.list(directory)) {
            for (Path path : paths.toList()) {
                result.put(path.getFileName().toString(), Files.isDirectory(path) ? null : Files.readAllBytes(path));
            }
        }
        return result;
    }

    private static void assertSnapshot(Path directory, Map<String, byte[]> expected) throws Exception {
        Map<String, byte[]> actual = snapshot(directory);
        assertThat(actual.keySet()).isEqualTo(expected.keySet());
        for (String name : expected.keySet()) assertThat(actual.get(name)).isEqualTo(expected.get(name));
    }

    private static void assertSanitized(StorageException failure, Path directory) {
        assertThat(failure.getMessage()).doesNotContain(directory.toString());
        assertThat(failure.getCause()).isNull();
        assertThat(failure.getSuppressed()).isEmpty();
    }

    private static String javaCommand() { return Path.of(System.getProperty("java.home"), "bin", "java").toString(); }
    private static String classPath() { return System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")); }

    private static void joinCaller(Thread caller) throws Exception {
        caller.join(TimeUnit.SECONDS.toMillis(15));
        if (caller.isAlive()) {
            caller.interrupt();
            caller.join(TimeUnit.SECONDS.toMillis(5));
        }
        assertThat(caller.isAlive()).as("test caller %s terminated", caller.threadId()).isFalse();
    }

    // Gate real FileChannel operations through a delegating filesystem, without a production
    // test hook or simulated I/O outcome. All path checks, reads, writes, fsyncs and locks still
    // reach the local POSIX provider with the original options (including NOFOLLOW_LINKS).
    private static final class GatedFileSystem {
        private final Path directory;
        private final FileSystem fileSystem;
        private volatile IoGate gate;

        GatedFileSystem(Path directory) {
            this.directory = directory;
            FileSystem delegate = directory.getFileSystem();
            FileSystemProvider provider = mock(FileSystemProvider.class, invocation -> {
                Object[] arguments = invocation.getRawArguments();
                Object result = invokeReal(invocation.getMethod(), delegate.provider(), arguments);
                if (result instanceof FileChannel channel) {
                    Path path = unwrap((Path) arguments[0]);
                    return mock(FileChannel.class, call -> {
                        IoGate current = gate;
                        if (current != null) current.before(path, call.getMethod().getName());
                        return invokeReal(call.getMethod(), channel, call.getRawArguments());
                    });
                }
                return result;
            });
            fileSystem = mock(FileSystem.class, delegatesTo(delegate));
            doReturn(provider).when(fileSystem).provider();
        }

        Path path() { return wrap(directory, fileSystem); }

        IoGate arm(BiPredicate<Path, String> boundary, int occurrence) {
            IoGate next = new IoGate(boundary, occurrence);
            gate = next;
            return next;
        }
    }

    private record DelegatingPath(Path delegate, FileSystem fileSystem) implements InvocationHandler {
        @Override public Object invoke(Object proxy, Method method, Object[] arguments) throws Throwable {
            if (method.getName().equals("getFileSystem")) return fileSystem;
            Object result = invokeReal(method, delegate, arguments);
            return result instanceof Path path ? wrap(path, fileSystem) : result;
        }
    }

    private static Path wrap(Path path, FileSystem fileSystem) {
        return (Path) Proxy.newProxyInstance(Path.class.getClassLoader(), new Class<?>[] { Path.class },
                new DelegatingPath(path, fileSystem));
    }

    private static Path unwrap(Path path) {
        return Proxy.isProxyClass(path.getClass()) && Proxy.getInvocationHandler(path) instanceof DelegatingPath wrapped
                ? wrapped.delegate() : path;
    }

    private static Object invokeReal(Method method, Object target, Object[] arguments) throws Throwable {
        Object[] nativeArguments = arguments == null ? null : arguments.clone();
        if (nativeArguments != null) {
            for (int i = 0; i < nativeArguments.length; i++) {
                if (nativeArguments[i] instanceof Path path) nativeArguments[i] = unwrap(path);
            }
        }
        try {
            return method.invoke(target, nativeArguments);
        } catch (InvocationTargetException failure) {
            throw failure.getCause();
        }
    }

    private static final class IoGate {
        private final BiPredicate<Path, String> boundary;
        private final AtomicInteger remaining;
        private final CountDownLatch entered = new CountDownLatch(1);
        private final CountDownLatch release = new CountDownLatch(1);
        private volatile Thread ioThread;

        IoGate(BiPredicate<Path, String> boundary, int occurrence) {
            this.boundary = boundary;
            remaining = new AtomicInteger(occurrence);
        }

        void awaitEntry() throws Exception {
            assertThat(entered.await(10, TimeUnit.SECONDS)).as("reached real channel I/O boundary").isTrue();
        }

        void before(Path path, String method) {
            if (!boundary.test(path, method) || remaining.decrementAndGet() != 0) return;
            ioThread = Thread.currentThread();
            entered.countDown();
            boolean interrupted = false;
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
            try {
                for (;;) {
                    try {
                        assertThat(release.await(Math.max(0, deadline - System.nanoTime()), TimeUnit.NANOSECONDS))
                                .as("test released the channel I/O gate").isTrue();
                        return;
                    } catch (InterruptedException cancellation) {
                        interrupted = true;
                    }
                }
            } finally {
                // On the broken implementation this restores cancellation just before the real
                // channel call, reproducing ClosedByInterruptException deterministically.
                if (interrupted) Thread.currentThread().interrupt();
            }
        }
    }

    private static String runProbe(ProcessBuilder builder) throws Exception {
        Process process = builder.redirectErrorStream(true).start();
        long pid = process.pid();
        try {
            process.getOutputStream().close();
            assertThat(process.waitFor(15, TimeUnit.SECONDS)).as("probe PID %s finished", pid).isTrue();
            String output = new String(process.getInputStream().readNBytes(4096), StandardCharsets.UTF_8);
            assertThat(process.exitValue()).as("probe output: %s", output).isZero();
            return output;
        } finally {
            if (process.isAlive()) process.destroyForcibly();
            assertThat(process.waitFor(10, TimeUnit.SECONDS)).as("probe PID %s cleaned up", pid).isTrue();
            assertThat(process.isAlive()).isFalse();
            process.getInputStream().close();
            process.getErrorStream().close();
        }
    }

    public static final class LockProbe {
        public static void main(String[] args) {
            try (var identity = new DirectoryIdentity(Path.of(args[0]))) {
                System.out.print(identity.id());
            } catch (StorageException denied) { System.out.print("DENIED"); }
        }
    }

    public static final class WriteFailureProbe {
        public static void main(String[] args) {
            boolean interrupted = Boolean.parseBoolean(args[1]);
            if (interrupted) Thread.currentThread().interrupt();
            try (var ignored = new DirectoryIdentity(Path.of(args[0]))) {
                throw new AssertionError("An initialization write failure must never return an identity.");
            } catch (StorageException expected) {
                if (expected.getCause() != null || expected.getSuppressed().length != 0) {
                    throw new AssertionError("Expected sanitized initialization failure.");
                }
            }
            if (Thread.currentThread().isInterrupted() != interrupted) {
                throw new AssertionError("Initialization failure must preserve caller interrupt status.");
            }
            System.out.print("FAILED_CLOSED");
        }
    }
}
