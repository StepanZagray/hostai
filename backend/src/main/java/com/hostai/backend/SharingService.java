package com.hostai.backend;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.annotation.PreDestroy;
import jakarta.validation.Validator;
import java.nio.file.Path;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.io.IOException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Sinks;
import reactor.core.scheduler.Scheduler;
import tools.jackson.databind.json.JsonMapper;

/** Owner-controlled publication, durable permissions, and bounded guest request ownership. */
@Service
public final class SharingService implements AutoCloseable {
    public static final int GUEST_MAX_TOKENS = 1024;
    public static final int REQUESTS_PER_MINUTE = 6;
    private final OllamaGateway gateway;
    private final ChatService chat;
    private final Validator validator;
    private final JsonMapper json;
    private final Scheduler scheduler;
    private final Path directory;
    private final int port;
    private final Clock clock;
    private final InternetSharing internet;
    private final Map<UUID, GuestSession> sessions = new HashMap<>();
    private final Map<UUID, Window> windows = new HashMap<>();
    private final AccessRequestInbox requests;
    private static final String REQUEST_LABEL = "Request · ";
    private AccessGrantStore store;
    private GuestServer server;
    private boolean enabled;
    private boolean closed;
    private String model;
    private String hostLabel = "Local host";
    private String storageError;

    @Autowired
    public SharingService(OllamaGateway gateway, ChatService chat, Validator validator, JsonMapper json,
            Scheduler inferenceScheduler, @Value("${hostai.access-directory:}") String directory,
            @Value("${hostai.guest-port:8081}") int port, InternetSharing internet) {
        this(gateway, chat, validator, json, inferenceScheduler, dataDirectory(directory), port, Clock.systemUTC(), internet);
    }

    SharingService(OllamaGateway gateway, ChatService chat, Validator validator, JsonMapper json,
            Scheduler scheduler, Path directory, int port, Clock clock) {
        this(gateway, chat, validator, json, scheduler, directory, port, clock, new InternetSharing(""));
    }

    SharingService(OllamaGateway gateway, ChatService chat, Validator validator, JsonMapper json,
            Scheduler scheduler, Path directory, int port, Clock clock, InternetSharing internet) {
        this.internet = internet;
        this.requests = new AccessRequestInbox(clock, System::nanoTime);
        if (port < 0 || port > 65535) throw new IllegalArgumentException("Invalid guest port");
        this.gateway = gateway; this.chat = chat; this.validator = validator; this.json = json;
        this.scheduler = scheduler; this.directory = directory; this.port = port; this.clock = clock;
    }

    private static Path dataDirectory(String configured) {
        if (!configured.isBlank()) return Path.of(configured).toAbsolutePath().normalize();
        String data = System.getenv("XDG_DATA_HOME");
        Path base = data != null && Path.of(data).isAbsolute() ? Path.of(data)
                : Path.of(System.getProperty("user.home"), ".local", "share");
        return base.resolve("hostai").resolve("access");
    }

    public synchronized Status status() {
        try { return snapshot(accessStore().list()); }
        catch (RuntimeException error) { storageFault(); return snapshot(List.of()); }
    }

    private Status snapshot(List<AccessGrantStore.Grant> grants) {
        syncRequests();
        return new Status(storageError != null ? "unavailable" : enabled ? "local" : "stopped",
                hostLabel, model, server == null ? null : server.origin(), storageError, grants, internet.status(), requestStatus(grants));
    }

    public Mono<Status> start(String selectedModel, String label) {
        if (ModelAdmission.reason(selectedModel) != null || label == null || label.isBlank()
                || label.length() > 80 || label.chars().anyMatch(Character::isISOControl))
            return Mono.error(new GatewayException(HttpStatus.BAD_REQUEST, "Choose a local model and a host name of up to 80 characters."));
        return gateway.models().map(models -> {
            requireInstalled(models, selectedModel);
            synchronized (this) {
                if (closed) throw unavailable();
                accessStore();
                if (enabled && (!selectedModel.equals(model) || !label.trim().equals(hostLabel)))
                    throw new GatewayException(HttpStatus.CONFLICT, "Stop client access before changing the shared model or host name.");
                if (server == null) server = GuestServer.start(this, json, scheduler, port);
                model = selectedModel;
                hostLabel = label.trim();
                enabled = true;
                return snapshot(store.list());
            }
        }).onErrorMap(error -> {
            if (error instanceof GatewayException) return error;
            synchronized (this) { storageFault(); }
            return unavailable();
        });
    }

