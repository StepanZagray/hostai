package com.hostai.backend;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.web.reactive.socket.WebSocketMessage;
import org.springframework.web.reactive.socket.WebSocketSession;
import org.springframework.web.reactive.socket.server.support.HandshakeWebSocketService;
import org.springframework.web.reactive.socket.server.upgrade.ReactorNettyRequestUpgradeStrategy;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.BaseSubscriber;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Sinks;
import reactor.core.scheduler.Scheduler;
import reactor.netty.http.server.WebsocketServerSpec;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.json.JsonMapper;

/** One bounded upload and one generation, under the existing guest permission and lease owners. */
final class GuestSocket {
    static final String CHAT_PATH = "/guest/v1/chat-stream";
    static final int MAX_ENVELOPE_BYTES = 263_168;
    private final SharingService sharing;
    private final JsonMapper json;
    private final Scheduler scheduler;
    private final HandshakeWebSocketService handshakes = new HandshakeWebSocketService(
            new ReactorNettyRequestUpgradeStrategy(() -> WebsocketServerSpec.builder()
                    .maxFramePayloadLength(MAX_ENVELOPE_BYTES).compress(false)));

    GuestSocket(SharingService sharing, JsonMapper json, Scheduler scheduler) {
        this.sharing = sharing; this.json = json; this.scheduler = scheduler;
    }

    boolean matches(String path) { return CHAT_PATH.equals(path) || path.startsWith(PublicIngress.PROBE_PREFIX); }

    Mono<Void> upgrade(ServerWebExchange exchange, PublicIngress ingress) {
        var request = exchange.getRequest();
        var headers = request.getHeaders();
        String path = request.getURI().getRawPath();
        boolean chat = CHAT_PATH.equals(path);
        if (!chat && !ingress.probePath().equals(path))
            return Mono.error(new GatewayException(HttpStatus.NOT_FOUND, "The requested endpoint does not exist."));
        // Credentials belong only in the first data message. Forwarded headers have no authority here.
        var origins = headers.getOrEmpty(HttpHeaders.ORIGIN);
        if (!origins.isEmpty() && (origins.size() != 1 || !ingress.origin().toString().equals(origins.getFirst())))
            return Mono.error(new GatewayException(HttpStatus.FORBIDDEN, "This client origin is not permitted."));
        if (request.getURI().getRawQuery() != null || headers.containsHeader(HttpHeaders.AUTHORIZATION)
                || headers.containsHeader(HttpHeaders.COOKIE) || headers.containsHeader("Sec-WebSocket-Protocol")
                || request.getMethod() != HttpMethod.GET)
            return Mono.error(invalid());
        PublicIngress.Permit permit = chat ? ingress.permit() : null;
        return handshakes.handleRequest(exchange, session -> chat ? chat(session, permit)
                : send(session, ingress.probe(path.substring(PublicIngress.PROBE_PREFIX.length()))));
    }

    Mono<Void> chat(WebSocketSession session, PublicIngress.Permit permit) {
        return Mono.using(() -> receive(session), input -> {
            AtomicBoolean started = new AtomicBoolean();
            AtomicBoolean infer = new AtomicBoolean();
            Flux<Object> records = input.first.asMono().timeout(Duration.ofSeconds(5)).takeUntilOther(permit.ended())
                    .switchIfEmpty(Mono.error(PublicIngress.unavailable())).publishOn(scheduler)
                    .flatMapMany(bytes -> decode(bytes, permit, infer))
                    .takeUntil(GuestSocket::done)
                    .doOnNext(ignored -> started.set(true))
                    .onErrorResume(error -> {
                        var failure = GuestServer.failure(error);
                        if (!started.get()) return Flux.just(new Error("error", failure.status().value(),
                                failure.retryAfter() > 0 ? failure.retryAfter() : null));
                        return Flux.just(infer.get() ? Api.InferRecord.error(failure.detail()) : Api.ChatChunk.error(failure.detail()));
                    });
            return session.send(records.takeUntilOther(input.closed.asMono())
                    .map(record -> session.textMessage(json.writeValueAsString(record))))
                    .then(Mono.defer(session::close));
        }, Input::dispose);
    }

