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
    private final Map<UUID, GuestSession> sessions = new HashMap<>();
    private final Map<UUID, Window> windows = new HashMap<>();
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
            @Value("${hostai.guest-port:8081}") int port) {
        this(gateway, chat, validator, json, inferenceScheduler, dataDirectory(directory), port, Clock.systemUTC());
    }

    SharingService(OllamaGateway gateway, ChatService chat, Validator validator, JsonMapper json,
            Scheduler scheduler, Path directory, int port, Clock clock) {
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
        return new Status(storageError != null ? "unavailable" : enabled ? "local" : "stopped",
                hostLabel, model, server == null ? null : server.origin(), storageError, grants);
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

    public synchronized Invite create(String label, int hours) {
        if (!enabled || closed) throw new GatewayException(HttpStatus.CONFLICT, "Start local client access before creating a key.");
        if (hours < 1 || hours > 168) throw new GatewayException(HttpStatus.BAD_REQUEST, "Access must expire within 1 to 168 hours.");
        try {
            if (accessStore().list().size() >= 100)
                throw new GatewayException(HttpStatus.CONFLICT, "The 100-key storage limit has been reached.");
            var issued = accessStore().create(label, model, Duration.ofHours(hours));
            return new Invite(issued.grant(), issued.token(), server.origin() + "/#access=" + issued.token());
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
        try {
            accessStore().revoke(id); // Durable before reporting success and signalling callers.
            List.copyOf(sessions.values()).stream().filter(session -> session.grant.id().equals(id)).forEach(GuestSession::end);
            windows.remove(id);
            return snapshot(store.list());
        } catch (IllegalArgumentException error) {
            throw new GatewayException(HttpStatus.NOT_FOUND, "The access grant does not exist.");
        } catch (RuntimeException error) {
            storageFault();
            throw unavailable();
        }
    }

    synchronized AccessGrantStore.Grant authenticate(String token) {
        if (closed || storageError != null) throw unavailable();
        var grant = accessStore().authenticate(token).orElseThrow(SharingService::unauthorized);
        if (!enabled) throw new GatewayException(HttpStatus.SERVICE_UNAVAILABLE, "The host has stopped client access.");
        if (!grant.model().equals(model)) throw unauthorized();
        return grant;
    }

    Mono<SessionView> session(String token) {
        return Mono.defer(() -> {
            var grant = authenticate(token);
            return gateway.models().map(models -> {
                synchronized (this) {
                    authenticate(token); // A metadata probe must not outlive a revocation.
                    boolean available = installed(models, grant.model());
                    return new SessionView(hostLabel, grant.model(), grant.expiresAt(), available,
                            available ? null : "The shared model is unavailable. Ask the host to check its local runtime.",
                            InferenceRegistry.MAX_GUEST_CONCURRENT, GUEST_MAX_TOKENS, REQUESTS_PER_MINUTE, "local-preview");
                }
            });
        });
    }

    Flux<Api.ChatChunk> chat(String token, Api.ChatRequest request) {
        return Flux.defer(() -> {
            if (!validator.validate(request).isEmpty() || request.maxTokens() > GUEST_MAX_TOKENS)
                return Flux.error(new GatewayException(HttpStatus.BAD_REQUEST,
                        "Check the message limits and choose at most 1024 output tokens."));
            return Flux.using(() -> register(token, request.model()), session ->
                    gateway.models().takeUntilOther(session.ended())
                    .switchIfEmpty(Mono.error(new ChatService.AccessEndedException()))
                    .flatMapMany(models -> {
                        requireInstalled(models, session.grant.model());
                        return chat.chatGuest(request, session.ended());
                    }), this::release);
        });
    }

    private synchronized GuestSession register(String token, String requestedModel) {
        var grant = authenticate(token);
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
        GuestSession session = new GuestSession(grant);
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
        if (previous != null) previous.close();
        if (previousStore != null) previousStore.close();
    }

    private final class GuestSession {
        final UUID id = UUID.randomUUID();
        final AccessGrantStore.Grant grant;
        final Sinks.One<String> stop = Sinks.one();
        GuestSession(AccessGrantStore.Grant grant) { this.grant = grant; }
        void end() { stop.tryEmitValue("Access ended"); }
        Mono<String> ended() {
            return Mono.defer(() -> {
                Duration remaining = Duration.between(clock.instant(), grant.expiresAt());
                return Mono.firstWithSignal(stop.asMono(),
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
                         List<AccessGrantStore.Grant> grants) {}
    public record Invite(AccessGrantStore.Grant grant, String token, String inviteUrl) {
        @Override public String toString() { return "Invite[grant=" + grant.id() + ", credential=<redacted>]"; }
    }
    @JsonInclude(JsonInclude.Include.ALWAYS)
    record SessionView(String hostLabel, String model, Instant expiresAt, boolean available, String unavailableReason,
                       int maxConcurrentGuests, int maxTokens, int requestsPerMinute, String scope) {}
}