    public synchronized Status stop() {
        stopSessions();
        return status();
    }

    public synchronized Status startInternet() {
        if (!enabled || closed || storageError != null)
            throw new GatewayException(HttpStatus.CONFLICT, "Start client access for a model before enabling internet sharing.");
        internet.start(ingress -> GuestServer.start(this, json, scheduler, 0, ingress));
        return status();
    }

    public synchronized Status stopInternet() { requests.stop(); internet.stop(); return status(); }

    public Invite create(String label, int hours) { return create(label, hours, "local"); }

    public synchronized Invite create(String label, int hours, String channel) {
        if (!enabled || closed) throw new GatewayException(HttpStatus.CONFLICT, "Start local client access before creating a key.");
        if (hours < 1 || hours > 168) throw new GatewayException(HttpStatus.BAD_REQUEST, "Access must expire within 1 to 168 hours.");
        if (!List.of("local", "internet").contains(channel))
            throw new GatewayException(HttpStatus.BAD_REQUEST, "Choose local or internet access.");
        String origin = channel.equals("internet") ? internet.publicOrigin().toString() : server.origin();
        try {
            if (accessStore().list().size() >= 100)
                throw new GatewayException(HttpStatus.CONFLICT, "The 100-key storage limit has been reached.");
            var issued = accessStore().create(label, model, Duration.ofHours(hours), channel);
            return new Invite(issued.grant(), issued.token(), origin + "/#access=" + issued.token());
        } catch (GatewayException error) {
            throw error;
        } catch (IllegalArgumentException error) {
            throw new GatewayException(HttpStatus.BAD_REQUEST, "Check the access label, expiry and grant limit.");
        } catch (RuntimeException error) {
            storageFault();
            throw unavailable();
        }
    }

    public synchronized Status revoke(UUID id) {
        revokeGrant(id);
        return snapshot(store.list());
    }

    private void revokeGrant(UUID id) {
        try {
            accessStore().revoke(id); // Durable before reporting success and signalling callers.
            List.copyOf(sessions.values()).stream().filter(session -> session.grant.id().equals(id)).forEach(GuestSession::end);
            windows.remove(id);
        } catch (IllegalArgumentException error) {
            throw new GatewayException(HttpStatus.NOT_FOUND, "The access grant does not exist.");
        } catch (RuntimeException error) {
            storageFault();
            throw unavailable();
        }
    }

    /** All inbox transitions and durable callbacks share this service's existing monitor. */
    public synchronized Status startRequests() {
        syncRequests();
        requireRequestHost();
        requireRequestCapacity(accessStore().list());
        var observed = internet.observation();
        requests.start(observed.attempt(), internet.publicOrigin().toString(), model, hostLabel);
        return status();
    }

    public synchronized Status stopRequests() { requests.stop(); return status(); }

    public synchronized Status approveRequest(UUID id, String code, int hours) {
        syncRequests();
        requireRequestHost();
        var context = requests.context();
        if (context == null) throw requestsOff();
        // Reconcile revocation before idempotently returning a previously resolved request.
        var grants = accessStore().list();
        if (requests.ownerItems(grants).stream().anyMatch(row -> row.id().equals(id)
                && row.code().equals(code) && row.state().equals("pending"))) requireRequestCapacity(grants);
        AccessGrantStore.Grant[] issued = new AccessGrantStore.Grant[1];
        try {
            requests.approve(id, code, hours, approval -> {
                requireRequestCapacity(accessStore().list());
                try {
                    issued[0] = accessStore().createCommitted(REQUEST_LABEL + approval.name() + " · " + approval.code(),
                            approval.model(), Duration.ofHours(approval.hours()), approval.channel(), approval.secretHash());
                } catch (AccessGrantStore.StorageException error) {
                    storageFault();
                    throw unavailable();
                } catch (IllegalArgumentException error) {
                    throw new GatewayException(HttpStatus.BAD_REQUEST, "Check the request name, model and access duration.");
                } catch (IllegalStateException error) {
                    throw new GatewayException(HttpStatus.CONFLICT, "The host cannot create another access key.");
                }
                // A tunnel worker can invalidate the attempt while the durable write runs.
                syncRequests();
                requireRequestHost();
                if (!context.equals(requests.context())) throw requestsOff();
                return issued[0];
            });
        } catch (RuntimeException error) {
            // Includes validation after issuance or a lost tunnel during fsync. Never orphan a
            // grant whose approval the inbox could not record successfully.
            if (issued[0] != null && storageError == null) revokeGrant(issued[0].id());
            throw error;
        }
        return status();
    }

