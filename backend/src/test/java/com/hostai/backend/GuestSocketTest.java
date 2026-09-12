package com.hostai.backend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import io.netty.handler.codec.http.websocketx.BinaryWebSocketFrame;
import io.netty.handler.codec.http.websocketx.TextWebSocketFrame;
import io.netty.handler.codec.http.websocketx.WebSocketClientHandshakeException;
import io.netty.handler.codec.http.websocketx.WebSocketFrame;
import io.netty.resolver.AbstractAddressResolver;
import io.netty.resolver.AddressResolver;
import io.netty.resolver.AddressResolverGroup;
import io.netty.util.concurrent.EventExecutor;
import io.netty.util.concurrent.Promise;
import jakarta.validation.Validation;
import jakarta.validation.ValidatorFactory;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.http.HttpHeaders;
import reactor.core.Disposable;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Scheduler;
import reactor.core.scheduler.Schedulers;
import reactor.netty.Connection;
import reactor.netty.http.client.HttpClient;
import reactor.netty.http.client.WebsocketClientSpec;
import reactor.netty.http.websocket.WebsocketInbound;
import reactor.netty.http.websocket.WebsocketOutbound;
import reactor.netty.resources.LoopResources;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

class GuestSocketTest {
    static final URI PUBLIC = URI.create("https://fixture-only.trycloudflare.com");
    static final Duration WAIT = Duration.ofSeconds(8);
    static final JsonMapper JSON = JsonMapper.builder().build();
    @TempDir Path temporary;
    SharingRuntimeStub runtime;
    Scheduler scheduler;
    ValidatorFactory validators;
    InferenceRegistry registry;
    SharingService sharing;
    GuestServer server;
    PublicIngress ingress;
    SharingService.Invite invite;
    LoopResources loops;
    final List<Socket> sockets = new ArrayList<>();
    final TestClock clock = new TestClock();
    Assets assets;

    @BeforeEach void prepare() throws Exception {
        assets = new Assets(temporary);
        runtime = new SharingRuntimeStub();
        loops = LoopResources.create("guest-socket-client", 1, true);
        scheduler = Schedulers.newBoundedElastic(2, 100, "guest-socket-test");
        validators = Validation.buildDefaultValidatorFactory();
        registry = new InferenceRegistry();
        var gateway = RuntimeCatalog.single(BackendConfiguration.runtimeClient(LocalOllamaEndpoint.parse(runtime.origin())),
                scheduler, WAIT, Duration.ofSeconds(60), Duration.ofMinutes(2));
        var internet = org.mockito.Mockito.mock(InternetSharing.class);
        org.mockito.Mockito.when(internet.publicOrigin()).thenReturn(PUBLIC);
        sharing = new SharingService(gateway, new ChatService(registry, gateway), validators.getValidator(), JSON,
                scheduler, temporary.resolve("access"), 0, clock, internet);
        sharing.start("fixture-shared:small", "Fixture host").block(WAIT);
        ingress = new PublicIngress(); ingress.announced(PUBLIC); ingress.verified();
        server = GuestServer.start(sharing, JSON, scheduler, 0, ingress);
        invite = sharing.create("Remote fixture", 1, "internet");
    }

    @Test void authenticatedSocketStreamsSeparateChunksThenClosesAndLocalHttpStillWorks() {
        runtime.records = Flux.concat(Flux.just("{\"message\":{\"content\":\"first\"},\"done\":false}\n"),
                Mono.delay(Duration.ofMillis(150)).thenReturn("{\"message\":{\"content\":\"last\"},\"done\":true,\"eval_count\":4}\n"));
        var socket = connect(PUBLIC.toString());
        socket.text(envelope(invite.token()));
        socket.ended();
        assertThat(socket.frames).hasSize(2);
        assertThat(socket.json(0).get("content").asString()).isEqualTo("first");
        assertThat(socket.json(1).get("done").asBoolean()).isTrue();
        assertThat(socket.json(1).get("outputTokens").asInt()).isEqualTo(4);
        assertThat(runtime.chats.get()).isEqualTo(1);
        var local = sharing.create("Local fixture", 1);
        assertThat(http(sharing.status().guestUrl(), "/guest/v1/chat", local.token(), "POST")).isEqualTo(200);
        assertThat(http(server.origin(), "/guest/v1/chat", invite.token(), "POST")).isEqualTo(409);
        assertThat(runtime.chats.get()).isEqualTo(2);
    }

