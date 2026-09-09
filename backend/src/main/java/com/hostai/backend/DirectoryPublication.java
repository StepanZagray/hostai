package com.hostai.backend;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.annotation.PreDestroy;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.locks.LockSupport;
import java.util.function.Supplier;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/** Optional directory ownership. Only its single worker touches identity or registry storage.
 * Immutable CAS snapshots keep observer callbacks nonblocking and avoid cross-service locks. */
@Service
final class DirectoryPublication implements AutoCloseable {
    static final String REQUIRE_LIVE = "Start local sharing and wait for verified live internet sharing before publishing.";
    static final String IDENTITY_ERROR = "Directory identity storage is unavailable. Check its permissions and lock, then restart the gateway. Chat and internet sharing are unaffected.";
    static final String EXPIRY = "Withdrawal could not be confirmed. A listing may remain visible for up to 90 seconds after its last update.";
    private static final String INTERRUPTED = "Internet reachability is interrupted. This opt-in can recover only on the same tunnel attempt and address.";
    private final DirectoryClient.Configuration configuration;
    private final DirectoryClient client;
    private final Supplier<Shared> sharing;
    private final InternetSharing internet;
    private final Supplier<DirectoryIdentity> identityStore;
    private final AtomicReference<Snapshot> state;
    private final AtomicBoolean readingListings = new AtomicBoolean();
    private final Thread worker;
    private final AutoCloseable observation;
    private volatile String cleanupFailure;
    // Worker-owned, including during shutdown. Never read by request/observer threads.
    private DirectoryIdentity identity;
    private boolean mayBeListed;
    private Long visibilityDeadline;
    private long lastWithdraw = -1;
    private long lastPublish = -1;
    private long lastCheck = -1;

    @Autowired DirectoryPublication(SharingService sharing, InternetSharing internet,
            @Value("${hostai.directory-url:}") String registry,
            @Value("${hostai.directory-allow-loopback:false}") String allowLoopback,
            @Value("${hostai.access-directory:}") String accessDirectory) {
        this(DirectoryClient.Configuration.parse(registry, allowLoopback), () -> {
            var status = sharing.status();
            return new Shared(status.state().equals("local"), status.hostLabel(), status.model());
        }, internet, () -> openIdentity(accessDirectory));
    }

    DirectoryPublication(DirectoryClient.Configuration configuration, Supplier<Shared> sharing,
            InternetSharing internet, Supplier<DirectoryIdentity> identityStore) {
        this.configuration = configuration;
        this.client = new DirectoryClient(configuration);
        this.sharing = sharing;
        this.internet = internet;
        this.identityStore = identityStore;
        state = new AtomicReference<>(new Snapshot(0, internet.observation(), null,
                configuration.error() == null || configuration.error().equals(DirectoryClient.MISSING) ? "off" : "failed",
                null, null, null, configuration.error(), false));
        worker = Thread.ofVirtual().name("hostai-directory-publication").unstarted(this::run);
        observation = internet.observe(this::changed);
        worker.start();
    }