    public synchronized Status rejectRequest(UUID id, String code) {
        syncRequests();
        if (requests.ownerItems(accessStore().list()).stream().anyMatch(row -> row.id().equals(id)
                && row.code().equals(code) && row.state().equals("approved")))
            throw new GatewayException(HttpStatus.CONFLICT, "This request was already approved. Revoke its key in Access keys to end permission.");
        requests.reject(id, code);
        return status();
    }

    synchronized RequestHello requestHello(PublicIngress.Permit permit) {
        requireRequestGuest(permit, false);
        requests.discover();
        var context = requests.context();
        var grants = accessStore().list();
        boolean available = context != null && grants.size() < 100 && remainingRequestSlots(grants) > 0;
        permit.requireActive();
        return new RequestHello(1, "temporary-internet", available,
                available ? context.intakeId() : null,
                available ? context.hostLabel() : null, available ? context.model() : null);
    }

    synchronized void requireRequestGuest(PublicIngress.Permit permit, boolean intakeRequired) {
        if (permit == null || !permit.channel().equals("internet")) throw requestsOff();
        permit.requireActive();
        syncRequests();
        requireRequestHost();
        if (intakeRequired && requests.context() == null) throw requestsOff();
    }

    synchronized AccessRequestInbox.GuestView submitRequest(PublicIngress.Permit permit, String bearer,
            String intakeId, String name, String selectedModel, String commitment) {
        requireRequestGuest(permit, true);
        requests.ownerItems(accessStore().list());
        // Capacity is checked at approval, so an idempotent POST can still recover its approved ID
        // when that approval used the final slot. Pending requests never consume durable slots.
        var result = requests.submit(intakeId, bearer, name, selectedModel, commitment);
        permit.requireActive();
        return result;
    }

    synchronized AccessRequestInbox.GuestView pollRequest(PublicIngress.Permit permit, String bearer) {
        requireRequestGuest(permit, true);
        requests.ownerItems(accessStore().list());
        var result = requests.poll(bearer);
        permit.requireActive();
        return result;
    }

    synchronized AccessRequestInbox.GuestView cancelRequest(PublicIngress.Permit permit, String bearer) {
        requireRequestGuest(permit, true);
        requests.ownerItems(accessStore().list());
        var result = requests.cancel(bearer, this::revokeGrant);
        permit.requireActive();
        return result;
    }

    private void syncRequests() {
        var context = requests.context();
        if (context == null) return;
        var observed = internet.observation();
        String state = observed.status().state();
        if (!enabled || closed || storageError != null || context.attempt() != observed.attempt()
                || !context.model().equals(model) || !context.hostLabel().equals(hostLabel)
                || !(state.equals("live") || state.equals("interrupted"))
                || state.equals("live") && !context.origin().equals(observed.status().publicUrl())) requests.stop();
    }

    private void requireRequestHost() {
        if (!enabled || closed || storageError != null) throw unavailable();
        internet.publicOrigin(); // Only a live verified attempt accepts/approves requests.
    }

    private int remainingRequestSlots(List<AccessGrantStore.Grant> grants) {
        Instant now = clock.instant();
        long active = grants.stream().filter(grant -> grant.label().startsWith(REQUEST_LABEL)
                && grant.channel().equals("internet") && grant.revokedAt() == null
                && now.isBefore(grant.expiresAt())).count();
        return Math.max(0, 20 - (int) active);
    }

    private void requireRequestCapacity(List<AccessGrantStore.Grant> grants) {
        if (grants.size() >= 100) throw new GatewayException(HttpStatus.CONFLICT,
                "The host cannot approve more requests: the 100-key storage limit is full, including expired and revoked keys.");
        if (remainingRequestSlots(grants) == 0) throw new GatewayException(HttpStatus.CONFLICT,
                "The host already has 20 active request keys. Wait for expiry or revoke an unused request key.");
    }

