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
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Future;
import java.util.concurrent.FutureTask;
import java.util.function.Supplier;
import tools.jackson.core.StreamReadConstraints;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.json.JsonMapper;

/**
 * A persisted Ed25519 identity in a dedicated, exclusively locked local POSIX directory.
 * The immediate parent must already be private and owned by the current user; no ancestor may
 * be a symbolic link. Permissions are checked, never changed. Like access grant storage, this
 * requires stable file identities, atomic rename and file/directory fsync, and trusts the OS
 * and current user. It does not protect against a malicious process running as that user.
 * Use a sibling of the grant-store directory: that store rejects unexpected child entries.
 *
 * <p>The exact version-1 JSON schema is {version, publicKey, privateKey}: canonical unpadded
 * base64url DER SPKI and PKCS8, respectively. The private key is plaintext in a 0600 file.
 * Initialization is the only write. A leftover lock or temporary file without a committed
 * identity is an error, never permission to generate a replacement. Unknown/crash files are
 * left untouched. A storage failure permanently disables an opened instance.
 *
 * <p>Operations, including open and close, complete despite caller interruption and preserve
 * its interrupt status. Each runs on a private, short-lived I/O thread: interrupting a caller
 * must not close a FileChannel, release the OS lock, or strand an initialization marker.
 * Callers must wait for completion before stopping/restarting; interruption does not cancel
 * a commit or skip storage validation. Actual storage failures still fail closed.
 */
