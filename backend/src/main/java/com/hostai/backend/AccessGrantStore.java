package com.hostai.backend;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.FileSystem;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFileAttributes;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.nio.file.attribute.UserPrincipal;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Comparator;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;
import tools.jackson.core.StreamReadConstraints;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Explicitly opened, exclusively locked grant storage; no application lifecycle or default path.
 * The dedicated directory's parent must already exist. Existing permissions are checked, never
 * repaired. POSIX ownership, stable file identities, atomic replacement and directory fsync are
 * required; unsupported filesystems fail closed. The directory and its ancestors must not be links.
 *
 * <p>All operations are serialized. Authentication reads only the committed in-memory snapshot;
 * external file edits are not a revocation interface. A failed commit has an uncertain disk outcome
 * and permanently poisons this instance. Callers must stop serving on {@link StorageException};
 * reopening storage does not authorize restarting a listener.
 */
public final class AccessGrantStore implements AutoCloseable {
    private static final int MAX_GRANTS = 100;
    private static final int MAX_BYTES = 128 * 1024;
    private static final Duration MIN_LIFETIME = Duration.ofMinutes(1);
    private static final Duration MAX_LIFETIME = Duration.ofDays(7);
    private static final Set<PosixFilePermission> DIRECTORY_MODE = PosixFilePermissions.fromString("rwx------");
    private static final Set<PosixFilePermission> FILE_MODE = PosixFilePermissions.fromString("rw-------");
    private static final String UUID_SYNTAX = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    private static final Pattern ID = Pattern.compile(UUID_SYNTAX);
    private static final Pattern TOKEN = Pattern.compile("hga1\\.(" + UUID_SYNTAX + ")\\.([A-Za-z0-9_-]{43})");
    private static final Pattern HASH = Pattern.compile("[0-9a-f]{64}");
    private static final Pattern TEMP = Pattern.compile("\\.grants-[A-Za-z0-9-]{1,64}\\.tmp");
    private static final Set<String> LEGACY_ROW_FIELDS = Set.of(
            "id", "label", "model", "createdAt", "expiresAt", "revokedAt", "hash");
    private static final Set<String> ROW_FIELDS = Set.of(
            "id", "label", "model", "createdAt", "expiresAt", "revokedAt", "hash", "channel");
    // Some POSIX systems release a process's locks when ANY descriptor for that file closes.
    // Reject duplicate JVM opens before opening a second descriptor for the lock file.
    private static final Set<DirectoryIdentity> OPEN_DIRECTORIES = ConcurrentHashMap.newKeySet();
    private static final JsonMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .streamReadConstraints(StreamReadConstraints.builder().maxDocumentLength(MAX_BYTES)
                    .maxNestingDepth(4).maxStringLength(1024).maxNameLength(32)
                    .maxNumberLength(10).maxTokenCount(4096).build()).build())
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();

    private final Path directory;
    private final Path dataPath;
    private final Path lockPath;
    private final Clock clock;
    private final UserPrincipal owner;
    private final SecureRandom random = new SecureRandom();
    private FileChannel directoryChannel;
    private FileChannel lockChannel;
    private FileLock lock;
    private Object directoryKey;
    private Object lockKey;
    private Object dataKey;
    private DirectoryIdentity claimedDirectory;
    private List<StoredGrant> records = List.of();
    private boolean poisoned;
    private boolean closed;

    public record Grant(UUID id, String label, String model, Instant createdAt,
                        Instant expiresAt, Instant revokedAt, String channel) {
        public Grant {
            validateChannel(channel);
        }

        public Grant(UUID id, String label, String model, Instant createdAt,
                     Instant expiresAt, Instant revokedAt) {
            this(id, label, model, createdAt, expiresAt, revokedAt, "local");
        }
    }

    /** The bearer credential is available only on the result of a successful create. */
    public record IssuedGrant(Grant grant, String token) {
        @Override public String toString() {
            return "IssuedGrant[grant=" + grant + ", token=[REDACTED]]";
        }
    }

    /** Deliberately contains no filesystem paths, input data, token, hash, or underlying cause. */
    public static final class StorageException extends IllegalStateException {
        private StorageException(String message) { super(message); }
    }

    private static final class StoredGrant {
        private final Grant grant;
        private final byte[] hash;

        private StoredGrant(Grant grant, byte[] hash) {
            this.grant = grant;
            this.hash = hash;
        }
    }

    private record DirectoryIdentity(FileSystem fileSystem, Object fileKey) {}

    private AccessGrantStore(Path directory, Clock clock, UserPrincipal owner) {
        this.directory = directory;
        this.dataPath = directory.resolve("grants.json");
        this.lockPath = directory.resolve("grants.lock");
        this.clock = clock;
        this.owner = owner;
    }

    public static AccessGrantStore open(Path directory, Clock clock) {
        if (directory == null || clock == null) throw new IllegalArgumentException("Directory and clock are required.");
        AccessGrantStore store = null;
        boolean opened = false;
        try {
            Path absolute = directory.toAbsolutePath();
            UserPrincipal owner = absolute.getFileSystem().getUserPrincipalLookupService()
                    .lookupPrincipalByName(System.getProperty("user.name"));
            store = new AccessGrantStore(absolute, clock, owner);
            store.initialize();
            opened = true;
            return store;
        } catch (IOException | RuntimeException failure) {
            if (failure instanceof StorageException storage) throw storage;
            throw new StorageException("Access grant storage could not be opened safely.");
        } finally {
            if (!opened && store != null) store.releaseResources();
        }
    }

    private void initialize() throws IOException {
        checkDirectoryChain(directory.getParent());
        try {
            Files.createDirectory(directory, PosixFilePermissions.asFileAttribute(DIRECTORY_MODE));
        } catch (FileAlreadyExistsException exists) {
            // A pre-existing path must pass the same strict checks as a new directory.
        }
        directoryKey = checkedAttributes(directory, true).fileKey();
        directoryChannel = FileChannel.open(directory, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS);
        List<Path> stale = inspectDirectory();
        var identity = new DirectoryIdentity(directory.getFileSystem(), directoryKey);
        if (!OPEN_DIRECTORIES.add(identity)) throw new StorageException("Access grant storage is already locked.");
        claimedDirectory = identity;
        boolean existingLock = Files.exists(lockPath, LinkOption.NOFOLLOW_LINKS);
        if (existingLock) {
            lockChannel = FileChannel.open(lockPath, StandardOpenOption.READ,
                    StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS);
        } else {
            lockChannel = FileChannel.open(lockPath, Set.of(StandardOpenOption.CREATE_NEW,
                    StandardOpenOption.READ, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS),
                    PosixFilePermissions.asFileAttribute(FILE_MODE));
        }
        lockKey = checkedAttributes(lockPath, false).fileKey();
        lock = lockChannel.tryLock();
        if (lock == null) throw new StorageException("Access grant storage is already locked.");
        verifyIdentity();
        if (Files.exists(dataPath, LinkOption.NOFOLLOW_LINKS)) {
            dataKey = checkedAttributes(dataPath, false).fileKey();
            records = decode(readBounded());
        } else {
            // A leftover lock without data is not an empty store: do not reset lost state.
            if (existingLock || !stale.isEmpty()) throw invalidStorage();
            persist(List.of());
        }
        // Only recognized private temporary files, and only after acquiring the process lock.
        for (Path temporary : stale) Files.delete(temporary);
        directoryChannel.force(true);
        // Include a directory just created by a concurrent opener that lost the lock race.
        try (FileChannel parent = FileChannel.open(directory.getParent(),
                StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
            parent.force(true);
        }
    }

    /** Label lengths count UTF-16 code units; names and labels are preserved exactly. */
    public synchronized IssuedGrant create(String label, String model, Duration lifetime) {
        return create(label, model, lifetime, "local");
    }

    /** Issues a credential for exactly the specified channel, without changing existing grants. */
    public synchronized IssuedGrant create(String label, String model, Duration lifetime, String channel) {
        requireUsable();
        validateLabel(label);
        validateModel(model);
        validateLifetime(lifetime);
        validateChannel(channel);
        if (records.size() >= MAX_GRANTS) throw new IllegalStateException("Access grant storage is full (100 grants).");
        Instant now = clock.instant();
        Instant expires;
        try {
            expires = now.plus(lifetime);
        } catch (RuntimeException invalidTime) {
            throw new IllegalArgumentException("Grant expiry is outside the supported range.");
        }
        UUID id;
        do { id = UUID.randomUUID(); } while (find(id).isPresent());
        byte[] secret = new byte[32];
        random.nextBytes(secret);
        try {
            Grant grant = new Grant(id, label, model, now, expires, null, channel);
            List<StoredGrant> next = new ArrayList<>(records);
            next.addFirst(new StoredGrant(grant, digest(secret)));
            next.sort(Comparator.comparing((StoredGrant row) -> row.grant.createdAt()).reversed());
            List<StoredGrant> committed = List.copyOf(next);
            persist(committed);
            records = committed;
            return new IssuedGrant(grant, "hga1." + id + "."
                    + Base64.getUrlEncoder().withoutPadding().encodeToString(secret));
        } finally {
            Arrays.fill(secret, (byte) 0);
        }
    }

    /** Newest creation timestamp first; most recently issued first when timestamps tie. */
    public synchronized List<Grant> list() {
        requireUsable();
        return records.stream().map(row -> row.grant).toList();
    }

    /**
     * A bare, canonical hga1.UUID.base64url credential; no trimming or Bearer prefix.
     * Returns stored channel metadata; the caller must enforce arrival-channel equality.
     */
    public synchronized Optional<Grant> authenticate(String bearerToken) {
        if (closed || poisoned || bearerToken == null || bearerToken.length() != 85) return Optional.empty();
        var match = TOKEN.matcher(bearerToken);
        if (!match.matches()) return Optional.empty();
        byte[] secret = Base64.getUrlDecoder().decode(match.group(2));
        byte[] candidate = null;
        try {
            // Enforce zero padding bits: different text must not authenticate the same secret.
            if (secret.length != 32 || !Base64.getUrlEncoder().withoutPadding()
                    .encodeToString(secret).equals(match.group(2))) return Optional.empty();
            Optional<StoredGrant> found = find(UUID.fromString(match.group(1)));
            if (found.isEmpty()) return Optional.empty();
            StoredGrant row = found.get();
            candidate = digest(secret);
            boolean matches = MessageDigest.isEqual(row.hash, candidate);
            if (!matches || row.grant.revokedAt() != null
                    || !clock.instant().isBefore(row.grant.expiresAt())) return Optional.empty();
            return Optional.of(row.grant);
        } finally {
            Arrays.fill(secret, (byte) 0);
            if (candidate != null) Arrays.fill(candidate, (byte) 0);
        }
    }

    /** Known revocations are idempotent. A backward clock is clamped to the creation instant. */
    public synchronized Grant revoke(UUID id) {
        requireUsable();
        StoredGrant old = find(id).orElseThrow(() -> new IllegalArgumentException("Unknown access grant."));
        if (old.grant.revokedAt() != null) return old.grant;
        Instant now = clock.instant();
        if (now.isBefore(old.grant.createdAt())) now = old.grant.createdAt();
        Grant revoked = new Grant(old.grant.id(), old.grant.label(), old.grant.model(),
                old.grant.createdAt(), old.grant.expiresAt(), now, old.grant.channel());
        List<StoredGrant> next = new ArrayList<>(records);
        next.set(next.indexOf(old), new StoredGrant(revoked, old.hash));
        List<StoredGrant> committed = List.copyOf(next);
        persist(committed);
        records = committed;
        return revoked;
    }

    private Optional<StoredGrant> find(UUID id) {
        return records.stream().filter(row -> row.grant.id().equals(id)).findFirst();
    }

    private void persist(List<StoredGrant> next) {
        Path temporary = null;
        try {
            verifyIdentity();
            inspectDirectory();
            byte[] bytes = encode(next);
            if (bytes.length > MAX_BYTES) throw invalidStorage();
            temporary = Files.createTempFile(directory, ".grants-", ".tmp",
                    PosixFilePermissions.asFileAttribute(FILE_MODE));
            checkedAttributes(temporary, false);
            try (FileChannel output = FileChannel.open(temporary,
                    StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)) {
                ByteBuffer buffer = ByteBuffer.wrap(bytes);
                while (buffer.hasRemaining()) output.write(buffer);
                output.force(true);
            }
            verifyIdentity();
            Files.move(temporary, dataPath, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            temporary = null;
            directoryChannel.force(true);
            dataKey = checkedAttributes(dataPath, false).fileKey();
            verifyIdentity();
        } catch (IOException | RuntimeException failure) {
            poisoned = true;
            throw new StorageException("Access grant storage commit failed; this store is disabled.");
        } finally {
            if (temporary != null) {
                try {
                    Files.deleteIfExists(temporary);
                } catch (IOException | RuntimeException cleanupFailure) {
                    poisoned = true;
                    throw new StorageException("Access grant storage cleanup failed; this store is disabled.");
                }
            }
        }
    }

    private byte[] readBounded() throws IOException {
        try (FileChannel input = FileChannel.open(dataPath, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
            if (input.size() > MAX_BYTES) throw invalidStorage();
            ByteBuffer buffer = ByteBuffer.allocate(MAX_BYTES + 1);
            while (buffer.hasRemaining() && input.read(buffer) != -1) { /* bounded, including concurrent growth */ }
            if (buffer.position() > MAX_BYTES) throw invalidStorage();
            verifyIdentity();
            return Arrays.copyOf(buffer.array(), buffer.position());
        }
    }

    private static List<StoredGrant> decode(byte[] bytes) {
        JsonNode root = JSON.readTree(bytes);
        requireFields(root, Set.of("version", "grants"));
        if (!root.get("version").isInt()
                || !root.get("grants").isArray() || root.get("grants").size() > MAX_GRANTS) throw invalidStorage();
        int version = root.get("version").intValue();
        if (version != 1 && version != 2) throw invalidStorage();
        List<StoredGrant> result = new ArrayList<>();
        Set<UUID> ids = new HashSet<>();
        for (JsonNode row : root.get("grants")) {
            requireFields(row, version == 1 ? LEGACY_ROW_FIELDS : ROW_FIELDS);
            String channel = version == 1 ? "local" : string(row, "channel");
            validateChannel(channel);
            String idText = string(row, "id");
            if (!ID.matcher(idText).matches()) throw invalidStorage();
            UUID id = UUID.fromString(idText);
            if (!ids.add(id)) throw invalidStorage();
            String label = string(row, "label");
            String model = string(row, "model");
            validateLabel(label);
            validateModel(model);
            Instant created = instant(row, "createdAt");
            Instant expires = instant(row, "expiresAt");
            validateLifetime(Duration.between(created, expires));
            Instant revoked = row.get("revokedAt").isNull() ? null : instant(row, "revokedAt");
            if (revoked != null && revoked.isBefore(created)) throw invalidStorage();
            String hash = string(row, "hash");
            if (!HASH.matcher(hash).matches()) throw invalidStorage();
            result.add(new StoredGrant(new Grant(id, label, model, created, expires, revoked, channel),
                    HexFormat.of().parseHex(hash)));
        }
        result.sort(Comparator.comparing((StoredGrant row) -> row.grant.createdAt()).reversed());
        return List.copyOf(result);
    }

    private static byte[] encode(List<StoredGrant> records) {
        var root = JSON.createObjectNode().put("version", 2);
        var rows = root.putArray("grants");
        for (StoredGrant row : records) {
            Grant grant = row.grant;
            rows.addObject().put("id", grant.id().toString()).put("label", grant.label())
                    .put("model", grant.model()).put("createdAt", grant.createdAt().toString())
                    .put("expiresAt", grant.expiresAt().toString())
                    .put("revokedAt", grant.revokedAt() == null ? null : grant.revokedAt().toString())
                    .put("hash", HexFormat.of().formatHex(row.hash)).put("channel", grant.channel());
        }
        return JSON.writeValueAsBytes(root);
    }

    private static void requireFields(JsonNode node, Set<String> fields) {
        if (node == null || !node.isObject() || !new HashSet<>(node.propertyNames()).equals(fields)) throw invalidStorage();
    }

    private static String string(JsonNode row, String field) {
        JsonNode node = row.get(field);
        if (!node.isString()) throw invalidStorage();
        return node.stringValue();
    }

    private static Instant instant(JsonNode row, String field) {
        String value = string(row, field);
        Instant result = Instant.parse(value);
        if (!result.toString().equals(value)) throw invalidStorage();
        return result;
    }

    private static void validateLabel(String label) {
        if (label == null || label.isBlank() || label.length() > 80
                || label.codePoints().anyMatch(c -> Character.isISOControl(c) || (c >= 0xd800 && c <= 0xdfff))) {
            throw new IllegalArgumentException("Grant label must contain 1 to 80 characters without control characters.");
        }
    }

    private static void validateModel(String model) {
        if (model == null || model.length() > 128 || ModelAdmission.reason(model) != null) {
            throw new IllegalArgumentException("Grant model is not admitted by the gateway.");
        }
    }

    private static void validateLifetime(Duration lifetime) {
        if (lifetime == null || lifetime.compareTo(MIN_LIFETIME) < 0 || lifetime.compareTo(MAX_LIFETIME) > 0) {
            throw new IllegalArgumentException("Grant lifetime must be between one minute and seven days.");
        }
    }

    private static void validateChannel(String channel) {
        if (!"local".equals(channel) && !"internet".equals(channel)) {
            throw new IllegalArgumentException("Grant channel must be local or internet.");
        }
    }

    private static byte[] digest(byte[] secret) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(secret);
        } catch (NoSuchAlgorithmException unavailable) {
            throw new StorageException("Access grant hashing is unavailable.");
        }
    }

    private PosixFileAttributes checkedAttributes(Path path, boolean isDirectory) throws IOException {
        var attributes = Files.readAttributes(path, PosixFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (attributes.isSymbolicLink() || (isDirectory ? !attributes.isDirectory() : !attributes.isRegularFile())
                || !attributes.permissions().equals(isDirectory ? DIRECTORY_MODE : FILE_MODE)
                || !attributes.owner().equals(owner) || attributes.fileKey() == null) throw invalidStorage();
        return attributes;
    }

    private static void checkDirectoryChain(Path path) throws IOException {
        if (path == null) throw invalidStorage();
        Path cursor = path.getRoot();
        for (Path part : path) {
            cursor = cursor.resolve(part);
            if (!Files.isDirectory(cursor, LinkOption.NOFOLLOW_LINKS)) throw invalidStorage();
        }
    }

    private List<Path> inspectDirectory() throws IOException {
        List<Path> stale = new ArrayList<>();
        int count = 0;
        try (var paths = Files.newDirectoryStream(directory)) {
            for (Path path : paths) {
                if (++count > MAX_GRANTS + 2) throw invalidStorage();
                var attributes = checkedAttributes(path, false);
                String name = path.getFileName().toString();
                if (name.equals("grants.lock")) {
                    if (attributes.size() != 0) throw invalidStorage();
                } else if (name.equals("grants.json") || TEMP.matcher(name).matches()) {
                    if (attributes.size() > MAX_BYTES) throw invalidStorage();
                    if (!name.equals("grants.json")) stale.add(path);
                } else throw invalidStorage();
            }
        }
        return stale;
    }

    private void verifyIdentity() throws IOException {
        checkDirectoryChain(directory.getParent());
        if (!directoryKey.equals(checkedAttributes(directory, true).fileKey())
                || !lockKey.equals(checkedAttributes(lockPath, false).fileKey()) || !lock.isValid()) throw invalidStorage();
        if (dataKey != null && !dataKey.equals(checkedAttributes(dataPath, false).fileKey())) throw invalidStorage();
    }

    private static StorageException invalidStorage() {
        return new StorageException("Access grant storage has invalid data, permissions, or file identity.");
    }

    private void requireUsable() {
        if (closed) throw new StorageException("Access grant storage is closed.");
        if (poisoned) throw new StorageException("Access grant storage is disabled after a storage failure.");
    }

    @Override public synchronized void close() {
        if (closed) return;
        closed = true;
        records = List.of();
        if (!releaseResources()) throw new StorageException("Access grant storage could not close cleanly.");
    }

    private boolean releaseResources() {
        boolean success = true;
        if (lock != null) {
            try { lock.release(); } catch (IOException | RuntimeException failure) { success = false; }
        }
        if (lockChannel != null) {
            try { lockChannel.close(); } catch (IOException | RuntimeException failure) { success = false; }
        }
        if (directoryChannel != null) {
            try { directoryChannel.close(); } catch (IOException | RuntimeException failure) { success = false; }
        }
        if (claimedDirectory != null) {
            OPEN_DIRECTORIES.remove(claimedDirectory);
            claimedDirectory = null;
        }
        return success;
    }
}
