package com.hostai.backend;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.locks.LockSupport;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/**
 * Owns one explicitly started Quick Tunnel, its private configuration and all observed descendants.
 * No raw child output is retained beyond a bounded line or exposed in diagnostics.
 * Callbacks are serialized on a separate virtual thread, outside lifecycle locks; they may call
 * close, and a slow callback cannot prevent process cleanup. Close does not wait for user callbacks.
 * Abrupt JVM death closes the watchdog pipe and kills the direct executable. It cannot run Java's
 * descendant discovery or directory cleanup; the private configuration/scratch directory can remain.
 */
final class QuickTunnelProcess implements AutoCloseable {
    private static final int MAX_LINE_BYTES = 16 * 1024;
    private static final int MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
    private static final long POLL_NANOS = Duration.ofMillis(10).toNanos();
    private static final long DISCOVERY_NANOS = Duration.ofMillis(500).toNanos();
    // Static POSIX wrapper: argv remains data. The watcher owns a duplicated stdin pipe; JVM
    // death closes its writer and kills this one child. Normal child exit also reaps the watcher.
    private static final String WATCHDOG = """
            "$@" </dev/null & child=$!
            (while IFS= read -r line; do :; done; kill -KILL "$child" 2>/dev/null) <&0 & watcher=$!
            trap 'kill -KILL "$child" "$watcher" 2>/dev/null; wait "$child" 2>/dev/null; wait "$watcher" 2>/dev/null' EXIT
            trap 'exit 143' TERM INT HUP
            wait "$child"; result=$?
            exit "$result"
            """;
    private static final String STOPPED = "Quick Tunnel stopped.";
    private static final String EXITED = "Quick Tunnel exited.";
    private static final String FAILED = "Quick Tunnel failed.";
    private static final String OUTPUT_LIMIT = "Quick Tunnel output limit exceeded.";
    private static final String ORIGIN_CHANGED = "Quick Tunnel origin changed.";
    private static final String CALLBACK_FAILED = "Quick Tunnel callback failed.";
    private static final String CLEANUP_FAILED = "Quick Tunnel cleanup failed.";
    // Only whitespace and the log table's pipe separators delimit URLs. In particular, punctuation,
    // ports, slashes, percent escapes and Unicode suffixes must not turn a hostile URL into a match.
    private static final Pattern PUBLIC_ORIGIN = Pattern.compile(
            "(?<![^ \\t|])https://([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.trycloudflare\\.com)(?=$|[ \\t|])",
            Pattern.CASE_INSENSITIVE);

    record Exit(String reason) {}

    private final Process process;
    private final Path directory;
    private final Consumer<URI> announced;
    private final Consumer<Exit> exited;
    private final Set<ProcessHandle> descendants = ConcurrentHashMap.newKeySet();
    private final AtomicReference<String> stopReason = new AtomicReference<>();
    private final Object cleanupLock = new Object();
    private final Object eventLock = new Object();
    // There can only ever be one announcement followed by one exit.
    private final ArrayBlockingQueue<Object> events = new ArrayBlockingQueue<>(2);
    private boolean exitQueued;
    private boolean cleaned;
    private boolean cleanupFailed;
    private URI origin;

    private QuickTunnelProcess(Process process, Path directory,
                               Consumer<URI> announced, Consumer<Exit> exited) {
        this.process = process;
        this.directory = directory;
        this.announced = announced;
        this.exited = exited;
    }

