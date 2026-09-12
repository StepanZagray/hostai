package com.hostai.backend;

import static org.assertj.core.api.Assertions.assertThat;

import io.netty.handler.codec.http.HttpMethod;
import jakarta.validation.Validation;
import jakarta.validation.ValidatorFactory;
import java.net.URI;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.HttpHeaders;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Scheduler;
import reactor.core.scheduler.Schedulers;
import reactor.netty.http.client.HttpClient;
import reactor.netty.http.client.WebsocketClientSpec;
import reactor.netty.resources.LoopResources;
import tools.jackson.databind.json.JsonMapper;

/** The internet channel: infer envelopes over the WebSocket and model-UI files behind the tunnel origin. */
class ModelUiSocketTest {
    static final URI PUBLIC = GuestSocketTest.PUBLIC;
    static final Duration WAIT = GuestSocketTest.WAIT;
    static final JsonMapper JSON = GuestSocketTest.JSON;
    @TempDir Path temporary;
    GuestSocketTest.Assets assets;
    SharingRuntimeStub ollama;
    HostAiRuntimeStub hostai;
    LoopResources loops;
    Scheduler scheduler;
    ValidatorFactory validators;
    InferenceRegistry registry;
    SharingService sharing;
    GuestServer server;
    PublicIngress ingress;
    SharingService.Invite invite;
    final List<GuestSocketTest.Socket> sockets = new ArrayList<>();

    @BeforeEach void prepare() throws Exception {
        assets = new GuestSocketTest.Assets(temporary);
        ollama = new SharingRuntimeStub();
        hostai = new HostAiRuntimeStub();
        loops = LoopResources.create("model-ui-socket-client", 1, true);
        scheduler = Schedulers.newBoundedElastic(2, 100, "model-ui-socket-test");
        validators = Validation.buildDefaultValidatorFactory();
        registry = new InferenceRegistry();
        var catalog = new RuntimeCatalog(List.of(
                new RuntimeCatalog.Origin(ollama.origin(), BackendConfiguration.runtimeClient(LocalOllamaEndpoint.parse(ollama.origin()))),
                new RuntimeCatalog.Origin(hostai.origin(), BackendConfiguration.runtimeClient(LocalOllamaEndpoint.parse(hostai.origin())))),
                scheduler, WAIT, Duration.ofSeconds(60), Duration.ofMinutes(2));
        var internet = org.mockito.Mockito.mock(InternetSharing.class);
        org.mockito.Mockito.when(internet.publicOrigin()).thenReturn(PUBLIC);
        sharing = new SharingService(catalog, new ChatService(registry, catalog), validators.getValidator(), JSON,
                scheduler, temporary.resolve("access"), 0, Clock.systemUTC(), internet);
        sharing.start(HostAiRuntimeStub.MODEL, "Fixture host").block(WAIT);
        ingress = new PublicIngress(); ingress.announced(PUBLIC); ingress.verified();
        server = GuestServer.start(sharing, JSON, scheduler, 0, ingress);
        invite = sharing.create("Remote fixture", 1, "internet");
    }

    @Test void inferEnvelopeStreamsInferRecordsAndChatEnvelopeToAUiModelFails() {
        hostai.infer = HostAiRuntimeStub.Infer.NDJSON;
        var socket = connect();
        socket.text(inferEnvelope(invite.token(), "{\"model\":\"pebby:latest\",\"input\":{\"board\":[[0,1]]}}"));
        socket.ended();
        assertThat(socket.frames).hasSize(2);
        assertThat(socket.json(0).get("event").get("step").asInt()).isEqualTo(1);
        assertThat(socket.json(0).get("done").asBoolean()).isFalse();
        assertThat(socket.json(1).get("done").asBoolean()).isTrue();
        assertThat(socket.json(1).get("event").get("step").asInt()).isEqualTo(2);
        assertThat(hostai.infers.get()).isEqualTo(1);
        assertThat(JSON.readTree(hostai.lastInferBody.get()).get("input").get("board").get(0).get(1).asInt()).isEqualTo(1);
        hostai.infer = HostAiRuntimeStub.Infer.NDJSON_ERROR;
        var failed = connect();
        failed.text(inferEnvelope(invite.token(), "{\"model\":\"pebby:latest\",\"input\":null}"));
        failed.ended();
        assertThat(failed.frames).hasSize(2);
        assertThat(failed.json(1).get("done").asBoolean()).isTrue();
        assertThat(failed.json(1).get("error").asString()).isEqualTo("bad thing");
        var chat = connect();
        chat.text(GuestSocketTest.envelope(invite.token()).replace("fixture-shared:small", "pebby:latest"));
        chat.ended();
        assertThat(chat.frames).hasSize(1);
        assertThat(chat.json(0).get("type").asString()).isEqualTo("error");
        assertThat(chat.json(0).get("status").asInt()).isEqualTo(400);
        assertThat(ollama.chats.get()).isZero();
    }