    @Test void invalidEnvelopesAndSecondFramesCannotStartInference() {
        int metadata = runtime.metadata.get();
        for (String body : List.of("", "null", "[]", "{}", "{", "{\"key\":\"x\"}",
                envelope(""), envelope("x".repeat(257)), envelope("invalid"),
                "{\"key\":5,\"request\":" + requestJson() + "}",
                envelope(invite.token()).replace("\"key\":", "\"extra\":0,\"key\":"),
                envelope(invite.token()) + "{}",
                envelope(invite.token()).replace("\"key\":", "\"key\":\"duplicate\",\"key\":"))) {
            var socket = connect(null);
            socket.text(body);
            socket.textIfOpen(envelope(invite.token()));
            socket.ended();
            assertThat(socket.frames).hasSize(1);
            assertThat(socket.json(0).get("type").asString()).isEqualTo("error");
            assertThat(socket.json(0).get("status").asInt()).isIn(400, 401);
            assertThat(socket.json(0).size()).isEqualTo(3);
            assertThat(socket.json(0).get("retryAfter").isNull()).isTrue();
        }
        assertThat(runtime.chats.get()).isZero();
        assertThat(runtime.metadata.get()).isEqualTo(metadata);
    }

    @Test void binaryOversizedFragmentedAndSilentUploadsAreBounded() {
        var binary = connect(null);
        binary.send(new BinaryWebSocketFrame(io.netty.buffer.Unpooled.wrappedBuffer(new byte[] {1, 2})));
        binary.ended(); assertThat(binary.json(0).get("status").asInt()).isEqualTo(400);
        var huge = connect(null);
        huge.text("x".repeat(GuestSocket.MAX_ENVELOPE_BYTES + 1));
        huge.ended(); assertThat(huge.frames).isEmpty();
        var fragmented = connect(null);
        fragmented.send(new TextWebSocketFrame(false, 0, "x".repeat(140_000)));
        fragmented.send(new io.netty.handler.codec.http.websocketx.ContinuationWebSocketFrame(true, 0, "x".repeat(140_000)));
        fragmented.ended(); assertThat(fragmented.frames).isEmpty();
        var silent = connect(null);
        long before = System.nanoTime(); silent.ended();
        assertThat(Duration.ofNanos(System.nanoTime() - before)).isBetween(Duration.ofSeconds(4), Duration.ofSeconds(7));
        assertThat(silent.json(0).get("status").asInt()).isEqualTo(408);
        silent.textIfOpen(envelope(invite.token()));
        assertThat(runtime.chats.get()).isZero();
    }

    @Test void strictRequestLimitsAndModelPermissionsApplyBeforeInference() {
        for (String request : List.of(requestJson().replace("128", "1025"), requestJson().replace("0.7", "0.5,\"unknown\":1"),
                requestJson().replace("128", "1.5"), requestJson().replace("128", "null"),
                requestJson().replace("Fixture prompt", "x".repeat(16_385)),
                requestJson().replace("fixture-shared:small", "private-owner:small"),
                requestJson().replace("Fixture prompt", "x".repeat(262_100)))) {
            var socket = connect(null);
            socket.text("{\"key\":\"" + invite.token() + "\",\"request\":" + request + "}");
            socket.ended();
            assertThat(socket.json(0).get("status").asInt()).isIn(400, 403, 413);
        }
        assertThat(runtime.chats.get()).isZero();
    }