public final class DirectoryIdentity implements AutoCloseable {
    private static final int MAX_BYTES = 2048;
    private static final Set<PosixFilePermission> DIRECTORY_MODE = PosixFilePermissions.fromString("rwx------");
    private static final Set<PosixFilePermission> FILE_MODE = PosixFilePermissions.fromString("rw-------");
    // RFC 8410 Ed25519 AlgorithmIdentifier has absent parameters. Only these minimal DER
    // forms are accepted; providers may otherwise accept NULL parameters or trailing bytes.
    private static final byte[] PUBLIC_PREFIX = HexFormat.of().parseHex("302a300506032b6570032100");
    private static final byte[] PRIVATE_PREFIX = HexFormat.of().parseHex("302e020100300506032b657004220420");
    private static final Base64.Encoder BASE64 = Base64.getUrlEncoder().withoutPadding();
    // Closing ANY descriptor for a locked file can release POSIX process locks. Claim the
    // directory inode before opening the lock, including alternate lexical paths in this JVM.
    private static final Set<DirectoryKey> OPEN_DIRECTORIES = ConcurrentHashMap.newKeySet();
    private static final JsonMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .streamReadConstraints(StreamReadConstraints.builder().maxDocumentLength(MAX_BYTES)
                    .maxNestingDepth(2).maxStringLength(128).maxNameLength(16)
                    .maxNumberLength(2).maxTokenCount(16).build()).build())
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();

    private final Path directory;
    private final Path dataPath;
    private final Path lockPath;
    private UserPrincipal owner;
    private FileChannel parentChannel;
    private FileChannel directoryChannel;
    private FileChannel lockChannel;
    private FileLock lock;
    private Object parentKey;
    private Object directoryKey;
    private Object lockKey;
    private Object dataKey;
    private DirectoryKey claimedDirectory;
    private PrivateKey privateKey;
    private String publicKey;
    private String id;
    private byte[] documentHash;
    private boolean closed;
    private boolean poisoned;

    private record DirectoryKey(FileSystem fileSystem, Object fileKey) {}

    /** Contains no paths, key material, input data, or underlying exception. */
    public static final class StorageException extends IllegalStateException {
        private StorageException(String message) { super(message); }
    }

    public DirectoryIdentity(Path directory) {
        if (directory == null) throw new IllegalArgumentException("Identity directory is required.");
        this.directory = directory.toAbsolutePath();
        this.dataPath = this.directory.resolve("identity.json");
        this.lockPath = this.directory.resolve("identity.lock");
        completeOperation(() -> {
            open();
            return null;
        });
    }

    private void open() {
        boolean opened = false;
        try {
            owner = directory.getFileSystem().getUserPrincipalLookupService()
                    .lookupPrincipalByName(System.getProperty("user.name"));
            initialize();
            opened = true;
        } catch (IOException | GeneralSecurityException | RuntimeException failure) {
            if (failure instanceof StorageException storage) throw storage;
            throw new StorageException("Directory identity could not be opened safely.");
        } finally {
            if (!opened) {
                privateKey = null;
                releaseResources();
            }
        }
    }

    private void initialize() throws IOException, GeneralSecurityException {
        checkDirectoryChain();
        parentKey = checkedAttributes(directory.getParent(), true).fileKey();
        parentChannel = FileChannel.open(directory.getParent(), StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS);
        try {
            Files.createDirectory(directory, PosixFilePermissions.asFileAttribute(DIRECTORY_MODE));
        } catch (FileAlreadyExistsException exists) {
            // Existing directories must pass exactly the same security checks.
        }
        directoryKey = checkedAttributes(directory, true).fileKey();
        directoryChannel = FileChannel.open(directory, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS);
        var claim = new DirectoryKey(directory.getFileSystem(), directoryKey);
        if (!OPEN_DIRECTORIES.add(claim)) throw new StorageException("Directory identity is already locked.");
        claimedDirectory = claim;
        inspectDirectory();
        boolean existingLock = Files.exists(lockPath, LinkOption.NOFOLLOW_LINKS);
        boolean existingData = Files.exists(dataPath, LinkOption.NOFOLLOW_LINKS);
        if (existingLock != existingData) throw invalidStorage();
        if (existingLock) {
            lockKey = checkedAttributes(lockPath, false).fileKey();
            lockChannel = FileChannel.open(lockPath, StandardOpenOption.READ,
                    StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS);
        } else {
            lockChannel = FileChannel.open(lockPath, Set.of(StandardOpenOption.CREATE_NEW,
                    StandardOpenOption.READ, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS),
                    PosixFilePermissions.asFileAttribute(FILE_MODE));
            lockKey = checkedAttributes(lockPath, false).fileKey();
        }
        lock = lockChannel.tryLock();
        if (lock == null) throw new StorageException("Directory identity is already locked.");
        verifyFiles();
        if (existingData) {
            dataKey = checkedAttributes(dataPath, false).fileKey();
            byte[] bytes = readBounded();
            try {
                decode(bytes);
                documentHash = digest(bytes);
            } finally { Arrays.fill(bytes, (byte) 0); }
        } else {
            // Persist the initialization marker before attempting a key write. Failure never
            // returns a usable instance; a retry sees the marker and cannot rotate the identity.
            lockChannel.force(true);
            directoryChannel.force(true);
            parentChannel.force(true);
            var pair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
            byte[] encodedPrivate = pair.getPrivate().getEncoded();
            byte[] bytes = null;
            try {
                bytes = JSON.writeValueAsBytes(JSON.createObjectNode().put("version", 1)
                        .put("publicKey", BASE64.encodeToString(pair.getPublic().getEncoded()))
                        .put("privateKey", BASE64.encodeToString(encodedPrivate)));
                decode(bytes);
                persist(bytes);
                documentHash = digest(bytes);
            } finally {
                Arrays.fill(encodedPrivate, (byte) 0);
                if (bytes != null) Arrays.fill(bytes, (byte) 0);
            }
        }
        directoryChannel.force(true);
        parentChannel.force(true);
        checkStorage();
    }

    public synchronized String publicKey() {
        return completeOperation(() -> {
            requireUsable();
            return publicKey;
        });
    }

    /** Lowercase SHA-256 hex of the DER SPKI bytes, independent of JSON serialization. */
    public synchronized String id() {
        return completeOperation(() -> {
            requireUsable();
            return id;
        });
    }

    /** Signs the supplied bytes exactly, including empty or non-UTF-8 payloads. */
    public synchronized String sign(byte[] payload) {
        return completeOperation(() -> {
            requireUsable();
            if (payload == null) throw new IllegalArgumentException("Identity signing payload is required.");
            try {
                byte[] signature = signature(payload);
                checkStorage();
                return BASE64.encodeToString(signature);
            } catch (IOException | GeneralSecurityException | RuntimeException failure) {
                poisoned = true;
                throw new StorageException("Directory identity signing failed; this identity is disabled.");
            }
        });
    }

    private byte[] signature(byte[] payload) throws GeneralSecurityException {
        Signature signer = Signature.getInstance("Ed25519");
        signer.initSign(privateKey);
        signer.update(payload);
        byte[] result = signer.sign();
        if (result.length != 64) throw invalidStorage();
        return result;
    }

    private void decode(byte[] bytes) throws GeneralSecurityException {
        var root = JSON.readTree(bytes);
        if (root == null || !root.isObject()
                || !new HashSet<>(root.propertyNames()).equals(Set.of("version", "publicKey", "privateKey"))
                || !root.get("version").isInt() || root.get("version").intValue() != 1
                || !root.get("publicKey").isString() || !root.get("privateKey").isString()) throw invalidStorage();
        byte[] publicDer = canonicalKey(root.get("publicKey").stringValue(), PUBLIC_PREFIX);
        byte[] privateDer = canonicalKey(root.get("privateKey").stringValue(), PRIVATE_PREFIX);
        try {
            KeyFactory factory = KeyFactory.getInstance("Ed25519");
            var decodedPublic = factory.generatePublic(new X509EncodedKeySpec(publicDer));
            privateKey = factory.generatePrivate(new PKCS8EncodedKeySpec(privateDer));
            // Validate the pair cryptographically rather than trusting two individually valid keys.
            Signature verifier = Signature.getInstance("Ed25519");
            verifier.initVerify(decodedPublic);
            verifier.update(publicDer);
            if (!verifier.verify(signature(publicDer))) throw invalidStorage();
            publicKey = BASE64.encodeToString(publicDer);
            id = HexFormat.of().formatHex(digest(publicDer));
        } finally { Arrays.fill(privateDer, (byte) 0); }
    }

    private static byte[] canonicalKey(String encoded, byte[] prefix) {
        int length = prefix.length + 32;
        if (encoded.length() != (length * 8 + 5) / 6) throw invalidStorage();
        byte[] bytes = Base64.getUrlDecoder().decode(encoded);
        if (bytes.length != length || !BASE64.encodeToString(bytes).equals(encoded)
                || !Arrays.equals(bytes, 0, prefix.length, prefix, 0, prefix.length)) {
            Arrays.fill(bytes, (byte) 0);
            throw invalidStorage();
        }
        return bytes;
    }

    private void persist(byte[] bytes) throws IOException {
        Path temporary = null;
        try {
            verifyFiles();
            inspectDirectory();
            if (bytes.length > MAX_BYTES || Files.exists(dataPath, LinkOption.NOFOLLOW_LINKS)) throw invalidStorage();
            temporary = Files.createTempFile(directory, ".identity-", ".tmp",
                    PosixFilePermissions.asFileAttribute(FILE_MODE));
            checkedAttributes(temporary, false);
            try (FileChannel output = FileChannel.open(temporary, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)) {
                ByteBuffer buffer = ByteBuffer.wrap(bytes);
                while (buffer.hasRemaining()) output.write(buffer);
                output.force(true);
            }
            verifyFiles();
            if (Files.exists(dataPath, LinkOption.NOFOLLOW_LINKS)) throw invalidStorage();
            Files.move(temporary, dataPath, StandardCopyOption.ATOMIC_MOVE);
            temporary = null;
            directoryChannel.force(true);
            dataKey = checkedAttributes(dataPath, false).fileKey();
            verifyFiles();
        } finally {
            if (temporary != null) Files.deleteIfExists(temporary);
        }
    }

    private byte[] readBounded() throws IOException {
        try (FileChannel input = FileChannel.open(dataPath, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
            if (input.size() > MAX_BYTES) throw invalidStorage();
            ByteBuffer buffer = ByteBuffer.allocate(MAX_BYTES + 1);
            try {
                while (buffer.hasRemaining() && input.read(buffer) != -1) { /* bound concurrent growth too */ }
                if (buffer.position() > MAX_BYTES) throw invalidStorage();
                verifyFiles();
                return Arrays.copyOf(buffer.array(), buffer.position());
            } finally { Arrays.fill(buffer.array(), (byte) 0); }
        }
    }

    private static byte[] digest(byte[] bytes) throws GeneralSecurityException {
        return MessageDigest.getInstance("SHA-256").digest(bytes);
    }

    private PosixFileAttributes checkedAttributes(Path path, boolean isDirectory) throws IOException {
        var attributes = Files.readAttributes(path, PosixFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (attributes.isSymbolicLink() || (isDirectory ? !attributes.isDirectory() : !attributes.isRegularFile())
                || !attributes.permissions().equals(isDirectory ? DIRECTORY_MODE : FILE_MODE)
                || !attributes.owner().equals(owner) || attributes.fileKey() == null) throw invalidStorage();
        // Local Unix filesystems also expose special mode bits and hard-link counts, neither
        // of which appears in PosixFileAttributes.permissions(). Fail closed if unavailable.
        int mode = (Integer) Files.getAttribute(path, "unix:mode", LinkOption.NOFOLLOW_LINKS);
        if ((mode & 07777) != (isDirectory ? 0700 : 0600)
                || (!isDirectory && (Integer) Files.getAttribute(path, "unix:nlink", LinkOption.NOFOLLOW_LINKS) != 1)) {
            throw invalidStorage();
        }
        return attributes;
    }

    private void checkDirectoryChain() throws IOException {
        Path parent = directory.getParent();
        if (parent == null) throw invalidStorage();
        Path cursor = parent.getRoot();
        for (Path part : parent) {
            cursor = cursor.resolve(part);
            if (!Files.isDirectory(cursor, LinkOption.NOFOLLOW_LINKS)) throw invalidStorage();
        }
    }

    private void inspectDirectory() throws IOException {
        int count = 0;
        try (var paths = Files.newDirectoryStream(directory)) {
            for (Path path : paths) {
                if (++count > 2) throw invalidStorage();
                String name = path.getFileName().toString();
                if (!name.equals("identity.json") && !name.equals("identity.lock")) throw invalidStorage();
                var attributes = checkedAttributes(path, false);
                if (attributes.size() > (name.equals("identity.lock") ? 0 : MAX_BYTES)) throw invalidStorage();
            }
        }
    }

    private void verifyFiles() throws IOException {
        checkDirectoryChain();
        if (!parentKey.equals(checkedAttributes(directory.getParent(), true).fileKey())
                || !directoryKey.equals(checkedAttributes(directory, true).fileKey())
                || !lockKey.equals(checkedAttributes(lockPath, false).fileKey()) || !lock.isValid()) throw invalidStorage();
        if (dataKey != null && !dataKey.equals(checkedAttributes(dataPath, false).fileKey())) throw invalidStorage();
    }

    private void checkStorage() throws IOException, GeneralSecurityException {
        verifyFiles();
        inspectDirectory();
        byte[] bytes = readBounded();
        try {
            if (!MessageDigest.isEqual(documentHash, digest(bytes))) throw invalidStorage();
        } finally { Arrays.fill(bytes, (byte) 0); }
    }

    private void requireUsable() {
        if (closed) throw new StorageException("Directory identity is closed.");
        if (poisoned) throw new StorageException("Directory identity is disabled after a storage failure.");
        try {
            checkStorage();
        } catch (IOException | GeneralSecurityException | RuntimeException failure) {
            poisoned = true;
            throw new StorageException("Directory identity storage failed; this identity is disabled.");
        }
    }

    private static StorageException invalidStorage() {
        return new StorageException("Directory identity has invalid data, permissions, or file identity.");
    }

    private static <T> T completeOperation(Supplier<T> operation) {
        // Clearing the caller's flag around channel I/O leaves a race with the next interrupt.
        // Never expose or cancel this worker. The caller retains its monitor until the worker
        // terminates, so close cannot race a commit/check and join publishes all state changes.
        var task = new FutureTask<T>(operation::get);
        Thread worker = Thread.ofVirtual().name("directory-identity-io")
                .inheritInheritableThreadLocals(false).start(task);
        boolean interrupted = false;
        try {
            for (;;) {
                try {
                    worker.join();
                    break;
                } catch (InterruptedException cancellation) {
                    interrupted = true;
                }
            }
            if (task.state() == Future.State.FAILED) {
                Throwable failure = task.exceptionNow();
                if (failure instanceof RuntimeException runtime) throw runtime;
                if (failure instanceof Error error) throw error;
                throw new AssertionError(failure); // Supplier cannot throw a checked exception.
            }
            return task.resultNow();
        } finally {
            if (interrupted) Thread.currentThread().interrupt();
        }
    }

    @Override public synchronized void close() {
        if (closed) return;
        completeOperation(() -> {
            closed = true;
            privateKey = null;
            if (!releaseResources()) throw new StorageException("Directory identity could not close cleanly.");
            return null;
        });
    }

    private boolean releaseResources() {
        boolean success = true;
        if (lock != null) {
            try { lock.release(); } catch (IOException | RuntimeException failure) { success = false; }
        }
        for (FileChannel channel : new FileChannel[] { lockChannel, directoryChannel, parentChannel }) {
            if (channel != null) {
                try { channel.close(); } catch (IOException | RuntimeException failure) { success = false; }
            }
        }
        if (claimedDirectory != null) {
            OPEN_DIRECTORIES.remove(claimedDirectory);
            claimedDirectory = null;
        }
        return success;
    }
}