    @Test void malformedInferEnvelopesNeverReachTheRuntime() {
        for (String body : List.of(
                "{\"key\":\"" + invite.token() + "\",\"infer\":{\"model\":\"pebby:latest\",\"input\":1},\"request\":{}}",
                "{\"key\":\"" + invite.token() + "\",\"infer\":[]}",
                "{\"key\":\"" + invite.token() + "\",\"infer\":{\"model\":\"pebby:latest\"}}",
                "{\"key\":\"" + invite.token() + "\",\"infer\":{\"model\":\"pebby:latest\",\"input\":1,\"extra\":true}}",
                "{\"key\":\"" + invite.token() + "\",\"infer\":{\"model\":\"fixture-shared:small\",\"input\":1}}",
                inferEnvelope("invalid", "{\"model\":\"pebby:latest\",\"input\":1}"))) {
            var socket = connect();
            socket.text(body);
            socket.ended();
            assertThat(socket.frames).as(body).hasSize(1);
            assertThat(socket.json(0).get("type").asString()).isEqualTo("error");
            assertThat(socket.json(0).get("status").asInt()).isIn(400, 401, 403);
        }
        assertThat(hostai.infers.get()).isZero();
    }

    @Test void hostAiChatCapabilityWorksOnThePublicWebSocketChannel() {
        hostai.manifestBody = HostAiRuntimeStub.MANIFEST.replace("\"vendor\":\"ignored\"",
                "\"capabilities\":{\"chat\":true,\"infer\":false}");
        var session = sharing.session(invite.token(), ingress.permit()).block(WAIT);
        assertThat(session.available()).isTrue();
        assertThat(session.ui()).isNull();
        assertThat(session.capabilities()).isEqualTo(Api.Capabilities.CHAT);
        var socket = connect();
        socket.text(GuestSocketTest.envelope(invite.token()).replace("fixture-shared:small", "pebby:latest"));
        socket.ended();
        assertThat(socket.frames).hasSize(2);
        assertThat(socket.json(0).get("content").asString()).isEqualTo("Hello from runtime");
        assertThat(socket.json(1).get("done").asBoolean()).isTrue();
        assertThat(hostai.chats.get()).isEqualTo(1);
        assertThat(ollama.chats.get()).isZero();
    }

    @Test void modelUiOnTheInternetChannelUsesTheTunnelOriginAndRequiresTheChannelHeaders() {
        var response = client().get().uri(server.origin() + "/guest/v1/model-ui/pebby/ui/index.html")
                .responseSingle((head, body) -> body.asString().defaultIfEmpty("").map(text -> Map.entry(head, text))).block(WAIT);
        assertThat(response.getKey().status().code()).isEqualTo(200);
        assertThat(response.getValue()).contains("hostai-bridge.js");
        var headers = response.getKey().responseHeaders();
        assertThat(headers.get("Content-Type")).isEqualTo("text/html;charset=utf-8");
        assertThat(headers.get("Content-Security-Policy")).isEqualTo(ModelUiAssets.csp(PUBLIC.toString()));
        assertThat(headers.contains("X-Frame-Options")).isFalse();
        assertThat(headers.get("Strict-Transport-Security")).isEqualTo("max-age=86400");
        assertThat(headers.get("Cache-Control")).isEqualTo("no-store");
        var bridge = client().get().uri(server.origin() + "/guest/v1/model-ui/pebby/ui/hostai-bridge.js")
                .responseSingle((head, body) -> body.asString().map(text -> Map.entry(head, text))).block(WAIT);
        assertThat(bridge.getKey().status().code()).isEqualTo(200);
        assertThat(bridge.getValue()).contains("window.hostai");
        assertThat(client().headers(h -> h.remove(PublicIngress.HEADER)).get().uri(server.origin() + "/guest/v1/model-ui/pebby/ui/index.html")
                .response().block(WAIT).status().code()).isEqualTo(403);
        assertThat(client().request(HttpMethod.POST).uri(server.origin() + "/guest/v1/infer")
                .send(reactor.netty.ByteBufFlux.fromString(Mono.just("{}"))).response().block(WAIT).status().code()).isEqualTo(409);
        assertThat(hostai.assetPaths).containsExactly("/ui/index.html");
    }

    HttpClient client() {
        return HttpClient.newConnection().runOn(loops).followRedirect(false).disableRetry(true)
                .headers(h -> h.set(HttpHeaders.HOST, PUBLIC.getHost()).set(PublicIngress.HEADER, ingress.secret())
                        .set(HttpHeaders.ORIGIN, PUBLIC.toString()));
    }
    GuestSocketTest.Socket connect() {
        var socket = new GuestSocketTest.Socket(client().websocket(WebsocketClientSpec.builder().maxFramePayloadLength(300_000).build())
                .uri(server.origin().replace("http:", "ws:") + GuestSocket.CHAT_PATH).connect().block(WAIT));
        sockets.add(socket); return socket;
    }
    static String inferEnvelope(String key, String infer) { return "{\"key\":" + JSON.writeValueAsString(key) + ",\"infer\":" + infer + "}"; }

    @AfterEach void close() throws Exception {
        sockets.forEach(GuestSocketTest.Socket::close);
        try {
            if (ingress != null) ingress.close();
            if (server != null) server.close();
            if (sharing != null) sharing.close();
            if (ollama != null) ollama.close();
            if (hostai != null) hostai.close();
            if (scheduler != null) scheduler.dispose();
            if (validators != null) validators.close();
            if (loops != null) loops.disposeLater(Duration.ZERO, Duration.ofSeconds(5)).block(WAIT);
        } finally { if (assets != null) assets.close(); }
    }
}
