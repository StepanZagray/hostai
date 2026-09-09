package com.hostai.backend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.netty.DisposableServer;
import reactor.netty.resources.LoopResources;
import tools.jackson.databind.json.JsonMapper;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"hostai.stream-idle-timeout=3s", "hostai.generation-timeout=5s"})
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class BackendHttpTest {
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final Stub STUB = new Stub();
    private static final String CHAT = """
            {"model":"local-test:latest","messages":[{"role":"user","content":"private prompt"}],
             "temperature":0.7,"maxTokens":32}
            """;
    @Value("${local.server.port}") int port;
    @Autowired InferenceRegistry registry;
    private HttpClient client;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry properties) {
        // There is no fallback to a real Ollama URL in this test suite.
        properties.add("hostai.ollama-url", () -> "http://127.0.0.1:" + STUB.server.port());
    }

    @BeforeEach
    void setUp() {
        STUB.mode = Mode.NORMAL;
        STUB.calls.set(0);
        STUB.lastBody.set(null);
        client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2))
                .version(HttpClient.Version.HTTP_1_1).build();
    }

    @AfterEach
    void tearDown() throws Exception {
        client.shutdownNow();
        assertThat(client.awaitTermination(Duration.ofSeconds(5))).isTrue();
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
            assertThat(registry.counters().activeRequests()).isZero();
            assertThat(STUB.connections.get()).isZero();
        });
    }

    @AfterAll static void stopStub() { STUB.close(); }

    @Test
    void offlineStatusAndModelsStayUsableAndChatFailsBeforeStreaming() throws Exception {
        STUB.mode = Mode.OFFLINE;
        Map<String, Object> status = body(get("/api/status"));
        assertThat(status).containsEntry("status", "online").containsEntry("ollamaConnected", false)
                .containsEntry("maxConcurrentRequests", 2)
                .containsEntry("ollamaUrl", "http://127.0.0.1:" + STUB.server.port());
        assertThat(status.keySet()).containsExactlyInAnyOrder("status", "ollamaConnected", "ollamaUrl",
                "version", "javaVersion", "uptimeSeconds", "activeRequests", "maxConcurrentRequests",
                "totalRequests", "failedRequests");
        assertThat(body(get("/api/models"))).containsEntry("connected", false).containsEntry("models", List.of());
        long failedBefore = registry.counters().failedRequests();
        assertProblem(post(CHAT), 503);
        assertThat(registry.counters().failedRequests()).isEqualTo(failedBefore + 1);
        assertThat(STUB.calls.get()).isEqualTo(1);
    }

    @Test
    void convertsModelsAndReportsLiveMetadata() throws Exception {
        assertThat(body(get("/api/status"))).containsEntry("ollamaConnected", true)
                .containsEntry("javaVersion", System.getProperty("java.version"));
        Map<String, Object> models = body(get("/api/models"));
        assertThat(models).containsEntry("connected", true);
        assertThat((List<?>) models.get("models")).hasSize(2);
        assertThat(map(((List<?>) models.get("models")).getFirst())).containsExactlyInAnyOrderEntriesOf(Map.of(
                "name", "local-test:latest", "sizeBytes", 5_000_000_000L, "parameterSize", "8B",
                "quantization", "Q4_K_M", "modifiedAt", "2026-09-01T12:00:00Z"));
        assertThat(map(((List<?>) models.get("models")).get(1))).containsEntry("parameterSize", "")
                .containsEntry("quantization", "").containsEntry("modifiedAt", "");
    }

    @Test
    void forwardsOptionsAndConvertsNdjsonIncludingUtf8AndFinalTokenCount() throws Exception {
        HttpResponse<String> response = post(CHAT);
        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(response.headers().firstValue("content-type").orElseThrow()).startsWith("application/x-ndjson");
        List<Map<String, Object>> chunks = lines(response.body());
        assertThat(chunks).containsExactly(
                Map.of("content", "Héllo", "done", false),
                Map.of("content", "!", "done", true, "outputTokens", 7));
        assertThat(STUB.lastBody.get()).containsEntry("model", "local-test:latest").containsEntry("stream", true)
                .containsEntry("messages", List.of(Map.of("role", "user", "content", "private prompt")))
                .containsEntry("options", Map.of("temperature", 0.7, "num_predict", 32));
        await().atMost(Duration.ofSeconds(2)).untilAsserted(() -> {
            assertThat(registry.requests().getFirst().status()).isEqualTo("completed");
            assertThat(registry.requests().getFirst().outputTokens()).isEqualTo(7L);
        });
        String history = get("/api/requests").body();
        assertThat(history).doesNotContain("private prompt", "messages", "content");
        Map<String, Object> latest = map(((List<?>) body(get("/api/requests")).get("requests")).getFirst());
        assertThat(latest.keySet()).containsExactlyInAnyOrder("id", "model", "status", "startedAt", "durationMs", "outputTokens");
        assertThat(STUB.calls.get()).isEqualTo(1);
    }

    @Test
    void validatesRequestsWithoutAdmittingOrContactingOllama() throws Exception {
        long before = registry.counters().totalRequests();
        for (String invalid : List.of("{}", "not json", CHAT.replace("user", "tool"),
                CHAT.replace("0.7", "2.1"), CHAT.replace("32", "0"), CHAT.replace("32", "1.5"),
                CHAT.replace("private prompt", "x".repeat(16_385)),
                CHAT.replace("local-test:latest", "test:cloud"),
                CHAT.replace("\"maxTokens\":32", "\"maxTokens\":32,\"unknown\":true"),
                CHAT.replace("[{\"role\":\"user\",\"content\":\"private prompt\"}]", "[null]"))) {
            assertProblem(post(invalid), 400);
        }
        assertThat(STUB.calls.get()).isZero();
        assertThat(registry.counters().totalRequests()).isEqualTo(before);
    }

    @Test
    void rejectsOversizedBodies() throws Exception {
        assertProblem(post(CHAT.replace("private prompt", "x".repeat(300_000))), 413);
        assertThat(STUB.calls.get()).isZero();
    }

    @Test
    void streamsBeforeCompletionRejectsThirdRequestAndCancelsBothUpstreams() throws Exception {
        STUB.mode = Mode.HOLD;
        try (InputStream first = stream(); InputStream second = stream()) {
            assertThat(readLine(first)).contains("\"done\":false");
            assertThat(readLine(second)).contains("\"done\":false");
            assertThat(registry.counters().activeRequests()).isEqualTo(2);
            assertThat(registry.requests().getFirst().status()).isEqualTo("running");
            assertThat(registry.requests().getFirst().durationMs()).isNull();
            assertThat(registry.requests().getFirst().outputTokens()).isNull();
            assertProblem(post(CHAT), 429);
            assertThat(STUB.calls.get()).isEqualTo(2);
        }
        await().atMost(Duration.ofSeconds(2)).untilAsserted(() -> {
            assertThat(STUB.connections.get()).isZero();
            assertThat(registry.counters().activeRequests()).isZero();
            assertThat(registry.requests().subList(0, 2)).allMatch(r -> r.status().equals("cancelled"));
        });
        STUB.mode = Mode.NORMAL;
        assertThat(post(CHAT).statusCode()).isEqualTo(200);
    }

    @Test
    void cancellationBeforeUpstreamHeadersReleasesSlotAndClosesSocket() throws Exception {
        STUB.mode = Mode.BEFORE_HEADERS;
        var pending = client.sendAsync(chatRequest(CHAT), HttpResponse.BodyHandlers.ofInputStream());
        try {
            await().atMost(Duration.ofSeconds(2)).untilAsserted(() -> {
                assertThat(STUB.calls.get()).isEqualTo(1);
                assertThat(registry.counters().activeRequests()).isEqualTo(1);
            });
        } finally {
            pending.cancel(true);
        }
        await().atMost(Duration.ofSeconds(2)).untilAsserted(() -> {
            assertThat(STUB.connections.get()).isZero();
            assertThat(registry.counters().activeRequests()).isZero();
            assertThat(registry.requests().getFirst().status()).isEqualTo("cancelled");
        });
        assertThat(STUB.calls.get()).isEqualTo(1);
    }

    @Test
    void midStreamErrorIsAnExplicitTerminalRecordAndNeverEchoesUpstreamDetail() throws Exception {
        STUB.mode = Mode.MID_ERROR;
        HttpResponse<String> response = post(CHAT);
        assertThat(response.statusCode()).isEqualTo(200);
        List<Map<String, Object>> chunks = lines(response.body());
        assertThat(chunks).hasSize(2);
        assertThat(chunks.getLast()).containsEntry("content", "").containsEntry("done", true)
                .containsEntry("error", "Ollama reported a generation error.");
        assertThat(response.body()).doesNotContain("private prompt");
        assertThat(registry.requests().getFirst().status()).isEqualTo("failed");
    }

    @Test
    void prematureEndIsAnExplicitStreamFailure() throws Exception {
        STUB.mode = Mode.TRUNCATED;
        HttpResponse<String> response = post(CHAT);
        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(lines(response.body()).getLast()).containsEntry("done", true).containsKey("error");
        assertThat(registry.requests().getFirst().status()).isEqualTo("failed");
    }

    @Test
    void invalidFirstRecordIsAProblemBeforeStreaming() throws Exception {
        STUB.mode = Mode.MALFORMED;
        assertProblem(post(CHAT), 502);
        assertThat(registry.requests().getFirst().status()).isEqualTo("failed");
    }

    @Test
    void missingLocalModelIsAClientErrorWithoutRetries() throws Exception {
        STUB.mode = Mode.NOT_FOUND;
        assertProblem(post(CHAT), 400);
        assertThat(STUB.calls.get()).isEqualTo(1);
    }

    @Test
    void idleTimeoutBecomesTerminalErrorAndClosesUpstream() throws Exception {
        STUB.mode = Mode.HOLD;
        HttpResponse<String> response = post(CHAT);
        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(lines(response.body()).getLast()).containsEntry("done", true).containsKey("error");
        assertThat(registry.requests().getFirst().status()).isEqualTo("failed");
    }

    @Test
    void exposesOnlyMinimalHealthAndDoesNotGrantCrossOriginAccess() throws Exception {
        assertThat(body(get("/actuator/health"))).isEqualTo(Map.of("status", "UP"));
        assertProblem(get("/actuator/env"), 404);
        HttpResponse<String> preflight = client.send(HttpRequest.newBuilder(uri("/api/chat"))
                .header("Origin", "https://untrusted.example")
                .header("Access-Control-Request-Method", "POST")
                .header("Access-Control-Request-Headers", "content-type")
                .method("OPTIONS", HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofString());
        assertThat(preflight.headers().firstValue("Access-Control-Allow-Origin")).isEmpty();
    }

    private URI uri(String path) { return URI.create("http://127.0.0.1:" + port + path); }

    private HttpRequest chatRequest(String payload) {
        return HttpRequest.newBuilder(uri("/api/chat")).timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json").header("Accept", "application/x-ndjson, application/problem+json")
                .POST(HttpRequest.BodyPublishers.ofString(payload)).build();
    }

    private HttpResponse<String> post(String payload) throws Exception {
        return client.send(chatRequest(payload), HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> get(String path) throws Exception {
        return client.send(HttpRequest.newBuilder(uri(path)).timeout(Duration.ofSeconds(5)).GET().build(),
                HttpResponse.BodyHandlers.ofString());
    }

    private InputStream stream() throws Exception {
        HttpResponse<InputStream> response = client.sendAsync(chatRequest(CHAT), HttpResponse.BodyHandlers.ofInputStream())
                .get(5, TimeUnit.SECONDS);
        if (response.statusCode() != 200) {
            response.body().close();
            throw new AssertionError("Expected streaming HTTP 200; got " + response.statusCode());
        }
        return response.body();
    }

    private String readLine(InputStream stream) throws Exception {
        return new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8)).readLine();
    }

    private void assertProblem(HttpResponse<String> response, int status) {
        assertThat(response.statusCode()).as(response.body()).isEqualTo(status);
        assertThat(response.headers().firstValue("content-type").orElseThrow()).startsWith("application/problem+json");
        assertThat(body(response)).containsEntry("status", status).containsKeys("title", "detail");
        assertThat(response.body()).doesNotContain("private prompt");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) { return (Map<String, Object>) value; }

    private static Map<String, Object> body(HttpResponse<String> response) {
        return map(JSON.readValue(response.body(), Map.class));
    }

    private static List<Map<String, Object>> lines(String body) {
        return body.lines().filter(line -> !line.isBlank()).map(line -> map(JSON.readValue(line, Map.class))).toList();
    }

    enum Mode { NORMAL, OFFLINE, HOLD, BEFORE_HEADERS, MID_ERROR, TRUNCATED, MALFORMED, NOT_FOUND }

    private static final class Stub implements AutoCloseable {
        volatile Mode mode = Mode.NORMAL;
        final AtomicInteger calls = new AtomicInteger();
        final AtomicInteger connections = new AtomicInteger();
        final AtomicReference<Map<String, Object>> lastBody = new AtomicReference<>();
        final LoopResources loops = LoopResources.create("hostai-test-stub", 1, true);
        final DisposableServer server = reactor.netty.http.server.HttpServer.create()
                .host("127.0.0.1").port(0).runOn(loops)
                .route(routes -> routes
                        .get("/api/version", (request, response) -> response
                                .status(mode == Mode.OFFLINE ? 503 : 200).header("Content-Type", "application/json")
                                .sendString(Mono.just("{\"version\":\"stub-only\"}")))
                        .get("/api/tags", (request, response) -> response
                                .status(mode == Mode.OFFLINE ? 503 : 200).header("Content-Type", "application/json")
                                .sendString(Mono.just("""
                                        {"models":[{"name":"local-test:latest","size":5000000000,
                                        "modified_at":"2026-09-01T12:00:00Z","digest":"ignored",
                                        "details":{"parameter_size":"8B","quantization_level":"Q4_K_M"}},
                                        {"name":"minimal","size":0}]}
                                        """)))
                        .post("/api/chat", (request, response) -> {
                            connections.incrementAndGet();
                            request.withConnection(connection -> connection.onDispose()
                                    .doFinally(ignored -> connections.decrementAndGet()).subscribe());
                            return request.receive().aggregate().asString().flatMap(payload -> {
                                calls.incrementAndGet();
                                lastBody.set(map(JSON.readValue(payload, Map.class)));
                                Mode current = mode;
                                if (current == Mode.BEFORE_HEADERS) return Mono.<Void>never();
                                if (current == Mode.OFFLINE || current == Mode.NOT_FOUND) {
                                    return response.status(current == Mode.OFFLINE ? 503 : 404)
                                            .header("Content-Type", "application/json")
                                            .sendString(Mono.just("{\"error\":\"private prompt\"}")).then();
                                }
                                String first = "{\"message\":{\"content\":\"Héllo\"},\"done\":false}\n";
                                Flux<String> records = switch (current) {
                                    case HOLD -> Flux.concat(Mono.just(first), Flux.never());
                                    case MID_ERROR -> Flux.just(first, "{\"error\":\"private prompt\"}\n");
                                    case TRUNCATED -> Flux.just(first);
                                    case MALFORMED -> Flux.just("{\"message\":{\"content\":\"missing done\"}}\n");
                                    default -> Flux.just(first,
                                            "{\"message\":{\"content\":\"!\"},\"done\":true,\"eval_count\":7}\n");
                                };
                                return response.header("Content-Type", "application/x-ndjson")
                                        .send(records.map(record -> io.netty.buffer.Unpooled.copiedBuffer(
                                                record, StandardCharsets.UTF_8)), ignored -> true).then();
                            });
                        }))
                .bindNow(Duration.ofSeconds(5));

        @Override public void close() {
            server.disposeNow(Duration.ofSeconds(5));
            loops.disposeLater(Duration.ZERO, Duration.ofSeconds(5)).block(Duration.ofSeconds(6));
        }
    }
}