    @Test void channelHostOriginCredentialsAndOwnerRoutesAreSeparated() {
        var local = sharing.create("Local visitor", 1);
        var socket = connect(null); socket.text(envelope(local.token())); socket.ended();
        assertThat(socket.json(0).get("status").asInt()).isEqualTo(401);
        assertThat(http(sharing.status().guestUrl(), "/guest/v1/chat", invite.token(), "POST")).isEqualTo(401);
        for (String origin : List.of("https://attacker.example", "null", "http://fixture-only.trycloudflare.com",
                PUBLIC + "/", PUBLIC + ":443", PUBLIC + ".attacker.example"))
            rejected(client().headers(h -> h.set(HttpHeaders.ORIGIN, origin)), server.origin(), GuestSocket.CHAT_PATH, 403);
        rejected(client().headers(h -> h.add(HttpHeaders.ORIGIN, PUBLIC.toString()).add(HttpHeaders.ORIGIN, PUBLIC.toString())), server.origin(), GuestSocket.CHAT_PATH, 403);
        rejected(client().headers(h -> h.remove(PublicIngress.HEADER)), server.origin(), GuestSocket.CHAT_PATH, 403);
        rejected(client().headers(h -> h.set(HttpHeaders.HOST, "attacker.example").set("X-Forwarded-Host", PUBLIC.getHost())), server.origin(), GuestSocket.CHAT_PATH, 403);
        for (String header : List.of(HttpHeaders.AUTHORIZATION, HttpHeaders.COOKIE, "Sec-WebSocket-Protocol"))
            rejected(client().headers(h -> h.set(header, "credential-fixture")), server.origin(), GuestSocket.CHAT_PATH, 400);
        rejected(client(), server.origin(), GuestSocket.CHAT_PATH + "?key=fixture", 400);
        for (String path : List.of("/api/chat", "/api/sharing", "/api/sharing/stop", "/actuator/health", "/api/models", "/guest/v1/reachability/unknown"))
            rejected(client(), server.origin(), path, 404);
        rejected(HttpClient.newConnection().runOn(loops), sharing.status().guestUrl(), GuestSocket.CHAT_PATH, 404);
        assertThat(runtime.chats.get()).isZero();
    }

    @Test void reachabilityLossBeforeTheFirstEnvelopeReturnsUnavailableWithoutInference() {
        var socket = connect(null);
        ingress.interrupted();
        socket.ended();
        assertThat(socket.frames).hasSize(1);
        assertThat(socket.json(0).get("type").asString()).isEqualTo("error");
        assertThat(socket.json(0).get("status").asInt()).isEqualTo(503);
        assertThat(runtime.chats.get()).isZero();
        released();
    }

    @Test void extraInputCannotMultiplexAndBusyAndUnavailableErrorsStayStructured() {
        runtime.records = SharingRuntimeStub.hold();
        var active = connect(null); active.text(envelope(invite.token())); active.records(1);
        for (int i = 0; i < 32; i++) active.text(envelope(invite.token()));
        var busy = connect(null); busy.text(envelope(invite.token())); busy.ended();
        assertThat(busy.json(0).get("status").asInt()).isEqualTo(429);
        assertThat(busy.json(0).get("retryAfter").asInt()).isEqualTo(1);
        assertThat(runtime.chats.get()).isEqualTo(1);
        active.close(); released();
        runtime.available = false;
        var unavailable = connect(null); unavailable.text(envelope(invite.token())); unavailable.ended();
        assertThat(unavailable.json(0).get("status").asInt()).isEqualTo(503);
        assertThat(runtime.chats.get()).isEqualTo(1);
    }

