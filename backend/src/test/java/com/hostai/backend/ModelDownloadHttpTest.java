package com.hostai.backend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import java.net.Socket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Sinks;
import tools.jackson.databind.json.JsonMapper;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"hostai.download-idle-timeout=3s", "hostai.download-overall-timeout=10s"})
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class ModelDownloadHttpTest {
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final DownloadRuntimeStub STUB = new DownloadRuntimeStub();
    private static final String PATH = "/api/model-downloads";
    private static final String MODEL = "library/local-test:small";
    @Value("${local.server.port}") int port;
    @Autowired ModelDownloadService service;
    @Autowired InferenceRegistry chatRegistry;
    private HttpClient client;

    @DynamicPropertySource static void properties(DynamicPropertyRegistry properties) {
        properties.add("hostai.ollama-url", STUB::origin);
    }

    @BeforeEach void setUp() {
        STUB.reset();
        client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2))
                .version(HttpClient.Version.HTTP_1_1).build();
    }

    @AfterEach void tearDown() throws Exception {
        service.downloads().stream().filter(job -> job.state().equals("running")).forEach(job -> service.cancel(job.id()));
        client.shutdownNow();
        assertThat(client.awaitTermination(Duration.ofSeconds(5))).isTrue();
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(STUB.connections.get()).isZero());
        assertThat(STUB.unexpectedCalls.get()).isZero();
        assertThat(chatRegistry.counters()).isEqualTo(new InferenceRegistry.Counters(0, 0, 0));
    }

    @AfterAll static void stopStub() { STUB.close(); }

    @Test void startsTracksOnlyCurrentLayerAndRequiresExplicitSuccess() throws Exception {
        Sinks.Many<String> stream = Sinks.many().unicast().onBackpressureBuffer();
        STUB.records = stream.asFlux();
        UUID id = UUID.randomUUID();
        HttpResponse<String> response = start(id, MODEL);
        assertThat(response.statusCode()).isEqualTo(202);
        Map<String, Object> initial = body(response);
        assertThat(initial).containsOnlyKeys("id", "model", "state", "phase", "message", "digest",
                "completedBytes", "totalBytes", "createdAt", "updatedAt", "error");
        assertThat(initial).containsEntry("id", id.toString()).containsEntry("model", MODEL)
                .containsEntry("state", "running").containsEntry("phase", "starting")
                .containsEntry("digest", null).containsEntry("completedBytes", null)
                .containsEntry("totalBytes", null).containsEntry("error", null);
        Instant.parse((String) initial.get("createdAt"));
        awaitCalls(1);
        assertThat(STUB.body.get()).isEqualTo(Map.of("model", MODEL, "stream", true));
        assertThat(STUB.contentType.get()).isEqualTo("application/json");

        emit(stream, "{\"status\":\"pulling manifest\"}\n");
        awaitJob(id, "message", "Pulling manifest.");
        emit(stream, "{\"status\":\"pulling layer-a\",\"digest\":\"sha256:a\",\"total\":5000000000}\n");
        Map<String, Object> layer = awaitJob(id, "digest", "sha256:a");
        assertThat(layer).containsEntry("phase", "downloading").containsEntry("totalBytes", 5_000_000_000L)
                .containsEntry("completedBytes", null);
        // The record and its newline may arrive in separate network writes.
        emit(stream, "{\"status\":\"pulling layer-a\",\"completed\":12");
        emit(stream, "}\n");
        assertThat(awaitJob(id, "completedBytes", 12)).containsEntry("totalBytes", 5_000_000_000L);
        emit(stream, "{\"status\":\"pulling layer-b\",\"digest\":\"sha256:b\",\"completed\":1}\n");
        assertThat(awaitJob(id, "digest", "sha256:b")).containsEntry("totalBytes", null).containsEntry("completedBytes", 1);
        emit(stream, "{\"status\":\"pulling layer-c\",\"digest\":\"sha256:c\"}\n");
        assertThat(awaitJob(id, "digest", "sha256:c")).containsEntry("totalBytes", null).containsEntry("completedBytes", null);
        emit(stream, "{\"status\":\"private unknown runtime text\",\"future_field\":true}\n");
        assertThat(awaitJob(id, "message", "Downloading model.")).containsEntry("state", "running");
        emit(stream, "{\"status\":\"verifying sha256 digest\"}\n");
        awaitJob(id, "phase", "verifying");
        emit(stream, "{\"status\":\"writing manifest\"}\n");
        assertThat(awaitJob(id, "phase", "finalizing")).containsEntry("state", "running");
        emit(stream, "{\"status\":\"success\"}\n");
        Map<String, Object> done = awaitJob(id, "state", "completed");
        assertThat(done).containsEntry("error", null).containsEntry("createdAt", initial.get("createdAt"));
        assertThat(Instant.parse((String) done.get("updatedAt"))).isAfterOrEqualTo(Instant.parse((String) initial.get("createdAt")));
        // The runtime deliberately keeps its stream open; success must close the exchange.
        await().atMost(Duration.ofSeconds(2)).untilAsserted(() -> assertThat(STUB.connections.get()).isZero());
        assertThat(body(cancel(id))).isEqualTo(done);
        assertThat(start(id, MODEL).statusCode()).isEqualTo(200);
        assertThat(STUB.calls.get()).isEqualTo(1);
    }

    @Test void idempotentRetriesAndConcurrentStartsShareOneGlobalSlot() throws Exception {
        UUID first = UUID.randomUUID();
        UUID second = UUID.randomUUID();
        var a = client.sendAsync(startRequest(first, MODEL), HttpResponse.BodyHandlers.ofString());
        var b = client.sendAsync(startRequest(second, MODEL), HttpResponse.BodyHandlers.ofString());
        var responses = List.of(a.get(5, TimeUnit.SECONDS), b.get(5, TimeUnit.SECONDS));
        assertThat(responses.stream().map(HttpResponse::statusCode)).containsExactlyInAnyOrder(202, 409);
        UUID winner = UUID.fromString((String) body(responses.stream().filter(r -> r.statusCode() == 202).findFirst().orElseThrow()).get("id"));
        assertThat(start(winner, MODEL).statusCode()).isEqualTo(200);
        assertProblem(start(winner, "other:tag"), 409);
        assertProblem(start(UUID.randomUUID(), MODEL), 409);
        awaitCalls(1);
    }

    @Test void cancelBeforeHeadersIsIdempotentClosesSocketAndAllowsNewRequest() throws Exception {
        STUB.beforeHeaders = true;
        UUID id = UUID.randomUUID();
        assertThat(start(id, MODEL).statusCode()).isEqualTo(202);
        awaitCalls(1);
        HttpResponse<String> cancelled = cancel(id);
        assertThat(body(cancelled)).containsEntry("state", "cancelled").containsEntry("error", null);
        assertThat(body(cancel(id))).isEqualTo(body(cancelled));
        assertThat(body(start(id, MODEL))).isEqualTo(body(cancelled));
        await().atMost(Duration.ofSeconds(2)).untilAsserted(() -> assertThat(STUB.connections.get()).isZero());
        STUB.beforeHeaders = false;
        STUB.records = Flux.just("{\"status\":\"success\"}\n");
        UUID retry = UUID.randomUUID();
        assertThat(start(retry, MODEL).statusCode()).isEqualTo(202);
        awaitJob(retry, "state", "completed");
        assertThat(STUB.calls.get()).isEqualTo(2);
        assertProblem(cancel(UUID.randomUUID()), 404);
    }

    @Test void admittedJobSurvivesTheManagingBrowserSocketClosing() throws Exception {
        Sinks.Many<String> stream = Sinks.many().unicast().onBackpressureBuffer();
        STUB.records = stream.asFlux();
        UUID id = UUID.randomUUID();
        String payload = payload(id, MODEL);
        try (Socket browser = new Socket("127.0.0.1", port)) {
            browser.getOutputStream().write(("POST " + PATH + " HTTP/1.1\r\nHost: 127.0.0.1:" + port
                    + "\r\nContent-Type: application/json\r\nContent-Length: " + payload.getBytes(StandardCharsets.UTF_8).length
                    + "\r\n\r\n" + payload).getBytes(StandardCharsets.UTF_8));
            browser.getOutputStream().flush();
            awaitCalls(1);
        }
        emit(stream, "{\"status\":\"pulling test\",\"digest\":\"sha256:test\",\"completed\":9}\n");
        assertThat(awaitJob(id, "completedBytes", 9)).containsEntry("state", "running");
        assertThat(STUB.connections.get()).isEqualTo(1);
        assertThat(body(cancel(id))).containsEntry("state", "cancelled");
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "{", "{}\n", "null\n", "[]\n", "[{\"status\":\"success\"}]\n",
            "{\"status\":\"pulling manifest\"}\n", "{\"status\":3}\n", "{\"status\":\"\"}\n",
            "{\"error\":\"private upstream detail <script>secret</script>\"}\n",
            "{\"status\":\"success\",\"error\":\"private detail\"}\n",
            "{\"status\":\"pulling x\",\"total\":-1}\n", "{\"status\":\"pulling x\",\"completed\":-1}\n",
            "{\"status\":\"pulling x\",\"total\":2,\"completed\":3}\n",
            "{\"status\":\"pulling x\",\"total\":1.5}\n", "{\"status\":\"pulling x\",\"completed\":\"1\"}\n",
            "{\"status\":\"pulling x\",\"total\":9223372036854775808}\n",
            "{\"status\":\"pulling x\",\"digest\":{}}\n", "{\"status\":\"pulling x\",\"digest\":\"../bad\"}\n",
            "{\"status\":\"success\"}{\"status\":\"success\"}\n",
            "{\"status\":\"pulling x\",\"status\":\"success\"}\n"})
    void malformedTruncatedAndErrorStreamsFailWithoutLeakingRuntimeText(String records) throws Exception {
        STUB.records = records.isEmpty() ? Flux.empty() : Flux.just(records);
        UUID id = UUID.randomUUID();
        assertThat(start(id, MODEL).statusCode()).isEqualTo(202);
        Map<String, Object> job = awaitJob(id, "state", "failed");
        assertThat(job.get("error")).isInstanceOf(String.class);
        assertThat(JSON.writeValueAsString(job)).doesNotContain("private", "<script>", "secret");
        assertThat(body(cancel(id))).isEqualTo(job);
        assertThat(STUB.calls.get()).isEqualTo(1);
    }

    @Test void rejectsOversizedRecordsAndProgressExceedingRememberedLayerTotal() throws Exception {
        for (String records : List.of("{\"status\":\"" + "x".repeat(262145) + "\"}\n",
                "{\"status\":\"pulling x\",\"digest\":\"x\",\"total\":2}\n{\"status\":\"pulling x\",\"completed\":3}\n")) {
            STUB.records = Flux.just(records);
            UUID id = UUID.randomUUID();
            start(id, MODEL);
            awaitJob(id, "state", "failed");
        }
    }

    @ParameterizedTest @ValueSource(ints = {307, 400, 404, 429, 500, 503})
    void rejectsUpstreamHttpErrorsWithoutRedirectsOrRetries(int status) throws Exception {
        STUB.status = status;
        STUB.records = Flux.just("{\"error\":\"private runtime detail\"}\n");
        UUID id = UUID.randomUUID();
        start(id, MODEL);
        assertThat(awaitJob(id, "state", "failed").get("error")).isEqualTo("Ollama rejected the model download.");
        assertThat(STUB.calls.get()).isEqualTo(1);
    }

    @Test void rejectsOriginsFetchMetadataAndNonJsonBeforeAnyUpstreamCall() throws Exception {
        for (String origin : List.of("https://evil.example", "null", "http://localhost:" + port,
                "http://127.0.0.1:" + (port + 1), "https://127.0.0.1:" + port,
                origin() + "/", origin() + "/path", origin() + "?q=1", origin() + "#fragment",
                "http://user@127.0.0.1:" + port, origin() + " https://evil.example")) {
            assertProblem(post(PATH, payload(UUID.randomUUID(), MODEL), "Origin", origin), 403);
            assertProblem(post(PATH + "/" + UUID.randomUUID() + "/cancel", "{}", "Origin", origin), 403);
        }
        assertProblem(post(PATH, payload(UUID.randomUUID(), MODEL), "Sec-Fetch-Site", "cross-site"), 403);
        assertProblem(post(PATH, payload(UUID.randomUUID(), MODEL), "Origin", "https://evil.example",
                "Forwarded", "host=evil.example;proto=https", "X-Forwarded-Host", "evil.example", "X-Forwarded-Proto", "https"), 403);
        assertProblem(post(PATH, payload(UUID.randomUUID(), MODEL), "Origin", origin(), "Origin", "https://evil.example"), 403);
        for (String path : List.of("/api/model%2Ddownloads", "/api/model-downloads;ignored=value")) {
            assertProblem(post(path, payload(UUID.randomUUID(), MODEL), "Origin", "https://evil.example"), 403);
        }
        for (String type : List.of("text/plain", "application/x-www-form-urlencoded", "application/problem+json")) {
            assertProblem(send(HttpRequest.newBuilder(uri(PATH)).header("Content-Type", type)
                    .POST(HttpRequest.BodyPublishers.ofString(payload(UUID.randomUUID(), MODEL))).build()), 415);
            assertProblem(send(HttpRequest.newBuilder(uri(PATH + "/" + UUID.randomUUID() + "/cancel"))
                    .header("Content-Type", type).POST(HttpRequest.BodyPublishers.ofString("{}")).build()), 415);
        }
        assertProblem(send(HttpRequest.newBuilder(uri(PATH)).POST(HttpRequest.BodyPublishers.ofString("{}")).build()), 415);
        assertThat(STUB.calls.get()).isZero();
        STUB.records = Flux.just("{\"status\":\"success\"}\n");
        UUID allowed = UUID.randomUUID();
        assertThat(post(PATH, payload(allowed, MODEL), "Origin", origin(), "Sec-Fetch-Site", "same-origin").statusCode()).isEqualTo(202);
        awaitJob(allowed, "state", "completed");
    }

    @Test void rejectsReboundHostEvenWhenOriginMatchesIt() throws Exception {
        String payload = payload(UUID.randomUUID(), MODEL);
        try (Socket browser = new Socket("127.0.0.1", port)) {
            browser.setSoTimeout(3000);
            browser.getOutputStream().write(("POST " + PATH + " HTTP/1.1\r\nHost: attacker.example:" + port
                    + "\r\nOrigin: http://attacker.example:" + port
                    + "\r\nSec-Fetch-Site: same-origin\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: "
                    + payload.getBytes(StandardCharsets.UTF_8).length + "\r\n\r\n" + payload).getBytes(StandardCharsets.UTF_8));
            browser.getOutputStream().flush();
            String response = new String(browser.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            assertThat(response).startsWith("HTTP/1.1 403");
        }
        assertThat(STUB.calls.get()).isZero();
    }

    @Test void rejectsInvalidNamesIdsAndBodiesWithoutUpstreamCalls() throws Exception {
        for (String model : List.of("", "local-test", "org/model", "org/a/b:tag", "../a:tag", "a/../b:tag",
                "a..b:tag", "https://ollama.com/library/a:tag", "registry.example/a:tag", "localhost/a:tag",
                "127.0.0.1/a:tag", "host:5000/a:tag", "a:cloud", "a:Cloud", "a:small-cloud", "a-cloud:tag",
                " a:tag", "a:tag ", "a:tag/b", "a@sha256:x", "a:tag:extra", "a:tag?x", "x".repeat(125) + ":tag")) {
            assertProblem(start(UUID.randomUUID(), model), 400);
        }
        for (String payload : List.of("{}", "null", "[]", "{", "{\"model\":\"a:tag\"}",
                "{\"requestId\":\"1-1-1-1-1\",\"model\":\"a:tag\"}",
                "{\"requestId\":\"" + UUID.randomUUID() + "\",\"model\":\"a:tag\",\"insecure\":true}")) {
            assertProblem(post(PATH, payload), 400);
        }
        for (String payload : List.of("", "null", "[]", "{\"extra\":true}")) {
            assertProblem(post(PATH + "/" + UUID.randomUUID() + "/cancel", payload), 400);
        }
        assertProblem(post(PATH + "/1-1-1-1-1/cancel", "{}"), 400);
        assertProblem(post(PATH, "{\"model\":\"" + "a".repeat(262145) + "\"}"), 413);
        assertThat(STUB.calls.get()).isZero();
    }

    @Test void retainsTwentyJobsNewestFirstAndEvictsOldIdempotencyKeys() throws Exception {
        STUB.records = Flux.just("{\"status\":\"success\"}\n");
        List<UUID> ids = new ArrayList<>();
        for (int index = 0; index < 22; index++) {
            UUID id = UUID.randomUUID();
            ids.add(id);
            assertThat(start(id, "x".repeat(124) + ":tag").statusCode()).isEqualTo(202);
            awaitJob(id, "state", "completed");
        }
        List<Map<String, Object>> jobs = jobs();
        assertThat(jobs).hasSize(20);
        assertThat(jobs.stream().map(job -> job.get("id"))).containsExactlyElementsOf(
                ids.subList(2, 22).reversed().stream().map(UUID::toString).toList());
        assertProblem(cancel(ids.getFirst()), 404);
        assertThat(start(ids.getFirst(), MODEL).statusCode()).isEqualTo(202);
        awaitJob(ids.getFirst(), "state", "completed");
    }

    private String origin() { return "http://127.0.0.1:" + port; }
    private URI uri(String path) { return URI.create(origin() + path); }
    private static String payload(UUID id, String model) { return JSON.writeValueAsString(Map.of("requestId", id.toString(), "model", model)); }
    private HttpRequest startRequest(UUID id, String model) {
        return HttpRequest.newBuilder(uri(PATH)).timeout(Duration.ofSeconds(5)).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(payload(id, model))).build();
    }
    private HttpResponse<String> start(UUID id, String model) throws Exception { return send(startRequest(id, model)); }
    private HttpResponse<String> cancel(UUID id) throws Exception { return post(PATH + "/" + id + "/cancel", "{}"); }
    private HttpResponse<String> post(String path, String payload, String... headers) throws Exception {
        var request = HttpRequest.newBuilder(uri(path)).timeout(Duration.ofSeconds(5)).header("Content-Type", "application/json");
        if (headers.length > 0) request.headers(headers);
        return send(request.POST(HttpRequest.BodyPublishers.ofString(payload)).build());
    }
    private HttpResponse<String> send(HttpRequest request) throws Exception { return client.send(request, HttpResponse.BodyHandlers.ofString()); }
    @SuppressWarnings("unchecked") private static Map<String, Object> body(HttpResponse<String> response) { return JSON.readValue(response.body(), Map.class); }
    @SuppressWarnings("unchecked") private List<Map<String, Object>> jobs() throws Exception {
        var response = send(HttpRequest.newBuilder(uri(PATH)).timeout(Duration.ofSeconds(5)).GET().build());
        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(response.headers().firstValue("Cache-Control")).contains("no-store");
        return (List<Map<String, Object>>) body(response).get("downloads");
    }
    private Map<String, Object> awaitJob(UUID id, String key, Object value) {
        var result = new java.util.concurrent.atomic.AtomicReference<Map<String, Object>>();
        await().pollInterval(Duration.ofMillis(20)).atMost(Duration.ofSeconds(3)).untilAsserted(() -> {
            Map<String, Object> job = jobs().stream().filter(j -> j.get("id").equals(id.toString())).findFirst().orElseThrow();
            assertThat(job).containsEntry(key, value);
            result.set(job);
        });
        return result.get();
    }
    private static void awaitCalls(int count) {
        await().atMost(Duration.ofSeconds(2)).untilAsserted(() -> assertThat(STUB.calls.get()).isEqualTo(count));
    }
    private static void emit(Sinks.Many<String> stream, String text) { assertThat(stream.tryEmitNext(text)).isEqualTo(Sinks.EmitResult.OK); }
    private static void assertProblem(HttpResponse<String> response, int status) {
        assertThat(response.statusCode()).as(response.body()).isEqualTo(status);
        assertThat(response.headers().firstValue("Content-Type").orElseThrow()).startsWith("application/problem+json");
        assertThat(response.headers().firstValue("Access-Control-Allow-Origin")).isEmpty();
    }
}
