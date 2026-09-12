package com.hostai.backend;

import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.netty.DisposableServer;
import reactor.netty.resources.LoopResources;

final class SharingRuntimeStub implements AutoCloseable {
    final AtomicInteger chats = new AtomicInteger();
    final AtomicInteger metadata = new AtomicInteger();
    final AtomicInteger connections = new AtomicInteger();
    final AtomicInteger unexpected = new AtomicInteger();
    volatile boolean available = true;
    volatile Flux<String> records = complete();
    final LoopResources loops = LoopResources.create("sharing-test-runtime", 1, true);
    final DisposableServer server;
    SharingRuntimeStub() {
        server = reactor.netty.http.server.HttpServer.create().host("127.0.0.1").port(0).runOn(loops)
                .doOnConnection(connection -> {
                    connections.incrementAndGet();
                    connection.onDispose().doFinally(ignored -> connections.decrementAndGet()).subscribe();
                })
                .route(routes -> routes
                    // This fixture speaks Ollama only; the protocol probe is an expected 404.
                    .get("/hostai/manifest", (request, response) -> response.status(404).send())
                    .get("/api/version", (request, response) ->
                        response.header("Content-Type", "application/json").sendString(Mono.just("{\"version\":\"fixture\"}")))
                    .get("/api/tags", (request, response) -> {
                        metadata.incrementAndGet();
                        return response.header("Content-Type", "application/json").sendString(Mono.just(available
                                ? "{\"models\":[{\"name\":\"fixture-shared:small\",\"size\":1000},{\"name\":\"private-owner:small\",\"size\":1000}]}"
                                : "{\"models\":[]}"));
                    })
                    .post("/api/chat", (request, response) -> request.receive().aggregate().then(Mono.defer(() -> {
                        chats.incrementAndGet();
                        return response.header("Content-Type", "application/x-ndjson")
                                .send(records.map(record -> io.netty.buffer.Unpooled.copiedBuffer(record, java.nio.charset.StandardCharsets.UTF_8)), ignored -> true).then();
                    })))
                    .route(ignored -> true, (request, response) -> { unexpected.incrementAndGet(); return response.status(404).send(); }))
                .bindNow(Duration.ofSeconds(5));
    }
    String origin() { return "http://127.0.0.1:" + server.port(); }
    static Flux<String> complete() { return Flux.just("{\"message\":{\"content\":\"Guest fixture reply\"},\"done\":true,\"eval_count\":3}\n"); }
    static Flux<String> hold() { return Flux.concat(Flux.just("{\"message\":{\"content\":\"Partial guest reply\"},\"done\":false}\n"), Flux.never()); }
    @Override public void close() { server.disposeNow(Duration.ofSeconds(5)); loops.disposeLater(Duration.ZERO, Duration.ofSeconds(5)).block(Duration.ofSeconds(6)); }
}