    @ParameterizedTest @ValueSource(strings = {"disconnect-before", "disconnect-mid", "close-before", "close-mid", "revoke-before", "revoke-mid", "stop-before", "stop-mid", "expiry-before", "expiry-mid", "reachability-before", "reachability-mid"})
    void socketAndAccessLifetimeCancelExchangeAndReleaseAdmission(String scenario) {
        boolean before = scenario.endsWith("before");
        if (scenario.startsWith("expiry")) clock.now = clock.now.plusSeconds(3599);
        runtime.records = before ? Flux.never() : SharingRuntimeStub.hold();
        var socket = connect(null); socket.text(envelope(invite.token()));
        await().atMost(WAIT).untilAsserted(() -> {
            assertThat(runtime.chats.get()).isEqualTo(1);
            assertThat(registry.counters().activeRequests()).isEqualTo(1);
        });
        if (!before) socket.records(1);
        if (scenario.startsWith("disconnect")) socket.close();
        else if (scenario.startsWith("close")) socket.send(new io.netty.handler.codec.http.websocketx.CloseWebSocketFrame(1000, ""));
        else if (scenario.startsWith("revoke")) sharing.revoke(invite.grant().id());
        else if (scenario.startsWith("stop")) sharing.stop();
        else if (scenario.startsWith("reachability")) ingress.interrupted();
        socket.ended(); released();
        if (scenario.startsWith("revoke") || scenario.startsWith("expiry")) {
            if (before) assertThat(socket.json(0).get("status").asInt()).isEqualTo(401);
            else assertThat(socket.json(1).get("error").asString()).contains("Client access ended");
        }
        // A subsequent real request proves both SharingService's slot and the runtime lease were released.
        if (scenario.startsWith("stop")) sharing.start("fixture-shared:small", "Fixture host").block(WAIT);
        if (scenario.startsWith("reachability")) ingress.verified();
        runtime.records = SharingRuntimeStub.complete();
        var replacement = sharing.create("Replacement visitor", 1, "internet");
        var next = connect(null); next.text(envelope(replacement.token())); next.ended();
        assertThat(next.json(0).get("done").asBoolean()).isTrue();
        assertThat(runtime.chats.get()).isEqualTo(2);
    }

    @Test void runtimeFailureBeforeAndAfterFirstRecordUsesTheExistingErrorPolicy() {
        runtime.records = Flux.just("{\"error\":\"private upstream detail\"}\n");
        var before = connect(null); before.text(envelope(invite.token())); before.ended();
        assertThat(before.json(0).get("status").asInt()).isEqualTo(502);
        runtime.records = Flux.just("{\"message\":{\"content\":\"partial\"},\"done\":false}\n", "{\"error\":\"private upstream detail\"}\n");
        var after = connect(null); after.text(envelope(invite.token())); after.ended();
        assertThat(after.frames).hasSize(2);
        assertThat(after.json(1).get("done").asBoolean()).isTrue();
        assertThat(after.frames.toString()).doesNotContain("private upstream detail");
    }

