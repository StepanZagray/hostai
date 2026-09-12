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
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.json.JsonMapper;

/** Mixed Ollama + HostAI-protocol runtimes on ephemeral loopback ports; no real model or network. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"hostai.guest-port=0", "hostai.stream-idle-timeout=3s", "hostai.generation-timeout=5s"})
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class ModelUiHttpTest {
    private static final SharingRuntimeStub OLLAMA = new SharingRuntimeStub();
    private static final HostAiRuntimeStub HOSTAI = new HostAiRuntimeStub();
    private static final String INFER = "{\"model\":\"pebby:latest\",\"input\":{\"board\":[[0,1]],\"action\":\"private input\"}}";
    static final Path directory = temporaryDirectory();
    private static Path temporaryDirectory() {
        try { return Files.createTempDirectory("hostai-model-ui-http-"); }
        catch (java.io.IOException error) { throw new java.io.UncheckedIOException(error); }
    }
    @DynamicPropertySource static void properties(DynamicPropertyRegistry properties) {
        properties.add("hostai.ollama-url", OLLAMA::origin);
        // The HostAI origin is listed twice: the duplicate runtime id must make the later one unavailable.
        properties.add("hostai.runtime-urls", () -> OLLAMA.origin() + ", " + HOSTAI.origin() + "," + HOSTAI.origin());
        properties.add("hostai.access-directory", () -> directory.resolve("access").toString());
    }
    @Value("${local.server.port}") int port;
    @Autowired SharingService sharing;
    @Autowired InferenceRegistry registry;
    @Autowired JsonMapper json;
    HttpClient client;

    @BeforeEach void prepare() {
        client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).version(HttpClient.Version.HTTP_1_1).build();
        sharing.stop();
        OLLAMA.available = true; OLLAMA.records = SharingRuntimeStub.complete();
        OLLAMA.chats.set(0); OLLAMA.unexpected.set(0);
        HOSTAI.reset();
    }

    @AfterEach void clean() throws Exception {
        sharing.stop();
        HOSTAI.release.countDown();
        client.shutdownNow();
        assertThat(client.awaitTermination(Duration.ofSeconds(5))).isTrue();
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
            assertThat(registry.counters().activeRequests()).isZero();
            assertThat(OLLAMA.connections.get()).isZero();
            assertThat(HOSTAI.inflight.get()).isZero();
        });
        assertThat(OLLAMA.unexpected.get()).isZero();
    }

    @AfterAll void close() throws Exception {
        sharing.close(); OLLAMA.close(); HOSTAI.close();
        try (var paths = Files.walk(directory)) {
            for (var path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.delete(path);
        }
    }

    @Test void mergesRuntimesReportsUiAndJoinsConfiguredOrigins() throws Exception {
        var status = object(get(owner("/api/status"), null));
        assertThat(status).containsEntry("ollamaConnected", true)
                .containsEntry("ollamaUrl", OLLAMA.origin() + ", " + HOSTAI.origin() + ", " + HOSTAI.origin());
        var models = object(get(owner("/api/models"), null));
        assertThat(models).containsEntry("connected", true);
        List<Map<String, Object>> list = list(models.get("models"));
        assertThat(list).extracting(model -> model.get("name"))
                .containsExactly("fixture-shared:small", "private-owner:small", "pebby:latest");
        assertThat(list.getFirst()).containsEntry("ui", null).containsEntry("chatUnavailableReason", null);
        assertThat(list.getLast()).containsEntry("sizeBytes", 12345).containsEntry("parameterSize", "3.2K")
                .containsEntry("quantization", "F32").containsEntry("modifiedAt", "2026-09-11T07:22:00Z")
                .containsEntry("chatUnavailableReason", "This model does not support chat.")
                .containsEntry("capabilities", Map.of("chat", false, "infer", true))
                .containsEntry("ui", Map.of("runtime", "pebby", "entry", "ui/index.html"));
        assertThat(list.getLast().keySet()).containsExactlyInAnyOrder("name", "sizeBytes", "parameterSize",
                "quantization", "modifiedAt", "chatUnavailableReason", "ui", "capabilities", "interaction");
    }

    @Test void ollamaKeepsWorkingWhenTheManifestProbeIs404AndAHostAiOriginFallsBackToOllama() throws Exception {
        var chat = postJson(owner("/api/chat"), chat("fixture-shared:small"), null);
        assertThat(chat.statusCode()).isEqualTo(200);
        assertThat(lines(chat.body()).getLast()).containsEntry("done", true).containsEntry("outputTokens", 3);
        assertThat(OLLAMA.chats.get()).isEqualTo(1);
        HOSTAI.manifest = false;
        var models = object(get(owner("/api/models"), null));
        assertThat(models).containsEntry("connected", true);
        assertThat(list(models.get("models"))).extracting(model -> model.get("name"))
                .containsExactly("fixture-shared:small", "private-owner:small");
        assertThat(object(get(owner("/api/status"), null))).containsEntry("ollamaConnected", true);
    }

    private void chatManifest() {
        HOSTAI.manifestBody = """
                {"protocol":1,"runtime":"pebby","capabilities":{"chat":true,"infer":false},
                 "models":[{"name":"pebby:latest","sizeBytes":12345}]}
                """;
    }

    @Test void hostAiChatWithoutUiStreamsTheSharedChatContractAndAccountsTokens() throws Exception {
        chatManifest();
        var model = list(object(get(owner("/api/models"), null)).get("models")).getLast();
        assertThat(model).containsEntry("ui", null).containsEntry("chatUnavailableReason", null)
                .containsEntry("capabilities", Map.of("chat", true, "infer", false));
        var response = postJson(owner("/api/chat"), chat("pebby:latest"), null);
        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(lines(response.body())).containsExactly(
                Map.of("content", "Hello from runtime", "done", false),
                Map.of("content", "!", "done", true, "outputTokens", 4));
        assertThat(json.readTree(HOSTAI.lastChatBody.get())).isEqualTo(json.readTree(chat("pebby:latest")));
        assertThat(registry.requests().getFirst().status()).isEqualTo("completed");
        assertThat(registry.requests().getFirst().outputTokens()).isEqualTo(4);
        assertProblem(postJson(owner("/api/infer"), INFER, null), 400);
        assertThat(HOSTAI.infers.get()).isZero();
        assertThat(OLLAMA.chats.get()).isZero();
    }

    @Test void chatAcceptsCompleteJsonAndRecordsTerminalErrorsAsFailures() throws Exception {
        chatManifest();
        HOSTAI.chatType = "application/json";
        HOSTAI.chatBody = "{\"content\":\"Complete answer\",\"done\":true}";
        var response = postJson(owner("/api/chat"), chat("pebby:latest"), null);
        assertThat(lines(response.body())).containsExactly(Map.of("content", "Complete answer", "done", true));
        HOSTAI.chatType = "application/x-ndjson";
        HOSTAI.chatBody = "{\"content\":\"partial\",\"done\":false}\n{\"content\":\"\",\"done\":true,\"error\":\"bad \\u0007thing\"}\n";
        var failed = postJson(owner("/api/chat"), chat("pebby:latest"), null);
        assertThat(lines(failed.body()).getLast()).containsEntry("done", true).containsEntry("error", "bad thing");
        assertThat(registry.requests().getFirst().status()).isEqualTo("failed");
        assertThat(registry.requests().getFirst().outputTokens()).isNull();
    }

    @Test void chatRejectsMalformedRecordsIncompleteStreamsAndRuntimeFailures() throws Exception {
        chatManifest();
        for (String body : List.of("{}", "{\"content\":2,\"done\":true}",
                "{\"content\":\"x\",\"done\":\"true\"}", "{\"content\":\"x\",\"done\":true,\"outputTokens\":-1}",
                "{\"content\":\"x\",\"done\":true,\"outputTokens\":0.5}",
                "{\"content\":\"x\",\"done\":true,\"outputTokens\":9223372036854775808}",
                "{\"content\":\"x\",\"done\":false,\"error\":\"failure\"}")) {
            HOSTAI.chatBody = body;
            assertProblem(postJson(owner("/api/chat"), chat("pebby:latest"), null), 502);
        }
        HOSTAI.chatBody = "{\"content\":\"partial\",\"done\":false}\n";
        var incomplete = postJson(owner("/api/chat"), chat("pebby:latest"), null);
        assertThat(lines(incomplete.body()).getLast()).containsEntry("done", true).containsKey("error");
        assertThat(registry.requests().getFirst().status()).isEqualTo("failed");
        HOSTAI.chatType = "application/json";
        assertProblem(postJson(owner("/api/chat"), chat("pebby:latest"), null), 502);
        HOSTAI.chatStatus = 404;
        assertProblem(postJson(owner("/api/chat"), chat("pebby:latest"), null), 502);
        HOSTAI.chatStatus = 400; HOSTAI.chatBody = "{\"error\":\"Unsupported\\nmessage\"}";
        var rejected = postJson(owner("/api/chat"), chat("pebby:latest"), null);
        assertProblem(rejected, 400);
        assertThat(object(rejected)).containsEntry("detail", "Unsupportedmessage");
    }

    @Test void cancellingHostAiChatReleasesTheSharedLease() throws Exception {
        chatManifest(); HOSTAI.holdChat = true;
        try (var response = stream(owner("/api/chat"), chat("pebby:latest"))) {
            assertThat(readLine(response)).contains("started");
            assertThat(registry.counters().activeRequests()).isEqualTo(1);
        }
        await().atMost(Duration.ofSeconds(3)).untilAsserted(() -> {
            assertThat(registry.counters().activeRequests()).isZero();
            assertThat(registry.requests().getFirst().status()).isEqualTo("cancelled");
        });
        HOSTAI.release.countDown();
    }

    @Test void capabilitiesOverridePerModelAndGateUiAndSharing() throws Exception {
        HOSTAI.manifestBody = """
                {"protocol":1,"runtime":"pebby","ui":{"entry":"/ui/index.html"},"interaction":%s,
                 "capabilities":{"chat":false,"infer":true},"models":[
                  {"name":"chat:latest","sizeBytes":1,"capabilities":{"chat":true,"infer":false}},
                  {"name":"both:latest","sizeBytes":1,"capabilities":{"chat":true,"infer":true}},
                  {"name":"none:latest","sizeBytes":1,"capabilities":{"chat":false,"infer":false}},
                  {"name":"pebby:latest","sizeBytes":1}]}
                """.formatted(HostAiRuntimeStub.INTERACTION);
        var models = list(object(get(owner("/api/models"), null)).get("models"));
        assertThat(models.get(2)).containsEntry("ui", null).containsEntry("capabilities", Map.of("chat", true, "infer", false));
        assertThat(models.get(3)).containsEntry("capabilities", Map.of("chat", true, "infer", true)).doesNotContainEntry("ui", null);
        assertThat(models.get(4)).containsEntry("ui", null).containsEntry("capabilities", Map.of("chat", false, "infer", false));
        assertThat(models.get(5)).containsEntry("capabilities", Map.of("chat", false, "infer", true)).doesNotContainEntry("ui", null);
        assertThat(postJson(owner("/api/chat"), chat("both:latest"), null).statusCode()).isEqualTo(200);
        assertThat(postJson(owner("/api/infer"), INFER.replace("pebby:latest", "both:latest"), null).statusCode()).isEqualTo(200);
        assertProblem(postJson(owner("/api/chat"), chat("none:latest"), null), 400);
        assertProblem(postJson(owner("/api/sharing/start"), "{\"model\":\"none:latest\",\"hostLabel\":\"Fixture\"}", null), 503);
        assertThat(postJson(owner("/api/sharing/start"), "{\"model\":\"chat:latest\",\"hostLabel\":\"Fixture\"}", null).statusCode()).isEqualTo(200);
    }

    @Test void legacyWithoutUiStaysInferOnlyAndMalformedCapabilitiesDoNotEnableChat() throws Exception {
        HOSTAI.manifestBody = HostAiRuntimeStub.MANIFEST.replace("\"ui\":{\"entry\":\"/ui/index.html\"},", "");
        var legacy = list(object(get(owner("/api/models"), null)).get("models")).getLast();
        assertThat(legacy).containsEntry("ui", null).containsEntry("capabilities", Map.of("chat", false, "infer", true));
        assertProblem(postJson(owner("/api/chat"), chat("pebby:latest"), null), 400);
        assertThat(postJson(owner("/api/infer"), INFER, null).statusCode()).isEqualTo(200);
        for (String caps : List.of("null", "{}", "true", "{\"chat\":\"true\",\"infer\":false}", "{\"chat\":true,\"infer\":1}")) {
            HOSTAI.manifestBody = HostAiRuntimeStub.MANIFEST.replace("\"vendor\":\"ignored\"", "\"capabilities\":" + caps);
            assertThat(list(object(get(owner("/api/models"), null)).get("models")))
                    .extracting(item -> item.get("name")).doesNotContain("pebby:latest");
        }
        assertThat(HOSTAI.chats.get()).isZero();
    }

    @Test void guestChatUsesHostAiRuntimeAndReportsCapabilityChanges() throws Exception {
        chatManifest();
        var started = postJson(owner("/api/sharing/start"), "{\"model\":\"pebby:latest\",\"hostLabel\":\"Fixture\"}", null);
        assertThat(started.statusCode()).isEqualTo(200);
        String guest = (String) object(started).get("guestUrl");
        String token = (String) object(postJson(owner("/api/sharing/grants"), "{\"label\":\"Guest\",\"expiresInHours\":1}", null)).get("token");
        assertThat(object(get(guest + "/guest/v1/session", token)))
                .containsEntry("ui", null).containsEntry("available", true)
                .containsEntry("capabilities", Map.of("chat", true, "infer", false));
        assertThat(postJson(guest + "/guest/v1/chat", chat("pebby:latest"), null).statusCode()).isEqualTo(401);
        var response = postJson(guest + "/guest/v1/chat", chat("pebby:latest"), token);
        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(lines(response.body()).getFirst()).containsEntry("content", "Hello from runtime");
        HOSTAI.manifestBody = HOSTAI.manifestBody.replace("\"chat\":true", "\"chat\":false");
        assertThat(object(get(guest + "/guest/v1/session", token))).containsEntry("available", false)
                .containsEntry("capabilities", Map.of("chat", false, "infer", false));
        assertThat(postJson(guest + "/guest/v1/chat", chat("pebby:latest"), token).statusCode()).isEqualTo(503);
        assertThat(HOSTAI.chats.get()).isEqualTo(1);
    }

    @Test void inferenceRequiresDiscoverableInstructionsSchemasAndExamples() throws Exception {
        for (String contract : List.of("null", "{}", HostAiRuntimeStub.INTERACTION.replace("Send an operation as JSON; each request is independent.", " "),
                HostAiRuntimeStub.INTERACTION.replace("\"inputSchema\"", "\"missingSchema\""),
                HostAiRuntimeStub.INTERACTION.replace("\"type\":\"object\"", "\"type\":\"unknown\""),
                HostAiRuntimeStub.INTERACTION.replace("\"examples\"", "\"missingExamples\""),
                HostAiRuntimeStub.INTERACTION.replace("\"output\":", "\"missingOutput\":"))) {
            HOSTAI.manifestBody = HostAiRuntimeStub.MANIFEST.replace(HostAiRuntimeStub.INTERACTION, contract);
            assertThat(list(object(get(owner("/api/models"), null)).get("models")))
                    .extracting(item -> item.get("name")).doesNotContain("pebby:latest");
        }
        HOSTAI.manifestBody = HostAiRuntimeStub.MANIFEST;
        var model = list(object(get(owner("/api/models"), null)).get("models")).getLast();
        assertThat(json.<tools.jackson.databind.JsonNode>valueToTree(model.get("interaction"))).isEqualTo(json.readTree(HostAiRuntimeStub.INTERACTION));
        assertThat(HOSTAI.infers.get()).isZero();
        assertThat(HOSTAI.assetPaths).isEmpty();
    }

    @Test void contractLimitsCountUnicodeCharactersLikeThePythonSdk() throws Exception {
        String instructions = "😀".repeat(16_384);
        HOSTAI.manifestBody = HostAiRuntimeStub.MANIFEST.replace("Send an operation as JSON; each request is independent.", instructions);
        var model = list(object(get(owner("/api/models"), null)).get("models")).getLast();
        assertThat(model.get("name")).isEqualTo("pebby:latest");
        HOSTAI.manifestBody = HostAiRuntimeStub.MANIFEST.replace("Send an operation as JSON; each request is independent.", instructions + "😀");
        assertThat(list(object(get(owner("/api/models"), null)).get("models")))
                .extracting(item -> item.get("name")).doesNotContain("pebby:latest");
    }

    @Test void customUiRequiresHtmlInADedicatedAssetDirectory() throws Exception {
        for (String entry : List.of("/index.html", "/ui/app.js", "/ui/app.json")) {
            HOSTAI.manifestBody = HostAiRuntimeStub.MANIFEST.replace("/ui/index.html", entry);
            assertThat(list(object(get(owner("/api/models"), null)).get("models")))
                    .extracting(item -> item.get("name")).doesNotContain("pebby:latest");
            assertThat(get(owner("/api/model-ui/pebby/private/notes.txt"), null).statusCode()).isEqualTo(404);
        }
        assertThat(HOSTAI.assetPaths).isEmpty();
    }

    @Test void cliDiscoversAndInvokesBothModesWithoutFetchingUi() throws Exception {
        var custom = json.readTree(cli(null, owner(""), "describe", "pebby:latest", "--json"));
        assertThat(custom.get("infer").get("instructions").asString()).contains("each request is independent");
        assertThat(cli(null, owner(""), "infer", "pebby:latest", "{\"op\":\"info\"}")).contains("\"done\":true");
        assertThat(cli(null, owner(""), "chat", "fixture-shared:small", "Hello", "--json")).contains("\"done\":true");
        var started = object(postJson(owner("/api/sharing/start"), "{\"model\":\"pebby:latest\",\"hostLabel\":\"CLI fixture\"}", null));
        String token = (String) object(postJson(owner("/api/sharing/grants"), "{\"label\":\"CLI\",\"expiresInHours\":1}", null)).get("token");
        String guest = (String) started.get("guestUrl");
        assertThat(cli(token, guest, "describe", "pebby:latest", "--guest", "--json")).contains("inputSchema", "/guest/v1/infer");
        assertThat(cli(token, guest, "infer", "pebby:latest", "{\"op\":\"info\"}", "--guest")).contains("\"done\":true");
        assertThat(HOSTAI.infers.get()).isEqualTo(2);
        assertThat(HOSTAI.assetPaths).isEmpty();
    }

    private String cli(String token, String origin, String... arguments) throws Exception {
        var command = new java.util.ArrayList<>(List.of("node", "../scripts/hostai.mjs"));
        command.addAll(List.of(arguments)); command.addAll(List.of("--url", origin));
        var builder = new ProcessBuilder(command).redirectErrorStream(true);
        builder.environment().remove("HOSTAI_ACCESS_TOKEN");
        if (token != null) builder.environment().put("HOSTAI_ACCESS_TOKEN", token);
        Process child = builder.start();
        try {
            assertThat(child.waitFor(10, TimeUnit.SECONDS)).isTrue();
            String output = new String(child.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            assertThat(child.exitValue()).as(output).isZero();
            return output;
        } finally { child.destroyForcibly(); child.waitFor(5, TimeUnit.SECONDS); }
    }

    @Test void inferStreamsSingleJsonAndNdjsonAndRecordsHistoryWithoutTokens() throws Exception {
        var single = postJson(owner("/api/infer"), INFER, null);
        assertThat(single.statusCode()).isEqualTo(200);
        assertThat(single.headers().firstValue("content-type").orElseThrow()).startsWith("application/x-ndjson");
        assertThat(single.headers().firstValue("cache-control")).contains("no-store");
        assertThat(lines(single.body())).containsExactly(Map.of("event", Map.of("ok", true, "echo", "private input"), "done", true));
        assertThat(object(json.readValue(HOSTAI.lastInferBody.get(), Map.class)))
                .containsEntry("model", "pebby:latest")
                .containsEntry("input", Map.of("board", List.of(List.of(0, 1)), "action", "private input"));
        assertThat(object(json.readValue(HOSTAI.lastInferBody.get(), Map.class)).keySet()).containsExactlyInAnyOrder("model", "input");
        HOSTAI.infer = HostAiRuntimeStub.Infer.NDJSON;
        var streamed = postJson(owner("/api/infer"), INFER, null);
        assertThat(streamed.statusCode()).isEqualTo(200);
        assertThat(lines(streamed.body())).containsExactly(
                Map.of("event", Map.of("step", 1), "done", false),
                Map.of("event", Map.of("step", 2), "done", true));
        await().atMost(Duration.ofSeconds(2)).untilAsserted(() -> {
            var latest = registry.requests().getFirst();
            assertThat(latest.model()).isEqualTo("pebby:latest");
            assertThat(latest.status()).isEqualTo("completed");
            assertThat(latest.outputTokens()).isNull();
        });
        assertThat(get(owner("/api/requests"), null).body()).doesNotContain("private input", "board");
        HOSTAI.infer = HostAiRuntimeStub.Infer.NDJSON_ERROR;
        var failed = postJson(owner("/api/infer"), INFER, null);
        assertThat(failed.statusCode()).isEqualTo(200);
        assertThat(lines(failed.body())).containsExactly(
                Map.of("event", Map.of("step", 1), "done", false),
                Map.of("done", true, "error", "bad thing"));
        await().atMost(Duration.ofSeconds(2)).untilAsserted(() ->
                assertThat(registry.requests().getFirst().status()).isEqualTo("failed"));
        assertThat(HOSTAI.infers.get()).isEqualTo(3);
    }

    @Test void inferRejectionsAreProblemsBeforeStreamingAndOllamaModelsOnlyChat() throws Exception {
        HOSTAI.infer = HostAiRuntimeStub.Infer.REJECT;
        var rejected = postJson(owner("/api/infer"), INFER, null);
        assertProblem(rejected, 400);
        assertThat((String) object(rejected).get("detail")).isEqualTo("Unknownaction");
        HOSTAI.infer = HostAiRuntimeStub.Infer.SERVER_ERROR;
        var upstream = postJson(owner("/api/infer"), INFER, null);
        assertProblem(upstream, 502);
        assertThat(upstream.body()).doesNotContain("private failure");
        var ollama = postJson(owner("/api/infer"), INFER.replace("pebby:latest", "fixture-shared:small"), null);
        assertProblem(ollama, 400);
        assertThat((String) object(ollama).get("detail")).isEqualTo("This model only supports chat.");
        var chat = postJson(owner("/api/chat"), chat("pebby:latest"), null);
        assertProblem(chat, 400);
        int infers = HOSTAI.infers.get();
        long total = registry.counters().totalRequests();
        for (String invalid : List.of("{}", "{\"model\":\"pebby:latest\"}", "{\"input\":{}}",
                "{\"model\":\"pebby:latest\",\"input\":{},\"extra\":1}", "{\"model\":\"bad name\",\"input\":1}", "not json")) {
            assertProblem(postJson(owner("/api/infer"), invalid, null), 400);
        }
        assertThat(postJson(owner("/api/infer"), "{\"model\":\"pebby:latest\",\"input\":\"" + "x".repeat(300_000) + "\"}", null).statusCode()).isEqualTo(413);
        assertThat(HOSTAI.infers.get()).isEqualTo(infers);
        assertThat(registry.counters().totalRequests()).isEqualTo(total);
        assertThat(OLLAMA.chats.get()).isZero();
    }

    @Test void inferSharesTheTwoInferenceSlotsWithChat() throws Exception {
        HOSTAI.infer = HostAiRuntimeStub.Infer.HOLD;
        try (InputStream first = stream(owner("/api/infer"), INFER); InputStream second = stream(owner("/api/infer"), INFER)) {
            assertThat(readLine(first)).contains("\"done\":false");
            assertThat(readLine(second)).contains("\"done\":false");
            assertThat(registry.counters().activeRequests()).isEqualTo(2);
            assertProblem(postJson(owner("/api/infer"), INFER, null), 429);
            var chat = postJson(owner("/api/chat"), chat("fixture-shared:small"), null);
            assertProblem(chat, 429);
            assertThat(chat.headers().firstValue("Retry-After")).contains("1");
            assertThat(OLLAMA.chats.get()).isZero();
        }
        HOSTAI.release.countDown();
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
            assertThat(registry.counters().activeRequests()).isZero();
            assertThat(registry.requests().subList(0, 2)).allMatch(request -> request.status().equals("cancelled"));
        });
    }

    @Test void assetProxyValidatesPathsSetsHeadersAndNeverFramesDeny() throws Exception {
        var index = get(owner("/api/model-ui/pebby/ui/index.html"), null);
        assertThat(index.statusCode()).isEqualTo(200);
        assertThat(index.headers().firstValue("content-type")).contains("text/html;charset=utf-8");
        assertThat(index.body()).contains("hostai-bridge.js");
        assertModelUiHeaders(index, "http://127.0.0.1:" + port);
        var nested = get(owner("/api/model-ui/pebby/ui/nested/deep.css"), null);
        assertThat(nested.statusCode()).isEqualTo(200);
        assertThat(nested.headers().firstValue("content-type")).contains("text/css;charset=utf-8");
        var script = get(owner("/api/model-ui/pebby/ui/app.js"), null);
        assertThat(script.headers().firstValue("content-type")).contains("text/javascript;charset=utf-8");
        assertThat(HOSTAI.assetPaths).containsExactly("/ui/index.html", "/ui/nested/deep.css", "/ui/app.js");
        HOSTAI.assetPaths.clear();
        for (String path : List.of("/api/model-ui/pebby/ui/%2e%2e/index.html", "/api/model-ui/pebby/ui/..%2findex.html",
                "/api/model-ui/unknown/ui/index.html", "/api/model-ui/ollama/ui/index.html",
                "/api/model-ui/pebby/ui/secret.exe", "/api/model-ui/pebby/other/app.js", "/api/model-ui/pebby/app.js",
                "/api/model-ui/pebby/ui/app.js?v=1", "/api/model-ui/pebby/ui/noextension",
                "/api/model-ui/pebby/a/b/c/d/e/f/g/h/i.js", "/api/model-ui/Pebby/ui/index.html", "/api/model-ui/pebby/")) {
            var response = get(owner(path), null);
            assertThat(response.statusCode()).as(path).isEqualTo(404);
            assertThat(response.body()).doesNotContain("MZ");
        }
        String raw = rawGet("/api/model-ui/pebby/ui/../index.html");
        assertThat(raw.substring(0, raw.indexOf("\r\n"))).matches("HTTP/1.1 (400|404).*");
        assertThat(HOSTAI.assetPaths).isEmpty();
        assertThat(get(owner("/api/model-ui/pebby/ui/missing.js"), null).statusCode()).isEqualTo(404);
        assertThat(get(owner("/api/model-ui/pebby/ui/big.js"), null).statusCode()).isEqualTo(502);
        assertThat(HOSTAI.assetPaths).containsExactly("/ui/missing.js", "/ui/big.js");
    }

    @Test void bridgeScriptComesFromTheGatewayAtAnyDepth() throws Exception {
        for (String path : List.of("/api/model-ui/pebby/ui/hostai-bridge.js", "/api/model-ui/pebby/ui/nested/deep/hostai-bridge.js",
                "/api/model-ui/pebby/hostai-bridge.js")) {
            var response = get(owner(path), null);
            assertThat(response.statusCode()).as(path).isEqualTo(200);
            assertThat(response.headers().firstValue("content-type")).contains("text/javascript;charset=utf-8");
            assertThat(response.body()).contains("window.hostai").contains("postMessage");
            assertModelUiHeaders(response, "http://127.0.0.1:" + port);
        }
        assertThat(get(owner("/api/model-ui/unknown/ui/hostai-bridge.js"), null).statusCode()).isEqualTo(404);
        assertThat(HOSTAI.assetPaths).isEmpty();
    }

    @Test void guestSessionInferAndModelUiFollowSharing() throws Exception {
        var started = postJson(owner("/api/sharing/start"), json.writeValueAsString(Map.of("model", "pebby:latest", "hostLabel", "Fixture host")), null);
        assertThat(started.statusCode()).isEqualTo(200);
        String guest = (String) object(started).get("guestUrl");
        var created = postJson(owner("/api/sharing/grants"), json.writeValueAsString(Map.of("label", "Fixture visitor", "expiresInHours", 1)), null);
        String token = (String) object(created).get("token");
        var session = get(guest + "/guest/v1/session", token);
        assertThat(session.statusCode()).isEqualTo(200);
        assertThat(object(session)).containsEntry("model", "pebby:latest").containsEntry("available", true)
                .containsEntry("ui", Map.of("runtime", "pebby", "entry", "ui/index.html"));
        assertThat(postJson(guest + "/guest/v1/infer", INFER, null).statusCode()).isEqualTo(401);
        assertThat(postJson(guest + "/guest/v1/infer", INFER, "not-a-key").statusCode()).isEqualTo(401);
        assertThat(rawPost(guest + "/guest/v1/infer", INFER, token, "text/plain").statusCode()).isEqualTo(415);
        assertThat(postJson(guest + "/guest/v1/infer", INFER.replace("pebby:latest", "fixture-shared:small"), token).statusCode()).isEqualTo(403);
        assertThat(postJson(guest + "/guest/v1/infer", "{\"model\":\"pebby:latest\"}", token).statusCode()).isEqualTo(400);
        assertThat(HOSTAI.infers.get()).isZero();
        HOSTAI.infer = HostAiRuntimeStub.Infer.NDJSON;
        var infer = postJson(guest + "/guest/v1/infer", INFER, token);
        assertThat(infer.statusCode()).isEqualTo(200);
        assertThat(infer.headers().firstValue("content-type").orElseThrow()).startsWith("application/x-ndjson");
        assertThat(lines(infer.body())).containsExactly(
                Map.of("event", Map.of("step", 1), "done", false),
                Map.of("event", Map.of("step", 2), "done", true));
        var page = get(guest + "/", null);
        assertThat(page.headers().firstValue("Content-Security-Policy").orElseThrow()).contains("frame-src 'self'").contains("frame-ancestors 'none'");
        assertThat(page.headers().firstValue("X-Frame-Options")).contains("DENY");
        var asset = get(guest + "/guest/v1/model-ui/pebby/ui/index.html", null);
        assertThat(asset.statusCode()).isEqualTo(200);
        assertThat(asset.headers().firstValue("content-type")).contains("text/html;charset=utf-8");
        assertModelUiHeaders(asset, guest);
        assertThat(asset.headers().firstValue("Cross-Origin-Resource-Policy")).isEmpty();
        var bridge = get(guest + "/guest/v1/model-ui/pebby/ui/hostai-bridge.js", null);
        assertThat(bridge.statusCode()).isEqualTo(200);
        assertThat(bridge.body()).contains("window.hostai");
        for (String path : List.of("/guest/v1/model-ui/ollama/ui/index.html", "/guest/v1/model-ui/pebby/ui/secret.exe",
                "/guest/v1/model-ui/pebby/other/app.js", "/guest/v1/model-ui/pebby/ui/%2e%2e/index.html"))
            assertThat(get(guest + path, null).statusCode()).as(path).isEqualTo(404);
        assertThat(postJson(owner("/api/sharing/stop"), "{}", null).statusCode()).isEqualTo(200);
        assertThat(get(guest + "/guest/v1/model-ui/pebby/ui/index.html", null).statusCode()).isEqualTo(404);
        assertThat(postJson(owner("/api/sharing/start"), json.writeValueAsString(Map.of("model", "fixture-shared:small", "hostLabel", "Fixture host")), null).statusCode()).isEqualTo(200);
        assertThat(get(guest + "/guest/v1/model-ui/pebby/ui/index.html", null).statusCode()).isEqualTo(404);
        assertThat(get(guest + "/guest/v1/model-ui/pebby/ui/hostai-bridge.js", null).statusCode()).isEqualTo(404);
        assertThat(HOSTAI.assetPaths).containsExactly("/ui/index.html");
    }

    private static void assertModelUiHeaders(HttpResponse<String> response, String origin) {
        assertThat(response.headers().firstValue("Cache-Control")).contains("no-store");
        assertThat(response.headers().firstValue("X-Content-Type-Options")).contains("nosniff");
        assertThat(response.headers().firstValue("Referrer-Policy")).contains("no-referrer");
        assertThat(response.headers().firstValue("X-Frame-Options")).isEmpty();
        assertThat(response.headers().firstValue("Content-Security-Policy").orElseThrow()).isEqualTo(ModelUiAssets.csp(origin))
                .contains("script-src 'self' " + origin).contains("frame-ancestors 'self' " + origin).contains("connect-src 'none'");
    }

    private String rawGet(String path) throws Exception {
        try (var socket = new java.net.Socket("127.0.0.1", port)) {
            socket.setSoTimeout(5000);
            socket.getOutputStream().write(("GET " + path + " HTTP/1.1\r\nHost: 127.0.0.1:" + port
                    + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            return new String(socket.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private String owner(String path) { return "http://127.0.0.1:" + port + path; }
    private String chat(String model) {
        return json.writeValueAsString(Map.of("model", model, "messages", List.of(Map.of("role", "user", "content", "Fixture prompt")), "temperature", 0.7, "maxTokens", 32));
    }
    private HttpRequest.Builder request(String uri, String token) {
        var result = HttpRequest.newBuilder(URI.create(uri)).timeout(Duration.ofSeconds(15));
        if (token != null) result.header("Authorization", "Bearer " + token);
        return result;
    }
    private HttpResponse<String> get(String uri, String token) throws Exception {
        return client.send(request(uri, token).GET().build(), HttpResponse.BodyHandlers.ofString());
    }
    private HttpResponse<String> postJson(String uri, String body, String token) throws Exception {
        return rawPost(uri, body, token, "application/json");
    }
    private HttpResponse<String> rawPost(String uri, String body, String token, String type) throws Exception {
        return client.send(request(uri, token).header("Content-Type", type).header("Accept", "application/x-ndjson, application/problem+json, application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
    }
    private InputStream stream(String uri, String body) throws Exception {
        HttpResponse<InputStream> response = client.sendAsync(request(uri, null).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofInputStream()).get(5, TimeUnit.SECONDS);
        if (response.statusCode() != 200) { response.body().close(); throw new AssertionError("Expected streaming HTTP 200; got " + response.statusCode()); }
        return response.body();
    }
    private static String readLine(InputStream stream) throws Exception {
        return new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8)).readLine();
    }
    private void assertProblem(HttpResponse<String> response, int status) {
        assertThat(response.statusCode()).as(response.body()).isEqualTo(status);
        assertThat(response.headers().firstValue("content-type").orElseThrow()).startsWith("application/problem+json");
        assertThat(object(response)).containsEntry("status", status).containsKeys("title", "detail");
        assertThat(response.body()).doesNotContain("private input");
    }
    @SuppressWarnings("unchecked") private static Map<String, Object> object(Object value) { return (Map<String, Object>) value; }
    private Map<String, Object> object(HttpResponse<String> response) { return object(json.readValue(response.body(), Map.class)); }
    @SuppressWarnings("unchecked") private static List<Map<String, Object>> list(Object value) { return (List<Map<String, Object>>) value; }
    private List<Map<String, Object>> lines(String body) {
        return body.lines().filter(line -> !line.isBlank()).map(line -> object(json.readValue(line, Map.class))).toList();
    }
}