    /** A separate private sibling per grant store; the grant schema forbids extra children. */
    static Path identityDirectory(String configuredAccessDirectory) {
        Path access;
        if (!configuredAccessDirectory.isBlank()) access = Path.of(configuredAccessDirectory).toAbsolutePath().normalize();
        else {
            String data = System.getenv("XDG_DATA_HOME");
            Path base = data != null && Path.of(data).isAbsolute() ? Path.of(data)
                    : Path.of(System.getProperty("user.home"), ".local", "share");
            access = base.resolve("hostai").resolve("access");
        }
        try {
            String name = ".hostai-directory-" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(access.toString().getBytes(StandardCharsets.UTF_8)));
            return access.getParent().resolve(name).resolve("identity");
        } catch (Exception ignored) { throw new IllegalStateException(IDENTITY_ERROR); }
    }

    static DirectoryIdentity openIdentity(String configuredAccessDirectory) {
        try {
            Path directory = identityDirectory(configuredAccessDirectory);
            Path wrapper = directory.getParent();
            // A custom access store may sit directly under /tmp. Create our own
            // private parent without changing that shared parent's permissions.
            Path ancestor = wrapper.getRoot();
            for (Path part : wrapper.getParent()) {
                ancestor = ancestor.resolve(part);
                if (!Files.isDirectory(ancestor, LinkOption.NOFOLLOW_LINKS)) throw new IllegalStateException();
            }
            try { Files.createDirectory(wrapper, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------"))); }
            catch (java.nio.file.FileAlreadyExistsException ignored) { /* Existing paths must pass the same strict checks. */ }
            if (!Files.isDirectory(wrapper, LinkOption.NOFOLLOW_LINKS)
                    || !Files.getPosixFilePermissions(wrapper, LinkOption.NOFOLLOW_LINKS)
                        .equals(PosixFilePermissions.fromString("rwx------"))) throw new IllegalStateException();
            try (var children = Files.list(wrapper)) {
                if (children.anyMatch(path -> !path.getFileName().toString().equals("identity"))) throw new IllegalStateException();
            }
            try (var parent = FileChannel.open(wrapper.getParent(), StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
                parent.force(true);
            }
            return new DirectoryIdentity(directory); // Also checks parent ownership and all ancestor identities.
        } catch (Exception ignored) { throw new IllegalStateException(IDENTITY_ERROR); }
    }

    Status status() { return status(state.get()); }

    private Status status(Snapshot current) {
        boolean configured = configuration.origin() != null;
        boolean canPublish = configured && !current.closing() && live(current.event())
                && current.intent() == null && !current.phase().equals("withdrawing");
        return new Status(current.phase(), configured, configured ? configuration.origin().toString() : null,
                current.intent() != null, canPublish, current.id(), current.updated(), current.expires(), current.error());
    }

    Status start() {
        changed(internet.observation());
        while (true) {
            Snapshot before = state.get();
            if (before.closing() || before.intent() != null || configuration.origin() == null
                    || before.phase().equals("withdrawing")) return status(before);
            if (!live(before.event())) {
                var after = before.result("failed", before.id(), before.updated(), before.expires(), REQUIRE_LIVE);
                if (state.compareAndSet(before, after)) return status(after);
                continue;
            }
            Shared selected;
            DirectoryClient.Listing listing;
            try {
                // No directory monitor is held while taking SharingService's lock.
                selected = sharing.get();
                if (!selected.enabled()) throw new IllegalStateException();
                listing = DirectoryClient.listing(selected.hostLabel(), selected.model(), origin(before.event()) + "/");
            } catch (RuntimeException ignored) {
                var after = before.result("failed", before.id(), before.updated(), before.expires(),
                        "Choose a printable host name and a tagged local model, then enable verified internet sharing before publishing.");
                if (state.compareAndSet(before, after)) return status(after);
                continue;
            }
            var intent = new Intent(before.event().attempt(), origin(before.event()), listing);
            var after = new Snapshot(before.generation() + 1, before.event(), intent, "publishing",
                    before.id(), before.updated(), before.expires(), null, false);
            if (state.compareAndSet(before, after)) { signal(); return status(after); }
        }
    }

    Status stop() {
        var after = state.updateAndGet(before -> before.closing() ? before : new Snapshot(before.generation() + 1,
                before.event(), null, configuration.origin() == null ? before.phase() : "withdrawing",
                before.id(), before.updated(), before.expires(), configuration.error(), false));
        signal();
        return status(after);
    }

    DirectoryClient.Listings listings() {
        // No unbounded connection fan-out or queued reads from tabs/local callers.
        // Publication/withdrawal uses its independent serialized worker.
        if (!readingListings.compareAndSet(false, true)) throw new DirectoryClient.Failure();
        try { return client.listings(); }
        finally { readingListings.set(false); }
    }

    private static String origin(InternetSharing.Observation event) {
        String value = event.status().publicUrl();
        return value != null && value.endsWith("/") ? value.substring(0, value.length() - 1) : value;
    }

    private static boolean live(InternetSharing.Observation event) {
        if (event == null || !event.status().state().equals("live") || event.status().checkedAt() == null) return false;
        String origin = origin(event);
        return origin != null && origin.matches("https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.trycloudflare\\.com");
    }

    /** Bounded latest-event coalescing; no I/O, external calls, monitor acquisition or thread interrupts. */
    private void changed(InternetSharing.Observation event) {
        state.updateAndGet(before -> {
            if (before.closing() || event.sequence() <= before.event().sequence()) return before;
            Intent intent = before.intent();
            long generation = before.generation();
            String phase = before.phase(), error = before.error();
            if (intent != null) {
                boolean interrupted = event.status().state().equals("interrupted") && event.attempt() == intent.attempt();
                boolean sameLive = live(event) && event.attempt() == intent.attempt() && intent.origin().equals(origin(event));
                if (!sameLive && !interrupted) {
                    intent = null; generation++; phase = "withdrawing"; error = null;
                } else if (interrupted && !before.event().status().state().equals("interrupted")) {
                    generation++; phase = "interrupted"; error = INTERRUPTED;
                } else if (sameLive && before.event().status().state().equals("interrupted")) {
                    generation++; phase = "publishing"; error = null;
                }
            }
            return new Snapshot(generation, event, intent, phase, before.id(), before.updated(), before.expires(), error, false);
        });
        signal();
    }

    private void signal() { LockSupport.unpark(worker); }

    private boolean cancelled(Snapshot work) {
        Snapshot now = state.get();
        var transport = internet.observation();
        return now.generation() != work.generation() || now.closing() != work.closing()
                || work.intent() != null && (!live(now.event()) || now.event().attempt() != work.intent().attempt()
                    || !work.intent().origin().equals(origin(now.event())) || !live(transport)
                    || transport.attempt() != work.intent().attempt() || !work.intent().origin().equals(origin(transport)));
    }

    private void run() {
        try {
            while (true) {
                Snapshot work = state.get();
                if (work.closing()) {
                    if (mayBeListed) withdraw(work);
                    else complete(work, "off", null, null, configuration.error());
                    break;
                }
                if (work.intent() == null || !live(work.event())) {
                    if (mayBeListed && lastWithdraw != work.generation()) {
                        lastWithdraw = work.generation(); withdraw(work); continue;
                    }
                    if (!mayBeListed && work.phase().equals("withdrawing")) {
                        complete(work, "off", null, null, configuration.error()); continue;
                    }
                } else if (lastPublish != work.generation() || lastCheck != work.event().sequence()) {
                    lastPublish = work.generation(); lastCheck = work.event().sequence();
                    publish(work); continue;
                }
                LockSupport.park(this);
            }
        } finally {
            if (identity != null) {
                try { identity.close(); }
                catch (RuntimeException ignored) { cleanupFailure = "Directory identity cleanup could not be completed."; }
            }
        }
    }

    private void publish(Snapshot work) {
        try {
            if (cancelled(work)) return;
            Shared selected = sharing.get();
            if (cancelled(work)) return;
            if (!selected.enabled() || !selected.hostLabel().equals(work.intent().listing().hostLabel())
                    || !selected.model().equals(work.intent().listing().model())) {
                clearIntent(work, REQUIRE_LIVE); return;
            }
            if (identity == null) identity = identityStore.get();
            String id = identity.id();
            if (!id.matches("[0-9a-f]{64}")) throw new IllegalStateException();
            state.updateAndGet(before -> before.result(before.phase(), id, before.updated(), before.expires(), before.error()));
            if (cancelled(work)) return;
            mayBeListed = true; // Includes a timed-out/cancelled mutation whose remote outcome is unknown.
            var result = client.mutate(identity, work.intent().listing(), () -> cancelled(work));
            visibilityDeadline = result.expiresAt();
            if (!cancelled(work)) complete(work, "listed", result.updatedAt(), result.expiresAt(), null);
        } catch (CancellationException ignored) {
            if (mayBeListed) visibilityDeadline = null;
            // The next iteration withdraws any uncertain publication.
        }
        catch (DirectoryClient.Failure failure) {
            // The remote mutation may have applied, so neither a host-clock
            // deadline nor an older registry timestamp describes its outcome.
            visibilityDeadline = null;
            complete(work, "failed", null, null,
                    failure.getMessage() + " Any prior listing expires within 90 seconds of its last update.");
        } catch (RuntimeException ignored) { clearIntent(work, IDENTITY_ERROR); }
    }

    private void withdraw(Snapshot work) {
        try {
            // A withdrawal during interrupted reachability is allowed; it cannot probe or restart transport.
            client.mutate(identity, null, () -> state.get().generation() != work.generation());
            mayBeListed = false;
            visibilityDeadline = null;
            complete(work, work.intent() == null ? "off" : "interrupted", null, null,
                    work.intent() == null ? null : INTERRUPTED);
        } catch (CancellationException ignored) { /* A newer intent owns the next serialized mutation. */ }
        catch (RuntimeException ignored) {
            complete(work, work.intent() == null ? "failed" : "interrupted",
                    visibilityDeadline == null ? null : work.updated(), visibilityDeadline,
                    (IDENTITY_ERROR.equals(work.error()) ? IDENTITY_ERROR + " " : work.intent() == null ? "" : INTERRUPTED + " ") + EXPIRY);
            if (work.closing()) cleanupFailure = EXPIRY;
        }
    }

    private void complete(Snapshot work, String phase, Long updated, Long expires, String error) {
        state.updateAndGet(before -> before.generation() != work.generation() ? before
                : before.result(phase, before.id(), updated, expires, error));
    }

    private void clearIntent(Snapshot work, String error) {
        state.updateAndGet(before -> before.generation() != work.generation() ? before
                : new Snapshot(before.generation() + 1, before.event(), null, "failed", before.id(),
                        before.updated(), before.expires(), error, before.closing()));
    }

    @Override @PreDestroy public void close() {
        state.updateAndGet(before -> before.closing() ? before : new Snapshot(before.generation() + 1,
                before.event(), null, "withdrawing", before.id(), before.updated(), before.expires(), before.error(), true));
        try { observation.close(); }
        catch (Exception ignored) { cleanupFailure = "The directory observer could not be unregistered."; }
        signal();
        try { worker.join(Duration.ofSeconds(7)); }
        catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt(); throw new IllegalStateException("Directory shutdown was interrupted.");
        }
        if (worker.isAlive()) throw new IllegalStateException("Directory worker shutdown has not completed.");
        if (cleanupFailure != null) throw new IllegalStateException(cleanupFailure);
    }

    record Shared(boolean enabled, String hostLabel, String model) {}
    private record Intent(long attempt, String origin, DirectoryClient.Listing listing) {}
    private record Snapshot(long generation, InternetSharing.Observation event, Intent intent, String phase,
                            String id, Long updated, Long expires, String error, boolean closing) {
        Snapshot result(String phase, String id, Long updated, Long expires, String error) {
            return new Snapshot(generation, event, intent, phase, id, updated, expires, error, closing);
        }
    }
    @JsonInclude(JsonInclude.Include.ALWAYS)
    record Status(String state, boolean configured, String registryUrl, boolean enabled, boolean canPublish,
                  String identityId, Long updatedAt, Long expiresAt, String error) {}
}