    HttpClient client() {
        return HttpClient.newConnection().runOn(loops).followRedirect(false).disableRetry(true)
                .headers(h -> h.set(HttpHeaders.HOST, PUBLIC.getHost()).set(PublicIngress.HEADER, ingress.secret())
                        .set(HttpHeaders.ORIGIN, PUBLIC.toString()));
    }
    Socket connect(String origin) {
        HttpClient client = client();
        if (origin != null) client = client.headers(h -> h.set(HttpHeaders.ORIGIN, origin));
        var socket = new Socket(client.websocket(WebsocketClientSpec.builder().maxFramePayloadLength(300_000).build())
                .uri(server.origin().replace("http:", "ws:") + GuestSocket.CHAT_PATH).connect().block(WAIT));
        sockets.add(socket); return socket;
    }
    static void rejected(HttpClient client, String origin, String path, int status) {
        assertThatThrownBy(() -> client.websocket().uri(origin.replace("http:", "ws:") + path).connect().block(WAIT))
                .isInstanceOfSatisfying(WebSocketClientHandshakeException.class,
                        error -> assertThat(error.response().status().code()).isEqualTo(status));
    }
    int http(String origin, String path, String token, String method) {
        return (origin.equals(server.origin()) ? client() : HttpClient.newConnection().runOn(loops))
                .headers(h -> h.set(HttpHeaders.AUTHORIZATION, "Bearer " + token).set(HttpHeaders.CONTENT_TYPE, "application/json"))
                .request(io.netty.handler.codec.http.HttpMethod.valueOf(method)).uri(origin + path)
                .send(reactor.netty.ByteBufFlux.fromString(Mono.just(requestJson())))
                .responseSingle((response, body) -> body.thenReturn(response.status().code())).block(WAIT);
    }
    static String requestJson() { return JSON.writeValueAsString(Map.of("model", "fixture-shared:small", "messages", List.of(Map.of("role", "user", "content", "Fixture prompt")), "temperature", 0.7, "maxTokens", 128)); }
    static String envelope(String key) { return "{\"key\":" + JSON.writeValueAsString(key) + ",\"request\":" + requestJson() + "}"; }
    void released() { await().atMost(WAIT).untilAsserted(() -> { assertThat(registry.counters().activeRequests()).isZero(); assertThat(runtime.connections.get()).isZero(); }); }

    @AfterEach void close() throws Exception {
        sockets.forEach(Socket::close);
        try {
            if (ingress != null) ingress.close();
            if (server != null) server.close();
            if (sharing != null) sharing.close();
            if (runtime != null) {
                if (registry != null) released();
                runtime.close();
            }
            if (scheduler != null) scheduler.dispose();
            if (validators != null) validators.close();
            if (loops != null) loops.disposeLater(Duration.ZERO, Duration.ofSeconds(5)).block(WAIT);
        } finally { if (assets != null) assets.close(); }
    }

    static final class Socket implements AutoCloseable {
        final Connection connection;
        final Disposable receiver;
        final List<String> frames = new CopyOnWriteArrayList<>();
        Socket(Connection connection) {
            this.connection = connection;
            receiver = ((WebsocketInbound) connection).aggregateFrames(300_000).receiveFrames()
                    .subscribe(frame -> { if (frame instanceof TextWebSocketFrame text) frames.add(text.text()); }, ignored -> {});
        }
        void text(String text) { send(new TextWebSocketFrame(text)); }
        void textIfOpen(String text) { if (!connection.isDisposed()) { try { text(text); } catch (RuntimeException ignored) {} } }
        void send(WebSocketFrame frame) { ((WebsocketOutbound) connection).sendObject(Mono.just(frame)).then().block(WAIT); }
        JsonNode json(int index) { return JSON.readTree(frames.get(index)); }
        void records(int count) { await().atMost(WAIT).untilAsserted(() -> assertThat(frames).hasSize(count)); }
        void ended() { connection.onDispose().block(WAIT); }
        @Override public void close() { connection.dispose(); connection.onDispose().block(WAIT); receiver.dispose(); }
    }

    /** Private classpath page fixture: backend exchanges need no frontend build or user storage. */
    static final class Assets implements AutoCloseable {
        final ClassLoader previous = Thread.currentThread().getContextClassLoader();
        final URLClassLoader loader;
        Assets(Path temporary) throws Exception {
            Path root = Files.createDirectory(temporary.resolve("classpath"));
            Files.createDirectory(root.resolve("guest"));
            Files.writeString(root.resolve("guest/guest.html"), "<!doctype html><title>Guest test fixture</title>");
            loader = new URLClassLoader(new java.net.URL[] {root.toUri().toURL()}, previous);
            Thread.currentThread().setContextClassLoader(loader);
        }
        @Override public void close() throws Exception { Thread.currentThread().setContextClassLoader(previous); loader.close(); }
    }

    static final class TestClock extends Clock {
        volatile Instant now = Instant.now();
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
    }