    private static boolean done(Object record) {
        return record instanceof Api.ChatChunk chunk ? chunk.done()
                : record instanceof Api.InferRecord infer && infer.done();
    }

    /** Exactly {@code key} plus either {@code request} (chat) or {@code infer} (opaque inference). */
    private Flux<Object> decode(byte[] bytes, PublicIngress.Permit permit, AtomicBoolean infer) {
        try {
            var envelope = json.readTree(bytes);
            if (envelope == null || !envelope.isObject() || envelope.size() != 2
                    || !envelope.hasNonNull("key") || !envelope.get("key").isString()) throw invalid();
            boolean inference = envelope.hasNonNull("infer");
            var body = envelope.get(inference ? "infer" : "request");
            if (body == null || !body.isObject()) throw invalid();
            String key = envelope.get("key").asString();
            if (key.isEmpty() || key.length() > 256) throw invalid();
            sharing.authenticate(key, permit); // No model lookup for unauthenticated uploads.
            if (json.writeValueAsBytes(body).length > BackendConfiguration.MAX_BODY_BYTES)
                throw new GatewayException(HttpStatus.PAYLOAD_TOO_LARGE, "The request exceeds 262144 bytes.");
            if (inference) {
                infer.set(true);
                return sharing.infer(key, json.treeToValue(body, Api.InferRequest.class), permit).cast(Object.class);
            }
            return sharing.chat(key, json.treeToValue(body, Api.ChatRequest.class), permit).cast(Object.class);
        } catch (JacksonException error) {
            return Flux.error(invalid());
        }
    }

    private Mono<Void> send(WebSocketSession session, Flux<?> records) {
        return Mono.using(() -> receive(session), input -> session.send(records
                .takeUntilOther(input.closed.asMono())
                .map(record -> session.textMessage(json.writeValueAsString(record))))
                .then(Mono.defer(session::close)), Input::dispose);
    }

    private static Input receive(WebSocketSession session) {
        Input input = new Input();
        session.receive().subscribe(input);
        return input;
    }

    private static GatewayException invalid() { return new GatewayException(HttpStatus.BAD_REQUEST, "Invalid client request."); }

    @JsonInclude(JsonInclude.Include.ALWAYS)
    private record Error(String type, int status, Integer retryAfter) {}

    /**
     * Never use receive().next()/take(1): cancelling Reactor Netty inbound can close the channel.
     * Keep exactly one receiver until sending (including close) finishes; retain only the first
     * bounded message and synchronously discard all later messages without scheduling or queuing.
     * Spring's Reactor session bounds both frames and aggregated fragmented messages to the spec limit.
     * Spring 7.0.9 wraps without retaining; Reactor Netty 1.3.7 releases each frame after onNext.
     * Copy before returning and never retain or release the borrowed payload here.
     */
    private static final class Input extends BaseSubscriber<WebSocketMessage> {
        final Sinks.One<byte[]> first = Sinks.one();
        final Sinks.One<Boolean> closed = Sinks.one();
        boolean received;
        @Override protected void hookOnSubscribe(org.reactivestreams.Subscription subscription) { request(1); }
        @Override protected void hookOnNext(WebSocketMessage message) {
            if (!received) {
                received = true;
                if (message.getType() != WebSocketMessage.Type.TEXT) first.tryEmitError(invalid());
                else if (message.getPayload().readableByteCount() > MAX_ENVELOPE_BYTES) first.tryEmitError(invalid());
                else {
                    byte[] bytes = new byte[message.getPayload().readableByteCount()];
                    message.getPayload().read(bytes);
                    first.tryEmitValue(bytes);
                }
            }
            request(1);
        }
        @Override protected void hookOnComplete() { closed.tryEmitValue(true); }
        @Override protected void hookOnError(Throwable error) { closed.tryEmitValue(true); }
    }
}