    private RequestsStatus requestStatus(List<AccessGrantStore.Grant> grants) {
        var context = requests.context();
        int remaining = Math.max(0, 100 - grants.size());
        int requestSlots = remainingRequestSlots(grants);
        return new RequestsStatus(context != null, context != null && enabled && storageError == null
                && internet.status().state().equals("live") && remaining > 0 && requestSlots > 0,
                context == null ? null : context.intakeId(), remaining, requestSlots, requests.ownerItems(grants));
    }

    private static GatewayException requestsOff() {
        return new GatewayException(HttpStatus.NOT_FOUND, "Access requests are not available. Ask the host for an invitation.");
    }

    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record RequestsStatus(boolean enabled, boolean available, UUID intakeId, int remainingGrantSlots,
                                 int remainingRequestSlots, List<AccessRequestInbox.OwnerView> items) {}
    @JsonInclude(JsonInclude.Include.ALWAYS)
    record RequestHello(int version, String scope, boolean requestsAccepted, UUID intakeId, String hostLabel, String model) {}

    AccessGrantStore.Grant authenticate(String token) { return authenticate(token, PublicIngress.Permit.LOCAL); }

    synchronized AccessGrantStore.Grant authenticate(String token, PublicIngress.Permit permit) {
        permit.requireActive();
        if (closed || storageError != null) throw unavailable();
        var grant = accessStore().authenticate(token).orElseThrow(SharingService::unauthorized);
        if (!enabled) throw new GatewayException(HttpStatus.SERVICE_UNAVAILABLE, "The host has stopped client access.");
        if (!grant.model().equals(model) || !grant.channel().equals(permit.channel())) throw unauthorized();
        return grant;
    }

    Mono<SessionView> session(String token) { return session(token, PublicIngress.Permit.LOCAL); }

    Mono<SessionView> session(String token, PublicIngress.Permit permit) {
        return Mono.defer(() -> {
            var grant = authenticate(token, permit);
            return gateway.models().map(models -> {
                synchronized (this) {
                    authenticate(token, permit); // A metadata probe must not outlive a revocation.
                    boolean available = installed(models, grant.model());
                    return new SessionView(hostLabel, grant.model(), grant.expiresAt(), available,
                            available ? null : "The shared model is unavailable. Ask the host to check its local runtime.",
                            InferenceRegistry.MAX_GUEST_CONCURRENT, GUEST_MAX_TOKENS, REQUESTS_PER_MINUTE, permit.scope());
                }
            });
        });
    }

    Flux<Api.ChatChunk> chat(String token, Api.ChatRequest request) { return chat(token, request, PublicIngress.Permit.LOCAL); }

    Flux<Api.ChatChunk> chat(String token, Api.ChatRequest request, PublicIngress.Permit permit) {
        return Flux.defer(() -> {
            if (!validator.validate(request).isEmpty() || request.maxTokens() > GUEST_MAX_TOKENS)
                return Flux.error(new GatewayException(HttpStatus.BAD_REQUEST,
                        "Check the message limits and choose at most 1024 output tokens."));
            return Flux.using(() -> register(token, request.model(), permit), session ->
                    gateway.models().takeUntilOther(session.ended())
                    .switchIfEmpty(Mono.error(new ChatService.AccessEndedException()))
                    .flatMapMany(models -> {
                        requireInstalled(models, session.grant.model());
                        return chat.chatGuest(request, session.ended());
                    }), this::release);
        });
    }

    private synchronized GuestSession register(String token, String requestedModel, PublicIngress.Permit permit) {
        var grant = authenticate(token, permit);
        if (!grant.model().equals(requestedModel))
            throw new GatewayException(HttpStatus.FORBIDDEN, "This access key does not permit the requested model.");
        if (!sessions.isEmpty()) throw new GuestBusyException(1);
        Instant now = clock.instant();
        Window window = windows.get(grant.id());
        if (window == null || !now.isBefore(window.until)) {
            window = new Window(now.plusSeconds(60)); windows.put(grant.id(), window);
        }
        if (window.count >= REQUESTS_PER_MINUTE)
            throw new GuestBusyException(Math.max(1, (int) Duration.between(now, window.until).toSeconds() + 1));
        window.count++;
        GuestSession session = new GuestSession(grant, permit);
        sessions.put(session.id, session);
        return session;
    }

    private synchronized void release(GuestSession session) { sessions.remove(session.id); }

