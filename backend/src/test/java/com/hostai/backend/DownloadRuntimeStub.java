package com.hostai.backend;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.netty.DisposableServer;
import reactor.netty.resources.LoopResources;
import tools.jackson.databind.json.JsonMapper;

/** Every download test runtime is a dedicated ephemeral loopback HTTP server. */
final class DownloadRuntimeStub implements AutoCloseable {
    private static final JsonMapper JSON = JsonMapper.builder().build();
    volatile Flux<String> records = Flux.never();
    volatile int status = 200;
    volatile boolean beforeHeaders;
    final AtomicInteger calls = new AtomicInteger();
    final AtomicInteger connections = new AtomicInteger();
    final AtomicInteger unexpectedCalls = new AtomicInteger();
    final AtomicReference<Map<?, ?>> body = new AtomicReference<>();
    final AtomicReference<String> contentType = new AtomicReference<>();
    final LoopResources loops = LoopResources.create("download-test-runtime", 1, true);
    final DisposableServer server;

    DownloadRuntimeStub() {
        try {
            server = reactor.netty.http.server.HttpServer.create()
            .host("127.0.0.1").port(0).runOn(loops)
            .route(routes -> routes.post("/api/pull", (request, response) -> {
                connections.incrementAndGet();
                request.withConnection(connection -> connection.onDispose()
                        .doFinally(ignored -> connections.decrementAndGet()).subscribe());
                return request.receive().aggregate().asString().flatMap(payload -> {
                    body.set(JSON.readValue(payload, Map.class));
                    contentType.set(request.requestHeaders().get("Content-Type"));
                    calls.incrementAndGet();
                    if (beforeHeaders) return Mono.<Void>never();
                    if (status == 307) response.header("Location", origin() + "/redirect-target");
                    return response.status(status).header("Content-Type", "application/x-ndjson")
                            .send(records.map(record -> io.netty.buffer.Unpooled.copiedBuffer(
                                    record, StandardCharsets.UTF_8)), ignored -> true).then();
                });
            }).route(ignored -> true, (request, response) -> {
                unexpectedCalls.incrementAndGet();
                return response.status(404).send();
            })).bindNow(Duration.ofSeconds(5));
        } catch (RuntimeException | Error error) {
            loops.disposeLater(Duration.ZERO, Duration.ofSeconds(5)).block(Duration.ofSeconds(6));
            throw error;
        }
    }

    String origin() { return "http://127.0.0.1:" + server.port(); }

    OllamaPullGateway gateway(Duration idle, Duration overall) {
        return new OllamaPullGateway(LocalOllamaEndpoint.parse(origin()), Duration.ofSeconds(1), idle, overall);
    }

    void reset() {
        records = Flux.never();
        status = 200;
        beforeHeaders = false;
        calls.set(0);
        unexpectedCalls.set(0);
        body.set(null);
    }

    @Override public void close() {
        server.disposeNow(Duration.ofSeconds(5));
        loops.disposeLater(Duration.ZERO, Duration.ofSeconds(5)).block(Duration.ofSeconds(6));
    }
}
