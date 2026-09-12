package com.hostai.backend;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** A loopback process speaking the HostAI runtime protocol from docs/model-ui.md; never a real model. */
final class HostAiRuntimeStub implements AutoCloseable {
    enum Infer { SINGLE, NDJSON, NDJSON_ERROR, REJECT, HOLD, SERVER_ERROR }
    static final String RUNTIME = "pebby";
    static final String MODEL = "pebby:latest";
    static final String INTERACTION = """
            {"instructions":"Send an operation as JSON; each request is independent.",
             "inputSchema":{"type":"object","description":"An operation request."},
             "outputSchema":{"type":"object","description":"An operation result."},
             "examples":[{"description":"Inspect the provider.","input":{"op":"info"},"output":{"ok":true}}]}
            """.strip();
    static final String MANIFEST = """
            {"protocol":1,"runtime":"pebby","models":[{"name":"pebby:latest","sizeBytes":12345,
             "parameterSize":"3.2K","quantization":"F32","modifiedAt":"2026-09-11T07:22:00Z"}],
             "ui":{"entry":"/ui/index.html"},"interaction":%s,"vendor":"ignored"}
            """.formatted(INTERACTION);
    volatile Infer infer = Infer.SINGLE;
    volatile boolean manifest = true;
    volatile String manifestBody = MANIFEST;
    volatile String chatBody = "{\"content\":\"Hello from runtime\",\"done\":false}\n{\"content\":\"!\",\"done\":true,\"outputTokens\":4}\n";
    volatile String chatType = "application/x-ndjson";
    volatile int chatStatus = 200;
    volatile boolean holdChat;
    final AtomicInteger chats = new AtomicInteger();
    final AtomicReference<String> lastChatBody = new AtomicReference<>();
    final AtomicInteger infers = new AtomicInteger();
    final AtomicInteger inflight = new AtomicInteger();
    final AtomicReference<String> lastInferBody = new AtomicReference<>();
    final List<String> assetPaths = new CopyOnWriteArrayList<>();
    volatile CountDownLatch release = new CountDownLatch(1);
    private final ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();
    private final HttpServer server;

    HostAiRuntimeStub() {
        try {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        } catch (IOException error) { throw new java.io.UncheckedIOException(error); }
        server.setExecutor(executor);
        server.createContext("/", this::handle);
        server.start();
    }

    String origin() { return "http://127.0.0.1:" + server.getAddress().getPort(); }

    void reset() {
        infer = Infer.SINGLE; manifest = true; infers.set(0); lastInferBody.set(null); assetPaths.clear();
        manifestBody = MANIFEST; chats.set(0); lastChatBody.set(null); holdChat = false;
        chatBody = "{\"content\":\"Hello from runtime\",\"done\":false}\n{\"content\":\"!\",\"done\":true,\"outputTokens\":4}\n";
        chatType = "application/x-ndjson"; chatStatus = 200;
        release.countDown(); release = new CountDownLatch(1);
    }

    private void handle(HttpExchange exchange) throws IOException {
        inflight.incrementAndGet();
        try (exchange) {
            String path = exchange.getRequestURI().getRawPath();
            byte[] body = exchange.getRequestBody().readAllBytes();
            switch (path) {
                case "/hostai/manifest" -> {
                    if (manifest) send(exchange, 200, "application/json", manifestBody.getBytes(StandardCharsets.UTF_8));
                    else send(exchange, 404, "text/plain", "not here".getBytes(StandardCharsets.UTF_8));
                }
                case "/hostai/chat" -> {
                    chats.incrementAndGet();
                    lastChatBody.set(new String(body, StandardCharsets.UTF_8));
                    if (holdChat) {
                        exchange.getResponseHeaders().set("Content-Type", chatType);
                        exchange.sendResponseHeaders(chatStatus, 0);
                        OutputStream out = exchange.getResponseBody();
                        out.write("{\"content\":\"started\",\"done\":false}\n".getBytes(StandardCharsets.UTF_8));
                        out.flush();
                        try { release.await(30, TimeUnit.SECONDS); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
                        try { out.write("{\"content\":\"\",\"done\":true}\n".getBytes(StandardCharsets.UTF_8)); } catch (IOException ignored) { /* client gone */ }
                    } else send(exchange, chatStatus, chatType, chatBody.getBytes(StandardCharsets.UTF_8));
                }
                case "/hostai/infer" -> {
                    infers.incrementAndGet();
                    lastInferBody.set(new String(body, StandardCharsets.UTF_8));
                    switch (infer) {
                        case SINGLE -> send(exchange, 200, "application/json", "{\"ok\":true,\"echo\":\"private input\"}".getBytes(StandardCharsets.UTF_8));
                        case NDJSON -> send(exchange, 200, "application/x-ndjson",
                                "{\"event\":{\"step\":1},\"done\":false}\n{\"event\":{\"step\":2},\"done\":true}\n".getBytes(StandardCharsets.UTF_8));
                        case NDJSON_ERROR -> send(exchange, 200, "application/x-ndjson",
                                "{\"event\":{\"step\":1},\"done\":false}\n{\"done\":true,\"error\":\"bad \\u0007thing\"}\n".getBytes(StandardCharsets.UTF_8));
                        case REJECT -> send(exchange, 400, "application/json", "{\"error\":\"Unknown\\naction\"}".getBytes(StandardCharsets.UTF_8));
                        case SERVER_ERROR -> send(exchange, 500, "text/plain", "private failure".getBytes(StandardCharsets.UTF_8));
                        case HOLD -> {
                            exchange.getResponseHeaders().set("Content-Type", "application/x-ndjson");
                            exchange.sendResponseHeaders(200, 0);
                            OutputStream out = exchange.getResponseBody();
                            out.write("{\"event\":{\"step\":1},\"done\":false}\n".getBytes(StandardCharsets.UTF_8));
                            out.flush();
                            try { release.await(30, TimeUnit.SECONDS); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
                            try { out.write("{\"done\":true}\n".getBytes(StandardCharsets.UTF_8)); } catch (IOException ignored) { /* client gone */ }
                        }
                    }
                }
                default -> {
                    if (path.startsWith("/ui/")) {
                        assetPaths.add(path);
                        switch (path) {
                            case "/ui/index.html" -> send(exchange, 200, "application/octet-stream",
                                    "<!doctype html><script src=\"hostai-bridge.js\"></script><script src=\"app.js\"></script>".getBytes(StandardCharsets.UTF_8));
                            case "/ui/app.js" -> send(exchange, 200, "text/plain", "console.log('pebby ui');".getBytes(StandardCharsets.UTF_8));
                            case "/ui/nested/deep.css" -> send(exchange, 200, "text/css", "body{color:red}".getBytes(StandardCharsets.UTF_8));
                            case "/ui/secret.exe" -> send(exchange, 200, "application/octet-stream", new byte[] {77, 90, 0});
                            case "/ui/big.js" -> send(exchange, 200, "text/javascript", new byte[ModelUiAssets.MAX_ASSET_BYTES + 1]);
                            default -> send(exchange, 404, "text/plain", "missing".getBytes(StandardCharsets.UTF_8));
                        }
                    } else send(exchange, 404, "text/plain", "missing".getBytes(StandardCharsets.UTF_8));
                }
            }
        } finally { inflight.decrementAndGet(); }
    }

    private static void send(HttpExchange exchange, int status, String type, byte[] bytes) throws IOException {
        exchange.getResponseHeaders().set("Content-Type", type);
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) { out.write(bytes); }
    }

    @Override public void close() {
        release.countDown();
        server.stop(0);
        executor.close();
    }
}