    private AccessGrantStore accessStore() {
        if (closed || storageError != null) throw unavailable();
        if (store == null) {
            try { prepareParent(directory); store = AccessGrantStore.open(directory, clock); }
            catch (RuntimeException error) { storageFault(); throw unavailable(); }
        }
        return store;
    }

    private static void prepareParent(Path directory) {
        try {
            Path parent = directory.toAbsolutePath().getParent();
            Path cursor = parent.getRoot();
            for (Path part : parent) {
                cursor = cursor.resolve(part);
                if (!Files.exists(cursor, LinkOption.NOFOLLOW_LINKS)) {
                    try { Files.createDirectory(cursor, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------"))); }
                    catch (java.nio.file.FileAlreadyExistsException raced) { /* Recheck the actual directory below. */ }
                }
                if (!Files.isDirectory(cursor, LinkOption.NOFOLLOW_LINKS)) throw new IOException();
            }
        } catch (IOException | RuntimeException error) {
            throw unavailable();
        }
    }

    private void storageFault() {
        storageError = "Access storage is unavailable. Client access is stopped; local chat still works. Repair storage and restart the gateway.";
        stopSessions();
    }

    private void stopSessions() {
        enabled = false;
        requests.stop();
        internet.stop();
        List.copyOf(sessions.values()).forEach(GuestSession::end);
    }

    private static boolean installed(Api.Models models, String model) {
        return models.connected() && models.models().stream()
                .anyMatch(item -> item.name().equals(model) && item.chatUnavailableReason() == null);
    }

    private static void requireInstalled(Api.Models models, String model) {
        if (!installed(models, model)) throw new GatewayException(HttpStatus.SERVICE_UNAVAILABLE,
                "The selected model is unavailable on this host. Check the local model library.");
    }

    static GatewayException unauthorized() {
        return new GatewayException(HttpStatus.UNAUTHORIZED, "This access key is invalid or has expired. Ask the host for a valid key.");
    }

    private static GatewayException unavailable() {
        return new GatewayException(HttpStatus.SERVICE_UNAVAILABLE, "Client access is unavailable. Ask the host to check its access settings.");
    }

    @Override @PreDestroy
    public void close() {
        GuestServer previous;
        AccessGrantStore previousStore;
        synchronized (this) {
            if (closed) return;
            closed = true; stopSessions();
            previous = server; server = null;
            previousStore = store; store = null;
        }
        try { internet.close(); }
        finally {
            try { if (previous != null) previous.close(); }
            finally { if (previousStore != null) previousStore.close(); }
        }
    }

    private final class GuestSession {
        final UUID id = UUID.randomUUID();
        final AccessGrantStore.Grant grant;
        final Sinks.One<String> stop = Sinks.one();
        final PublicIngress.Permit permit;
        GuestSession(AccessGrantStore.Grant grant, PublicIngress.Permit permit) { this.grant = grant; this.permit = permit; }
        void end() { stop.tryEmitValue("Access ended"); }
        Mono<String> ended() {
            return Mono.defer(() -> {
                Duration remaining = Duration.between(clock.instant(), grant.expiresAt());
                return Mono.firstWithSignal(stop.asMono(), permit.ended(),
                        Mono.delay(remaining.isNegative() ? Duration.ZERO : remaining).map(ignored -> "Access ended"));
            });
        }
    }

    private static final class Window {
        final Instant until; int count;
        Window(Instant until) { this.until = until; }
    }

    static final class GuestBusyException extends RuntimeException {
        final int retryAfter;
        GuestBusyException(int retryAfter) { super("Client capacity is busy or the request limit was reached. Try again later."); this.retryAfter = retryAfter; }
    }

    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Status(String state, String hostLabel, String model, String guestUrl, String error,
                         List<AccessGrantStore.Grant> grants, InternetSharing.Status internet, RequestsStatus requests) {}
    public record Invite(AccessGrantStore.Grant grant, String token, String inviteUrl) {
        @Override public String toString() { return "Invite[grant=" + grant.id() + ", credential=<redacted>]"; }
    }
    @JsonInclude(JsonInclude.Include.ALWAYS)
    record SessionView(String hostLabel, String model, Instant expiresAt, boolean available, String unavailableReason,
                       int maxConcurrentGuests, int maxTokens, int requestsPerMinute, String scope) {}
}