    /** Resolves only the canonical fixture name, with its original hostname retained for TLS verification. */
    static AddressResolverGroup<InetSocketAddress> dns(int port) {
        return new AddressResolverGroup<>() {
            @Override protected AddressResolver<InetSocketAddress> newResolver(EventExecutor executor) {
                return new AbstractAddressResolver<>(executor, InetSocketAddress.class) {
                    @Override protected boolean doIsResolved(InetSocketAddress address) { return false; }
                    @Override protected void doResolve(InetSocketAddress address, Promise<InetSocketAddress> promise) {
                        if (!address.getHostString().equals(PUBLIC.getHost()) || address.getPort() != 443)
                            promise.setFailure(new java.net.UnknownHostException("Fixture DNS rejected request."));
                        else try { promise.setSuccess(new InetSocketAddress(java.net.InetAddress.getByAddress(PUBLIC.getHost(), new byte[] {127, 0, 0, 1}), port)); }
                        catch (java.net.UnknownHostException error) { promise.setFailure(error); }
                    }
                    @Override protected void doResolveAll(InetSocketAddress address, Promise<List<InetSocketAddress>> promise) {
                        var one = executor.<InetSocketAddress>newPromise();
                        doResolve(address, one);
                        if (one.isSuccess()) promise.setSuccess(List.of(one.getNow())); else promise.setFailure(one.cause());
                    }
                };
            }
        };
    }
}

/** Socket-free ownership checks complement, but do not replace, the loopback transport tests. */
class GuestSocketLifecycleTest {
    @TempDir Path temporary;

    @Test void receiveHasOneSubscriberAndStaysAliveUntilTheLastSendCompletes() {
        var fixture = new Lifecycle(temporary);
        var generation = reactor.core.publisher.Sinks.many().unicast().<Api.ChatChunk>onBackpressureBuffer();
        fixture.source = generation.asFlux();
        var flushed = reactor.core.publisher.Sinks.<Void>empty();
        fixture.flush = flushed.asMono();
        var operation = fixture.operation().subscribe();
        try {
            fixture.upload(GuestSocketTest.envelope("fixture"));
            assertThat(fixture.chats).hasValue(1);
            assertThat(fixture.receiverCancelled).isFalse();
            fixture.upload(GuestSocketTest.envelope("fixture"));
            fixture.upload("malformed extra command");
            assertThat(fixture.chats).hasValue(1);
            generation.tryEmitNext(new Api.ChatChunk("first", false, null, null));
            assertThat(fixture.output).hasSize(1);
            assertThat(fixture.receiverCancelled).isFalse();
            generation.tryEmitNext(new Api.ChatChunk("last", true, 4L, null));
            assertThat(fixture.output).hasSize(2);
            assertThat(fixture.receiveSubscribers).hasValue(1);
            assertThat(fixture.sourceCancelled).isTrue();
            assertThat(fixture.receiverCancelled).isFalse();
            assertThat(fixture.closed).isFalse();
            flushed.tryEmitEmpty();
            assertThat(fixture.receiverCancelled).isTrue();
            assertThat(fixture.closed).isTrue();
        } finally { operation.dispose(); }
    }

    @ParameterizedTest @ValueSource(booleans = {false, true})
    void disconnectCancelsTheGenerationEvenBeforeTheFirstRecord(boolean started) {
        var fixture = new Lifecycle(temporary);
        fixture.source = started ? Flux.concat(Flux.just(new Api.ChatChunk("first", false, null, null)), Flux.never()) : Flux.never();
        var operation = fixture.operation().subscribe();
        try {
            fixture.upload(GuestSocketTest.envelope("fixture"));
            assertThat(fixture.chats).hasValue(1);
            assertThat(fixture.output).hasSize(started ? 1 : 0);
            fixture.inbound.tryEmitComplete();
            assertThat(fixture.sourceCancelled).isTrue();
            assertThat(fixture.closed).isTrue();
        } finally { operation.dispose(); }
    }

