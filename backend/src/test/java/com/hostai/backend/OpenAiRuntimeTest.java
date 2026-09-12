package com.hostai.backend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.Disposable;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;
import reactor.netty.DisposableServer;
import reactor.netty.resources.LoopResources;
import reactor.test.StepVerifier;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** An OpenAI-compatible engine on an ephemeral loopback port; never a real model or network. */
class OpenAiRuntimeTest {
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final String MODEL = "Qwen/Qwen2.5-7B-Instruct";
    private static final Api.ChatRequest REQUEST = new Api.ChatRequest(MODEL,
            List.of(new Api.Message("system", "Be brief"), new Api.Message("user", "Fixture prompt")), 0.7, 32);
    private static final Api.ChatChunk HEL = new Api.ChatChunk("Hel", false, null, null);
    private static final Api.ChatChunk LO = new Api.ChatChunk("lo", false, null, null);
    private static Engine engine;
    private OpenAiRuntime runtime;

    @BeforeAll static void start() { engine = new Engine(); }
    @AfterAll static void stop() { engine.close(); }

    @BeforeEach void prepare() {
        engine.reset();
        runtime = runtime(engine.origin(), Duration.ofSeconds(2), Duration.ofSeconds(5));
    }

    @AfterEach void clean() {
        // Held streams end when the client closes its connection; every test must leave none open.
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(engine.connections.get()).isZero());
    }

    private static OpenAiRuntime runtime(String origin, Duration idle, Duration generation) {
        WebClient client = BackendConfiguration.runtimeClient(LocalOllamaEndpoint.parse(origin, "TEST"));
        return new OpenAiRuntime("vllm", client, Schedulers.immediate(), Duration.ofSeconds(2), idle, generation);
    }

    @Test void listsModelsWithoutMetadataAndDerivesConnected() {
        engine.modelsBody = """
                {"object":"list","data":[{"id":"Qwen/Qwen2.5-7B-Instruct","object":"model","owned_by":"vllm","permission":[]},
                 {"id":"remote:cloud","object":"model"}]}
                """;
        Api.Models models = runtime.models().block(Duration.ofSeconds(5));
        assertThat(models).isNotNull();
        assertThat(models.connected()).isTrue();
        assertThat(models.models()).containsExactly(
                new Api.Model(MODEL, 0, "", "", "", null, null, Api.Capabilities.CHAT),
                new Api.Model("remote:cloud", 0, "", "", "", "Cloud models are not supported by this local gateway.", null,
                        Api.Capabilities.CHAT));
        assertThat(runtime.connected().block(Duration.ofSeconds(5))).isTrue();
        assertThat(runtime.id()).isEqualTo("vllm");
        assertThat(runtime.ui()).isNull();
        assertThat(engine.unexpected.get()).isZero();

        for (String body : List.of("{\"object\":\"list\"}", "{\"data\":[{\"object\":\"model\"}]}", "{\"data\":[{\"id\":\" \"}]}",
                "{\"data\":\"x\"}", "not json")) {
            engine.modelsBody = body;
            assertThat(runtime.models().block(Duration.ofSeconds(5))).as(body).isEqualTo(new Api.Models(List.of(), false));
        }
        engine.modelsStatus = 500;
        assertThat(runtime.connected().block(Duration.ofSeconds(5))).isFalse();
        assertThat(runtime(closedOrigin(), Duration.ofSeconds(2), Duration.ofSeconds(5)).models().block(Duration.ofSeconds(5)))
                .isEqualTo(new Api.Models(List.of(), false));
    }

    @Test void explicitConfigurationRoutesCatalogAndChatWithoutProbingOllamaOrStartingAnEngine() {
        var ollama = LocalOllamaEndpoint.parse("http://127.0.0.1:1", "TEST");
        var origins = RuntimeCatalog.origins("", ollama, engine.origin());
        assertThat(origins).hasSize(1);
        assertThat(origins.getFirst().openai()).isTrue();
        var catalog = new RuntimeCatalog(origins, Schedulers.immediate(), Duration.ofSeconds(2),
                Duration.ofSeconds(2), Duration.ofSeconds(5));
        engine.modelsBody = "{\"data\":[{\"id\":\"" + MODEL + "\"}]}";
        var read = catalog.read().block(Duration.ofSeconds(5));
        assertThat(read.models().connected()).isTrue();
        assertThat(read.forModel(MODEL)).isInstanceOf(OpenAiRuntime.class);
        assertThat(catalog.displayUrl()).isEqualTo(engine.origin());
        engine.chat = sse(content("Hel"), finish("stop"), "[DONE]");
        StepVerifier.create(read.forModel(MODEL).chat(REQUEST)).expectNext(HEL, new Api.ChatChunk("", true, null, null)).verifyComplete();
        assertThat(engine.unexpected.get()).isZero();
        assertThat(RuntimeCatalog.origins("", ollama, "")).hasSize(1).allMatch(origin -> !origin.openai());
        assertThat(RuntimeCatalog.origins(ollama.displayUrl(), ollama, engine.origin())).hasSize(2);
        assertThatThrownBy(() -> RuntimeCatalog.origins("", ollama, "https://example.com")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test void mapsChatRequestToStreamingCompletionsCall() {
        engine.chat = sse(finish("stop"), "[DONE]");
        StepVerifier.create(runtime.chat(REQUEST)).expectNext(new Api.ChatChunk("", true, null, null)).verifyComplete();
        assertThat(engine.chats.get()).isEqualTo(1);
        assertThat(engine.lastAccept.get()).contains("text/event-stream");
        assertThat(engine.lastContentType.get()).startsWith("application/json");
        JsonNode expected = JSON.readTree("""
                {"model":"Qwen/Qwen2.5-7B-Instruct",
                 "messages":[{"role":"system","content":"Be brief"},{"role":"user","content":"Fixture prompt"}],
                 "temperature":0.7,"max_tokens":32,"stream":true,"stream_options":{"include_usage":true}}
                """);
        assertThat(JSON.readTree(engine.lastChatBody.get())).isEqualTo(expected);
    }

    @Test void streamsTokensAcrossSplitEventsAndReportsUsage() {
        String text = ": keep-alive\n\n"
                + "data: " + content("Hel") + "\n\n"
                + "id: 2\r\ndata: " + content("lo") + "\r\n\r\n"
                + "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":null}]}\n\n"
                + "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"\"},\"finish_reason\":null}]}\n\n"
                + "data: " + finish("stop") + "\n\n"
                + "data: {\"id\":\"c1\",\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":5,\"total_tokens\":8}}\n\n"
                + "data: [DONE]\n\n";
        for (int size : List.of(1, 5, 7, 4096)) {
            engine.chat = Flux.fromIterable(split(text, size));
            StepVerifier.create(runtime.chat(REQUEST)).expectNext(HEL, LO, new Api.ChatChunk("", true, 5L, null))
                    .verifyComplete();
        }
        // usage on the finish record (llama.cpp style) and no usage record at all
        engine.chat = sse(content("Hel"), "{\"choices\":[{\"delta\":{\"content\":\"lo\"},\"finish_reason\":\"length\"}],"
                + "\"usage\":{\"completion_tokens\":2}}", "[DONE]");
        StepVerifier.create(runtime.chat(REQUEST)).expectNext(HEL, LO, new Api.ChatChunk("", true, 2L, null)).verifyComplete();
        engine.chat = sse(content("Hel"), finish("stop"), "[DONE]");
        StepVerifier.create(runtime.chat(REQUEST)).expectNext(HEL, new Api.ChatChunk("", true, null, null)).verifyComplete();
        // records after the sentinel are never read
        engine.chat = sse(finish("stop"), "[DONE]", content("late"));
        StepVerifier.create(runtime.chat(REQUEST)).expectNext(new Api.ChatChunk("", true, null, null)).verifyComplete();
        assertThat(engine.unexpected.get()).isZero();
    }

    @Test void cancellationClosesTheEngineConnection() throws Exception {
        engine.chat = Flux.concat(sse(content("Hel")), Flux.never());
        CountDownLatch first = new CountDownLatch(1);
        AtomicReference<Api.ChatChunk> seen = new AtomicReference<>();
        Disposable subscription = runtime.chat(REQUEST).subscribe(chunk -> { seen.set(chunk); first.countDown(); });
        assertThat(first.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(seen.get()).isEqualTo(HEL);
        assertThat(engine.connections.get()).isEqualTo(1);
        subscription.dispose();
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
            assertThat(engine.cancelled.get()).isEqualTo(1);
            assertThat(engine.connections.get()).isZero();
        });
    }

    @Test void rejectsMalformedAndTruncatedStreams() {
        Map<String, List<Api.ChatChunk>> cases = new java.util.LinkedHashMap<>();
        cases.put("data: {not json\n\n", List.of());
        cases.put("data: [1,2]\n\n", List.of());
        cases.put("data: [DONE]\n\n", List.of());
        cases.put("data: " + content("Hel") + "\n\n", List.of(HEL));
        cases.put("data: " + content("Hel") + "\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"lo\"}", List.of(HEL));
        cases.put("data: " + finish("stop") + "\n\n", List.of());
        cases.put("data: " + finish("stop") + "\n\ndata: " + content("late") + "\n\ndata: [DONE]\n\n", List.of());
        cases.put("data: " + finish("unknown") + "\n\ndata: [DONE]\n\n", List.of());
        cases.put("data: {\"choices\":[{\"delta\":{},\"finish_reason\":true}]}\n\n", List.of());
        cases.put("data: {\"choices\":\"x\"}\n\n", List.of());
        cases.put("data: {\"choices\":[1]}\n\n", List.of());
        cases.put("data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\"}\n\n", List.of());
        cases.put("data: {\"choices\":[{\"delta\":\"x\"}]}\n\n", List.of());
        cases.put("data: " + finish("stop") + "\n\ndata: {\"choices\":[],\"usage\":{\"completion_tokens\":-1}}\n\ndata: [DONE]\n\n", List.of());
        cases.put("data: " + finish("stop") + "\n\ndata: {\"choices\":[],\"usage\":{\"completion_tokens\":1.5}}\n\ndata: [DONE]\n\n", List.of());
        cases.put("data: " + finish("stop") + "\n\ndata: {\"choices\":[],\"usage\":\"none\"}\n\ndata: [DONE]\n\n", List.of());
        cases.forEach((body, chunks) -> {
            engine.chat = Flux.just(body);
            assertGateway(body, HttpStatus.BAD_GATEWAY, chunks, "The model runtime returned an invalid or incomplete response.");
        });
        engine.chat = Flux.just("data: " + content("Hel") + "\n\ndata: {\"error\":{\"message\":\"private upstream detail\",\"code\":500}}\n\n");
        assertGateway("error record", HttpStatus.BAD_GATEWAY, List.of(HEL), "The engine reported a generation error.");
        engine.chatType = "application/json";
        engine.chat = Flux.just("{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"complete\"},\"finish_reason\":\"stop\"}]}");
        assertGateway("non-streaming JSON", HttpStatus.BAD_GATEWAY, List.of(), "The model runtime returned an invalid or incomplete response.");
    }

    @Test void providerErrorsAreGenericWithoutBodyLeak() {
        engine.chatType = "application/json";
        engine.chat = Flux.just("{\"error\":{\"message\":\"private upstream detail\",\"type\":\"invalid_request_error\"}}");
        for (Map.Entry<Integer, HttpStatus> entry : Map.of(400, HttpStatus.BAD_REQUEST, 404, HttpStatus.BAD_REQUEST,
                422, HttpStatus.BAD_REQUEST, 401, HttpStatus.BAD_GATEWAY, 500, HttpStatus.BAD_GATEWAY,
                429, HttpStatus.SERVICE_UNAVAILABLE, 503, HttpStatus.SERVICE_UNAVAILABLE).entrySet()) {
            engine.chatStatus = entry.getKey();
            assertGateway("status " + entry.getKey(), entry.getValue(), List.of(), null);
        }
        Throwable unreachable = failure(runtime(closedOrigin(), Duration.ofSeconds(2), Duration.ofSeconds(5)).chat(REQUEST));
        assertThat(unreachable).isInstanceOf(GatewayException.class);
        assertThat(((GatewayException) unreachable).status()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
    }

    @Test void rejectsToolCallsAndNonTextOutputInsteadOfCompletingEmpty() {
        String tools = "The model requested a tool call, which this gateway does not support.";
        engine.chat = sse("{\"choices\":[{\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call_1\","
                + "\"function\":{\"name\":\"lookup\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}", finish("tool_calls"), "[DONE]");
        assertGateway("delta.tool_calls", HttpStatus.BAD_GATEWAY, List.of(), tools);
        engine.chat = sse("{\"choices\":[{\"delta\":{\"function_call\":{\"name\":\"lookup\"}},\"finish_reason\":null}]}", "[DONE]");
        assertGateway("delta.function_call", HttpStatus.BAD_GATEWAY, List.of(), tools);
        engine.chat = sse(content("Hel"), finish("tool_calls"), "[DONE]");
        assertGateway("finish_reason tool_calls", HttpStatus.BAD_GATEWAY, List.of(HEL), tools);
        engine.chat = sse(finish("function_call"), "[DONE]");
        assertGateway("finish_reason function_call", HttpStatus.BAD_GATEWAY, List.of(), tools);
        engine.chat = sse("{\"choices\":[{\"delta\":{\"content\":[{\"type\":\"text\",\"text\":\"x\"}]},\"finish_reason\":null}]}",
                finish("stop"), "[DONE]");
        assertGateway("content parts", HttpStatus.BAD_GATEWAY, List.of(), "The model produced non-text output, which this gateway does not support.");
        engine.chat = sse("{\"choices\":[{\"delta\":{\"audio\":{\"data\":\"unsupported\"}},\"finish_reason\":null}]}", finish("stop"), "[DONE]");
        assertGateway("audio", HttpStatus.BAD_GATEWAY, List.of(), "The model produced non-text output, which this gateway does not support.");
        engine.chat = sse(finish("content_filter"), "[DONE]");
        assertGateway("content_filter", HttpStatus.BAD_GATEWAY, List.of(), "The engine stopped the generation with its content filter.");
        // absent, null and empty tool_calls are all "no tool call"
        engine.chat = sse("{\"choices\":[{\"delta\":{\"content\":\"Hel\",\"tool_calls\":null},\"finish_reason\":null}]}",
                "{\"choices\":[{\"delta\":{\"content\":\"lo\",\"tool_calls\":[]},\"finish_reason\":null}]}", finish("stop"), "[DONE]");
        StepVerifier.create(runtime.chat(REQUEST)).expectNext(HEL, LO, new Api.ChatChunk("", true, null, null)).verifyComplete();
    }

    @Test void enforcesIdleAndGenerationDeadlines() {
        engine.chat = Flux.concat(sse(content("Hel")), Flux.never());
        OpenAiRuntime idle = runtime(engine.origin(), Duration.ofMillis(300), Duration.ofSeconds(5));
        StepVerifier.create(idle.chat(REQUEST)).expectNext(HEL).expectErrorSatisfies(error -> {
            assertThat(error).isInstanceOf(GatewayException.class);
            assertThat(((GatewayException) error).status()).isEqualTo(HttpStatus.GATEWAY_TIMEOUT);
            assertThat(error.getMessage()).contains("no progress");
        }).verify(Duration.ofSeconds(5));
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(engine.connections.get()).isZero());

        engine.chat = Flux.interval(Duration.ofMillis(50)).map(tick -> "data: " + content("x") + "\n\n");
        OpenAiRuntime generation = runtime(engine.origin(), Duration.ofSeconds(2), Duration.ofMillis(400));
        Throwable error = failure(generation.chat(REQUEST));
        assertThat(error).isInstanceOf(GatewayException.class);
        assertThat(((GatewayException) error).status()).isEqualTo(HttpStatus.GATEWAY_TIMEOUT);
        assertThat(error.getMessage()).contains("exceeded its time limit");
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
            assertThat(engine.cancelled.get()).isEqualTo(2);
            assertThat(engine.connections.get()).isZero();
        });
    }

    @Test void inferAndAssetsAreNotPartOfTheProtocol() {
        StepVerifier.create(runtime.infer(MODEL, JSON.readTree("{\"board\":[]}"))).expectErrorSatisfies(error -> {
            assertThat(error).isInstanceOf(GatewayException.class);
            assertThat(((GatewayException) error).status()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(error.getMessage()).isEqualTo("This model only supports chat.");
        }).verify(Duration.ofSeconds(5));
        StepVerifier.create(runtime.asset("ui/index.html")).verifyComplete();
        assertThat(engine.chats.get()).isZero();
        assertThat(engine.unexpected.get()).isZero();
        WebClient client = BackendConfiguration.runtimeClient(LocalOllamaEndpoint.parse(engine.origin(), "TEST"));
        for (String id : java.util.Arrays.asList(null, "", "VLLM", "v llm", "a".repeat(33)))
            assertThatThrownBy(() -> new OpenAiRuntime(id, client, Schedulers.immediate(), Duration.ofSeconds(1),
                    Duration.ofSeconds(1), Duration.ofSeconds(1))).isInstanceOf(IllegalArgumentException.class);
    }

    /** The stream yields exactly {@code chunks} and then a GatewayException with {@code status}; no body text leaks. */
    private void assertGateway(String label, HttpStatus status, List<Api.ChatChunk> chunks, String message) {
        List<Api.ChatChunk> seen = new ArrayList<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        runtime.chat(REQUEST).doOnNext(seen::add).onErrorResume(error -> { failure.set(error); return Flux.empty(); })
                .blockLast(Duration.ofSeconds(10));
        assertThat(seen).as(label).isEqualTo(chunks);
        assertThat(failure.get()).as(label).isInstanceOf(GatewayException.class);
        assertThat(((GatewayException) failure.get()).status()).as(label).isEqualTo(status);
        assertThat(failure.get().getMessage()).as(label).doesNotContain("private", "upstream");
        if (message != null) assertThat(failure.get().getMessage()).as(label).isEqualTo(message);
        assertThat(seen).as(label).noneMatch(Api.ChatChunk::done);
    }

    /** The terminal error of a stream whose records are irrelevant; null when it completes. */
    private static Throwable failure(Flux<?> stream) {
        return stream.ignoreElements().then(Mono.<Throwable>empty()).onErrorResume(Mono::just).block(Duration.ofSeconds(10));
    }

    private static String content(String text) {
        return "{\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"model\":\"" + MODEL + "\",\"choices\":[{\"index\":0,\"delta\":{\"content\":"
                + JSON.writeValueAsString(text) + "},\"logprobs\":null,\"finish_reason\":null}]}";
    }

    private static String finish(String reason) {
        return "{\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"" + reason + "\"}]}";
    }

    private static Flux<String> sse(String... events) {
        return Flux.fromArray(events).map(event -> "data: " + event + "\n\n");
    }

    private static List<String> split(String text, int size) {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        List<String> pieces = new ArrayList<>();
        for (int offset = 0; offset < bytes.length; offset += size)
            pieces.add(new String(bytes, offset, Math.min(size, bytes.length - offset), StandardCharsets.ISO_8859_1));
        return pieces;
    }

    /** A loopback port nothing listens on. */
    private static String closedOrigin() {
        try (ServerSocket socket = new ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress())) {
            return "http://127.0.0.1:" + socket.getLocalPort();
        } catch (java.io.IOException error) { throw new java.io.UncheckedIOException(error); }
    }

    /** Speaks only the two OpenAI-compatible routes; counts connections and observes client cancellation. */
    private static final class Engine implements AutoCloseable {
        volatile int modelsStatus = 200;
        volatile String modelsBody = "{\"object\":\"list\",\"data\":[]}";
        volatile int chatStatus = 200;
        volatile String chatType = "text/event-stream";
        volatile Flux<String> chat = Flux.empty();
        final AtomicInteger connections = new AtomicInteger();
        final AtomicInteger chats = new AtomicInteger();
        final AtomicInteger cancelled = new AtomicInteger();
        final AtomicInteger unexpected = new AtomicInteger();
        final AtomicReference<String> lastChatBody = new AtomicReference<>();
        final AtomicReference<String> lastAccept = new AtomicReference<>();
        final AtomicReference<String> lastContentType = new AtomicReference<>();
        private final LoopResources loops = LoopResources.create("openai-test-engine", 1, true);
        private final DisposableServer server;

        Engine() {
            server = reactor.netty.http.server.HttpServer.create().host("127.0.0.1").port(0).runOn(loops)
                    .doOnConnection(connection -> {
                        connections.incrementAndGet();
                        connection.onDispose().doFinally(ignored -> connections.decrementAndGet()).subscribe();
                    })
                    .route(routes -> routes
                            .get("/v1/models", (request, response) -> response.status(modelsStatus)
                                    .header("Content-Type", "application/json").sendString(Mono.just(modelsBody)))
                            .post("/v1/chat/completions", (request, response) -> request.receive().aggregate().asString()
                                    .defaultIfEmpty("").flatMap(body -> {
                                        chats.incrementAndGet();
                                        lastChatBody.set(body);
                                        lastAccept.set(request.requestHeaders().get("Accept"));
                                        lastContentType.set(request.requestHeaders().get("Content-Type"));
                                        return response.status(chatStatus).header("Content-Type", chatType)
                                                .send(chat.doOnCancel(cancelled::incrementAndGet)
                                                        .map(piece -> io.netty.buffer.Unpooled.copiedBuffer(piece, StandardCharsets.ISO_8859_1)),
                                                        ignored -> true).then();
                                    }))
                            .route(ignored -> true, (request, response) -> { unexpected.incrementAndGet(); return response.status(404).send(); }))
                    .bindNow(Duration.ofSeconds(5));
        }

        String origin() { return "http://127.0.0.1:" + server.port(); }

        void reset() {
            modelsStatus = 200; modelsBody = "{\"object\":\"list\",\"data\":[]}"; chatStatus = 200; chatType = "text/event-stream";
            chat = Flux.empty(); chats.set(0); cancelled.set(0); unexpected.set(0);
            lastChatBody.set(null); lastAccept.set(null); lastContentType.set(null);
        }

        @Override public void close() {
            server.disposeNow(Duration.ofSeconds(5));
            loops.disposeLater(Duration.ZERO, Duration.ofSeconds(5)).block(Duration.ofSeconds(6));
        }
    }
}