    static QuickTunnelProcess start(Path executable, URI loopbackOrigin, String ingressSecret,
                                    Consumer<URI> announced, Consumer<Exit> exited) throws IOException {
        validate(loopbackOrigin, ingressSecret, announced, exited);
        Path directory = null;
        QuickTunnelProcess owner = null;
        try {
            if (executable == null || !Files.isRegularFile(executable) || !Files.isExecutable(executable))
                throw new IOException();
            Path command = executable.toAbsolutePath();
            directory = Files.createTempDirectory("hostai-quick-tunnel-",
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
            for (String name : List.of("home", "config", "data", "tmp"))
                Files.createDirectory(directory.resolve(name),
                        PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
            Path config = Files.createFile(directory.resolve("tunnel.yaml"),
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
            Files.writeString(config, "tag:\n  - Hostai-Ingress=" + ingressSecret + "\n", StandardCharsets.US_ASCII);
            var builder = new ProcessBuilder("/bin/sh", "-c", WATCHDOG, "hostai-tunnel-watchdog", command.toString(), "tunnel", "--config", config.toString(),
                    "--no-autoupdate", "--metrics", "127.0.0.1:0", "--protocol", "http2",
                    "--loglevel", "info",
                    "--url", loopbackOrigin.toASCIIString())
                    .directory(directory.toFile()).redirectErrorStream(true);
            var environment = builder.environment();
            environment.clear();
            environment.put("PATH", System.getenv().getOrDefault("PATH", "/usr/bin:/bin"));
            environment.put("HOME", directory.resolve("home").toString());
            environment.put("XDG_CONFIG_HOME", directory.resolve("config").toString());
            environment.put("XDG_DATA_HOME", directory.resolve("data").toString());
            environment.put("TMPDIR", directory.resolve("tmp").toString());
            owner = new QuickTunnelProcess(builder.start(), directory, announced, exited);
            owner.rememberDescendants();
            Thread.ofVirtual().name("quick-tunnel-callbacks").start(owner::deliverEvents);
            Thread.ofVirtual().name("quick-tunnel-supervisor").start(owner::supervise);
            return owner;
        } catch (IOException | RuntimeException failure) {
            try {
                if (owner != null) owner.close();
                else if (directory != null) deleteDirectory(directory);
            } catch (IOException | RuntimeException cleanup) {
                throw new IOException(CLEANUP_FAILED);
            }
            throw new IOException("Quick Tunnel could not be started.");
        }
    }

    private static void validate(URI origin, String secret, Consumer<URI> announced, Consumer<Exit> exited) {
        if (origin == null || origin.getPort() < 1 || origin.getPort() > 65535
                || !origin.toString().equals("http://127.0.0.1:" + origin.getPort()))
            throw new IllegalArgumentException("Quick Tunnel requires an IPv4 loopback HTTP origin.");
        if (secret == null || !secret.matches("[A-Za-z0-9_-]{43}")
                || !Base64.getUrlEncoder().withoutPadding().encodeToString(
                        Base64.getUrlDecoder().decode(secret)).equals(secret))
            throw new IllegalArgumentException("Quick Tunnel requires a valid ingress secret.");
        if (announced == null || exited == null)
            throw new IllegalArgumentException("Quick Tunnel requires lifecycle callbacks.");
    }

    /** Deployment input only; never expands shell syntax or starts a discovery subprocess. */
    static Optional<Path> findExecutable(String configured) {
        if (configured != null && !configured.isBlank()) return executable(configured);
        String search = System.getenv("PATH");
        if (search == null) return Optional.empty();
        for (String entry : search.split(Pattern.quote(java.io.File.pathSeparator))) {
            if (entry.isBlank()) continue;
            try {
                Optional<Path> found = executable(Path.of(entry).resolve("cloudflared").toString());
                if (found.isPresent()) return found;
            } catch (InvalidPathException ignored) { /* Invalid PATH entries are not candidates. */ }
        }
        return Optional.empty();
    }

    private static Optional<Path> executable(String value) {
        try {
            Path path = Path.of(value).toAbsolutePath().normalize();
            return Files.isRegularFile(path) && Files.isExecutable(path) ? Optional.of(path) : Optional.empty();
        } catch (InvalidPathException | SecurityException ignored) {
            return Optional.empty();
        }
    }

    /** Returns an unambiguous, canonical origin from one bounded log line. */
    static Optional<URI> publicOrigin(String line) {
        List<URI> origins = publicOrigins(line);
        if (origins.isEmpty()) return Optional.empty();
        URI first = origins.getFirst();
        return origins.stream().allMatch(first::equals) ? Optional.of(first) : Optional.empty();
    }

    private static List<URI> publicOrigins(String line) {
        if (line == null || line.length() > MAX_LINE_BYTES
                || line.getBytes(StandardCharsets.UTF_8).length > MAX_LINE_BYTES
                || line.indexOf('\n') >= 0) return List.of();
        // Accept a CRLF line ending, but never use embedded control characters as URL boundaries.
        if (line.endsWith("\r")) line = line.substring(0, line.length() - 1);
        var matcher = PUBLIC_ORIGIN.matcher(line);
        var origins = new ArrayList<URI>();
        while (matcher.find()) origins.add(URI.create("https://" + matcher.group(1).toLowerCase(Locale.ROOT)));
        return origins;
    }

    boolean isAlive() { return process.isAlive(); }

    long pid() { return process.pid(); }

    private void supervise() {
        String reason = FAILED;
        byte[] line = new byte[MAX_LINE_BYTES];
        byte[] buffer = new byte[16 * 1024];
        int length = 0;
        int total = 0;
        long nextDiscovery = 0;
        InputStream output = process.getInputStream();
        try {
            while (stopReason.get() == null) {
                long now = System.nanoTime();
                if (now >= nextDiscovery) {
                    rememberDescendants();
                    nextDiscovery = now + DISCOVERY_NANOS;
                }
                // available() avoids an unbounded read/close lock when a descendant inherits stdout.
                // One bounded batch per iteration also keeps descendant discovery and close responsive.
                int available = output.available();
                if (available > 0) {
                    int read = output.read(buffer, 0, Math.min(available, buffer.length));
                    for (int i = 0; i < read; i++) {
                        if (++total > MAX_OUTPUT_BYTES) { reason = OUTPUT_LIMIT; return; }
                        if (buffer[i] == '\n') {
                            if (!acceptLine(line, length)) { reason = ORIGIN_CHANGED; return; }
                            length = 0;
                        } else {
                            if (length == MAX_LINE_BYTES) { reason = OUTPUT_LIMIT; return; }
                            line[length++] = buffer[i];
                        }
                    }
                } else if (!process.isAlive()) {
                    // Recheck after observing exit so the final bytes published by the reaper are drained.
                    if (output.available() > 0) continue;
                    reason = acceptLine(line, length)
                            ? (process.exitValue() == 0 ? EXITED : FAILED) : ORIGIN_CHANGED;
                    return;
                } else {
                    LockSupport.parkNanos(POLL_NANOS);
                }
            }
        } catch (IOException | RuntimeException ignored) {
            // Exception messages may contain output, arguments or paths. Never retain the cause.
        } finally {
            try { finish(reason); }
            catch (IllegalStateException ignored) { /* Cleanup failure is also delivered as the exit reason. */ }
        }
    }

    private boolean acceptLine(byte[] bytes, int length) {
        for (URI candidate : publicOrigins(new String(bytes, 0, length, StandardCharsets.UTF_8))) {
            if (origin != null && !origin.equals(candidate)) return false;
            if (origin == null) {
                origin = candidate;
                synchronized (eventLock) {
                    if (stopReason.get() == null && !exitQueued) events.add(candidate);
                }
            }
        }
        return true;
    }

    private void deliverEvents() {
        boolean interrupted = false;
        try {
            while (true) {
                Object event;
                try { event = events.take(); }
                catch (InterruptedException ignored) {
                    interrupted = true;
                    stopReason.compareAndSet(null, CALLBACK_FAILED);
                    continue; // Even an interrupt from a callback must not discard the exit notification.
                }
                if (event instanceof Exit exit) {
                    try { exited.accept(exit); }
                    catch (Throwable ignored) { /* User callbacks cannot leak diagnostics through this worker. */ }
                    return;
                }
                try { announced.accept((URI) event); }
                catch (Throwable ignored) { stopReason.compareAndSet(null, CALLBACK_FAILED); }
            }
        } finally {
            if (interrupted) Thread.currentThread().interrupt();
        }
    }

    @Override public void close() { finish(STOPPED); }

    private void finish(String reason) {
        stopReason.compareAndSet(null, reason);
        boolean failed;
        synchronized (cleanupLock) {
            if (!cleaned) {
                boolean interrupted = Thread.interrupted();
                try {
                    terminateOwned();
                } catch (RuntimeException failure) {
                    cleanupFailed = true;
                } finally {
                    for (var pipe : List.of(process.getInputStream(), process.getErrorStream(), process.getOutputStream())) {
                        try { pipe.close(); }
                        catch (IOException | RuntimeException failure) { cleanupFailed = true; }
                    }
                    try { deleteDirectory(directory); }
                    catch (IOException | RuntimeException failure) { cleanupFailed = true; }
                    cleaned = true;
                    if (interrupted || Thread.interrupted()) Thread.currentThread().interrupt();
                }
            }
            failed = cleanupFailed;
        }
        synchronized (eventLock) {
            if (!exitQueued) {
                exitQueued = true;
                events.add(new Exit(failed ? CLEANUP_FAILED : stopReason.get()));
            }
        }
        if (failed) throw new IllegalStateException(CLEANUP_FAILED);
    }

    private void rememberDescendants() {
        process.descendants().forEach(descendants::add);
        // A previously observed child can outlive its parent and acquire more children.
        for (ProcessHandle child : List.copyOf(descendants))
            if (child.isAlive()) child.descendants().forEach(descendants::add);
        descendants.removeIf(child -> !child.isAlive());
    }

    private void terminateOwned() {
        // Leave the parent alive long enough to reap children; terminating the entire tree at once
        // can leave zombies. Work from live leaves upwards, within shared graceful/forced deadlines.
        long graceful = System.nanoTime() + Duration.ofMillis(500).toNanos();
        long deadline = graceful + Duration.ofSeconds(1).toNanos();
        do {
            rememberDescendants();
            List<ProcessHandle> alive = descendants.stream().filter(ProcessHandle::isAlive).toList();
            if (alive.isEmpty()) break;
            for (ProcessHandle child : alive) {
                boolean hasChild = alive.stream().anyMatch(other -> other.parent().filter(child::equals).isPresent());
                if (!hasChild) {
                    if (System.nanoTime() < graceful) child.destroy();
                    else child.destroyForcibly();
                }
            }
            pauseForCleanup();
        } while (System.nanoTime() < deadline);

        process.destroy();
        waitForOwned(Duration.ofMillis(500), false);
        if (process.isAlive()) process.destroyForcibly();
        waitForOwned(Duration.ofSeconds(1), true);
        if (process.isAlive() || descendants.stream().anyMatch(ProcessHandle::isAlive))
            throw new IllegalStateException(CLEANUP_FAILED);
    }

    private void waitForOwned(Duration timeout, boolean force) {
        long deadline = System.nanoTime() + timeout.toNanos();
        do {
            rememberDescendants();
            for (ProcessHandle child : descendants) {
                if (child.isAlive()) {
                    if (force) child.destroyForcibly();
                    else child.destroy();
                }
            }
            if (!process.isAlive() && descendants.stream().noneMatch(ProcessHandle::isAlive)) return;
            pauseForCleanup();
        } while (System.nanoTime() < deadline);
    }

    private static void pauseForCleanup() {
        // Preserve interruption for the caller without abandoning owned processes or busy-spinning.
        boolean interrupted = Thread.interrupted();
        LockSupport.parkNanos(POLL_NANOS);
        if (interrupted) Thread.currentThread().interrupt();
    }

    private static void deleteDirectory(Path directory) throws IOException {
        // walkFileTree does not follow symbolic links, including links made by the child.
        Files.walkFileTree(directory, new SimpleFileVisitor<>() {
            @Override public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) throws IOException {
                Files.delete(file);
                return FileVisitResult.CONTINUE;
            }

            @Override public FileVisitResult postVisitDirectory(Path path, IOException failure) throws IOException {
                if (failure != null) throw failure;
                Files.delete(path);
                return FileVisitResult.CONTINUE;
            }
        });
    }
}