    @Test void abandonedHandlerCancelsBothDirections() {
        var fixture = new Lifecycle(temporary);
        var operation = fixture.operation().subscribe();
        fixture.upload(GuestSocketTest.envelope("fixture"));
        operation.dispose();
        assertThat(fixture.sourceCancelled).isTrue();
        assertThat(fixture.receiverCancelled).isTrue();
    }

    @Test void firstMessageDeadlineDoesNotApplyToGenerationWaitingForItsFirstRecord() {
        var fixture = new Lifecycle(temporary);
        reactor.test.StepVerifier.withVirtualTime(fixture::operation)
                .then(() -> fixture.upload(GuestSocketTest.envelope("fixture")))
                .thenAwait(Duration.ofSeconds(61))
                .then(() -> {
                    assertThat(fixture.chats).hasValue(1);
                    assertThat(fixture.output).isEmpty();
                    assertThat(fixture.sourceCancelled).isFalse();
                }).thenCancel().verify(Duration.ofSeconds(2));
        assertThat(fixture.sourceCancelled).isTrue();
    }

    @Test void firstMessageTimeoutPreventsLateInferenceAndSendsASanitizedError() {
        var fixture = new Lifecycle(temporary);
        reactor.test.StepVerifier.withVirtualTime(fixture::operation).thenAwait(Duration.ofSeconds(5))
                .verifyComplete();
        fixture.upload(GuestSocketTest.envelope("fixture"));
        assertThat(fixture.chats).hasValue(0);
        assertThat(GuestSocketTest.JSON.readTree(fixture.output.getFirst()).get("status").asInt()).isEqualTo(408);
        assertThat(fixture.closed).isTrue();
    }

    @Test void strictUploadParsingAndSerializedRequestBoundFailBeforeChat() {
        for (String body : List.of("{}", GuestSocketTest.envelope("fixture") + "{}",
                GuestSocketTest.envelope("fixture").replace("\"key\":", "\"key\":\"duplicate\",\"key\":"),
                GuestSocketTest.envelope("fixture").replace("Fixture prompt", "x".repeat(262_100)),
                GuestSocketTest.envelope("fixture").replace("128", "1.5"),
                GuestSocketTest.envelope("wrong"))) {
            var fixture = new Lifecycle(temporary);
            var operation = fixture.operation().subscribe();
            try {
                fixture.upload(body);
                fixture.upload(GuestSocketTest.envelope("fixture"));
                assertThat(fixture.chats).hasValue(0);
                assertThat(fixture.output).hasSize(1);
                var error = GuestSocketTest.JSON.readTree(fixture.output.getFirst());
                assertThat(error.get("status").asInt()).isIn(400, 401, 413);
                assertThat(error.size()).isEqualTo(3);
                assertThat(error.get("retryAfter").isNull()).isTrue();
            } finally { operation.dispose(); }
        }
    }

    @Test void prestreamErrorStatusAndRetryMetadataShareTheHttpPolicy() {
        for (Throwable error : List.of(new SharingService.GuestBusyException(7), GatewayException.unavailable(),
                new GatewayException(org.springframework.http.HttpStatus.BAD_REQUEST, "Fixed validation detail"),
                new ChatService.AccessEndedException(), new IllegalStateException("private failure detail"))) {
            var fixture = new Lifecycle(temporary);
            fixture.source = Flux.error(error);
            var operation = fixture.operation().subscribe();
            try {
                fixture.upload(GuestSocketTest.envelope("fixture"));
                assertThat(fixture.output).hasSize(1);
                var frame = GuestSocketTest.JSON.readTree(fixture.output.getFirst());
                assertThat(frame.get("status").asInt()).isEqualTo(GuestServer.failure(error).status().value());
                if (error instanceof SharingService.GuestBusyException) assertThat(frame.get("retryAfter").asInt()).isEqualTo(7);
                else assertThat(frame.get("retryAfter").isNull()).isTrue();
                assertThat(fixture.output.getFirst()).doesNotContain("detail", "message", "body");
            } finally { operation.dispose(); }
        }
    }

    static final class Lifecycle {
        final reactor.core.publisher.Sinks.Many<org.springframework.web.reactive.socket.WebSocketMessage> inbound =
                reactor.core.publisher.Sinks.many().multicast().directBestEffort();
        final List<String> output = new ArrayList<>();
        final AtomicInteger receiveSubscribers = new AtomicInteger();
        final AtomicInteger chats = new AtomicInteger();
        final java.util.concurrent.atomic.AtomicBoolean receiverCancelled = new java.util.concurrent.atomic.AtomicBoolean();
        final java.util.concurrent.atomic.AtomicBoolean sourceCancelled = new java.util.concurrent.atomic.AtomicBoolean();
        final java.util.concurrent.atomic.AtomicBoolean closed = new java.util.concurrent.atomic.AtomicBoolean();
        final org.springframework.web.reactive.socket.WebSocketSession session;
        final GuestSocket socket;
        Flux<Api.ChatChunk> source = Flux.never();
        Mono<Void> flush = Mono.empty();

        Lifecycle(Path temporary) {
            var buffers = org.springframework.core.io.buffer.DefaultDataBufferFactory.sharedInstance;
            session = (org.springframework.web.reactive.socket.WebSocketSession) java.lang.reflect.Proxy.newProxyInstance(
                    getClass().getClassLoader(), new Class<?>[] {org.springframework.web.reactive.socket.WebSocketSession.class}, (proxy, method, args) -> {
                        return switch (method.getName()) {
                            case "receive" -> inbound.asFlux().doOnSubscribe(ignored -> receiveSubscribers.incrementAndGet())
                                    .doOnCancel(() -> receiverCancelled.set(true));
                            case "send" -> Flux.from((org.reactivestreams.Publisher<?>) args[0]).doOnNext(message -> {
                                assertThat(receiverCancelled).isFalse();
                                output.add(((org.springframework.web.reactive.socket.WebSocketMessage) message).getPayloadAsText());
                            }).then(Mono.defer(() -> flush));
                            case "close" -> Mono.fromRunnable(() -> closed.set(true));
                            case "textMessage" -> new org.springframework.web.reactive.socket.WebSocketMessage(
                                    org.springframework.web.reactive.socket.WebSocketMessage.Type.TEXT,
                                    buffers.wrap(((String) args[0]).getBytes(java.nio.charset.StandardCharsets.UTF_8)));
                            default -> throw new UnsupportedOperationException(method.getName());
                        };
                    });
            var json = GuestSocketTest.JSON.rebuild().enable(tools.jackson.core.StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                    .enable(tools.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                    .enable(tools.jackson.databind.DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                    .disable(tools.jackson.databind.DeserializationFeature.ACCEPT_FLOAT_AS_INT).build();
            SharingService sharing = org.mockito.Mockito.mock(SharingService.class);
            org.mockito.Mockito.when(sharing.authenticate(org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.any()))
                    .thenAnswer(invocation -> {
                        if (!invocation.<String>getArgument(0).equals("fixture")) throw SharingService.unauthorized();
                        return null;
                    });
            org.mockito.Mockito.when(sharing.chat(org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any()))
                    .thenAnswer(invocation -> {
                        chats.incrementAndGet();
                        return source.doOnCancel(() -> sourceCancelled.set(true));
                    });
            socket = new GuestSocket(sharing, json, Schedulers.immediate());
        }
        Mono<Void> operation() { return socket.chat(session, PublicIngress.Permit.LOCAL); }
        void upload(String text) { inbound.tryEmitNext(session.textMessage(text)); }
    }
}
