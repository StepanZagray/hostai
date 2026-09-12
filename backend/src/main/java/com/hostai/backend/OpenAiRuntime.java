package com.hostai.backend;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.core.codec.DecodingException;
import org.springframework.core.io.buffer.DataBufferLimitException;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientRequestException;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.publisher.SynchronousSink;
import reactor.core.scheduler.Scheduler;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * A local OpenAI-compatible engine (vLLM, llama.cpp server, LM Studio): GET /v1/models for discovery and
 * streamed POST /v1/chat/completions for chat. Text-only: tool calls and non-text output fail explicitly.
 * Never a model UI; opaque inference is not part of this protocol.
 */
public final class OpenAiRuntime implements InferenceRuntime {
    private static final ParameterizedTypeReference<ServerSentEvent<String>> EVENT = new ParameterizedTypeReference<>() {};
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final String DONE = "[DONE]";
    private final String id;
    private final WebClient client;
    private final Scheduler scheduler;
    private final Duration metadataTimeout;
    private final Duration idleTimeout;
    private final Duration generationTimeout;

    public OpenAiRuntime(String id, WebClient client, Scheduler scheduler, Duration metadataTimeout,
                         Duration idleTimeout, Duration generationTimeout) {
        if (id == null || !ModelUiAssets.RUNTIME_ID.matcher(id).matches())
            throw new IllegalArgumentException("Runtime id must match " + ModelUiAssets.RUNTIME_ID.pattern());
        this.id = id;
        this.client = client;
        this.scheduler = scheduler;
        this.metadataTimeout = metadataTimeout;
        this.idleTimeout = idleTimeout;
        this.generationTimeout = generationTimeout;
    }

    @Override public String id() { return id; }

    /** The model list is the only bounded, side-effect-free probe this protocol offers. */
    @Override
    public Mono<Boolean> connected() { return models().map(Api.Models::connected); }

    @Override
    public Mono<Api.Models> models() {
        return client.get().uri("/v1/models").accept(MediaType.APPLICATION_JSON).retrieve().bodyToMono(ModelList.class)
                .timeout(metadataTimeout).publishOn(scheduler)
                .map(list -> {
                    if (list.data() == null) throw HostAiRuntime.invalidResponse();
                    List<Api.Model> models = list.data().stream().map(entry -> {
                        if (entry == null || entry.id() == null || entry.id().isBlank()) throw HostAiRuntime.invalidResponse();
                        // The list endpoint carries no size, parameter or quantization metadata.
                        return new Api.Model(entry.id(), 0, "", "", "", ModelAdmission.reason(entry.id()));
                    }).toList();
                    return new Api.Models(models, true);
                })
                .defaultIfEmpty(new Api.Models(List.of(), false))
                .onErrorReturn(new Api.Models(List.of(), false));
    }

    @Override
    public Flux<Api.InferRecord> infer(String model, JsonNode input) {
        return Flux.error(new GatewayException(HttpStatus.BAD_REQUEST, "This model only supports chat."));
    }

    @Override
    public Mono<byte[]> asset(String relativePath) { return Mono.empty(); }

    @Override
    public Flux<Api.ChatChunk> chat(Api.ChatRequest request) {
        return Flux.defer(() -> {
            Stream stream = new Stream();
            AtomicBoolean deadlineReached = new AtomicBoolean();
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("model", request.model());
            body.put("messages", request.messages());
            body.put("temperature", request.temperature());
            body.put("max_tokens", request.maxTokens());
            body.put("stream", true);
            body.put("stream_options", Map.of("include_usage", true));
            return client.post().uri("/v1/chat/completions").contentType(MediaType.APPLICATION_JSON)
                    .accept(MediaType.TEXT_EVENT_STREAM).bodyValue(body)
                    .<ServerSentEvent<String>>exchangeToFlux(response -> {
                        int code = response.statusCode().value();
                        if (code != 200) {
                            GatewayException error = switch (code) {
                                case 400, 404, 422 -> new GatewayException(HttpStatus.BAD_REQUEST,
                                        "The engine rejected the model or chat request. Use a model listed by this runtime.");
                                case 429, 503 -> HostAiRuntime.unavailable();
                                default -> new GatewayException(HttpStatus.BAD_GATEWAY, "The engine rejected the chat request.");
                            };
                            // WebClient bounds and releases the error body; never expose its contents.
                            return response.createException().flatMapMany(ignored -> Flux.error(error));
                        }
                        MediaType type = response.headers().contentType().orElse(null);
                        if (type == null || !MediaType.TEXT_EVENT_STREAM.isCompatibleWith(type))
                            return response.releaseBody().thenMany(Flux.error(HostAiRuntime.invalidResponse()));
                        // The SSE reader joins split events and bounds each one by the client's in-memory limit.
                        return response.bodyToFlux(EVENT);
                    })
                    .timeout(idleTimeout)
                    // Emit a deadline value so takeUntilOther cancels the active HTTP source.
                    .takeUntilOther(Mono.delay(generationTimeout).doOnNext(ignored -> deadlineReached.set(true)))
                    .publishOn(scheduler, 1)
                    .handle(stream::accept)
                    .takeUntil(Api.ChatChunk::done)
                    .concatWith(Flux.defer(() -> stream.terminalSeen ? Flux.empty()
                            : Flux.error(deadlineReached.get()
                                    ? new GatewayException(HttpStatus.GATEWAY_TIMEOUT, "The generation exceeded its time limit.")
                                    : HostAiRuntime.invalidResponse())))
                    .onErrorMap(error -> {
                        if (error instanceof GatewayException) return error;
                        if (error instanceof TimeoutException) {
                            return new GatewayException(HttpStatus.GATEWAY_TIMEOUT,
                                    "The generation stream made no progress within the stream time limit.");
                        }
                        if (error instanceof DecodingException || error instanceof DataBufferLimitException)
                            return HostAiRuntime.invalidResponse();
                        if (error instanceof WebClientRequestException) return HostAiRuntime.unavailable();
                        return HostAiRuntime.invalidResponse();
                    });
        });
    }

    /**
     * One subscription's progress through the chunk protocol: text deltas, a finish_reason, an optional
     * usage record, then the {@code [DONE]} sentinel that becomes the single terminal chunk.
     */
    private static final class Stream {
        private boolean finishSeen;
        private Long completionTokens;
        volatile boolean terminalSeen;

        void accept(ServerSentEvent<String> event, SynchronousSink<Api.ChatChunk> sink) {
            String data = event.data();
            if (data == null) return; // comment or keep-alive line
            if (data.strip().equals(DONE)) {
                if (!finishSeen) throw HostAiRuntime.invalidResponse();
                terminalSeen = true;
                sink.next(new Api.ChatChunk("", true, completionTokens, null));
                return;
            }
            JsonNode node;
            try { node = JSON.readTree(data); } catch (JacksonException error) { throw HostAiRuntime.invalidResponse(); }
            if (node == null || !node.isObject()) throw HostAiRuntime.invalidResponse();
            if (present(node.get("error")))
                throw new GatewayException(HttpStatus.BAD_GATEWAY, "The engine reported a generation error.");
            JsonNode usage = node.get("usage");
            if (present(usage)) {
                if (!usage.isObject()) throw HostAiRuntime.invalidResponse();
                JsonNode tokens = usage.get("completion_tokens");
                if (present(tokens)) {
                    if (!tokens.isIntegralNumber() || !tokens.canConvertToLong() || tokens.asLong() < 0)
                        throw HostAiRuntime.invalidResponse();
                    completionTokens = tokens.asLong();
                }
            }
            JsonNode choices = node.get("choices");
            if (choices == null || choices.isNull()) {
                if (usage == null) throw HostAiRuntime.invalidResponse();
                return; // vLLM's usage-only record omits choices entirely
            }
            if (!choices.isArray()) throw HostAiRuntime.invalidResponse();
            if (choices.isEmpty()) return;
            if (finishSeen || choices.size() != 1) throw HostAiRuntime.invalidResponse();
            JsonNode choice = choices.get(0);
            if (choice == null || !choice.isObject()) throw HostAiRuntime.invalidResponse();
            String text = "";
            JsonNode delta = choice.get("delta");
            if (present(delta)) {
                if (!delta.isObject()) throw HostAiRuntime.invalidResponse();
                if (present(delta.get("tool_calls")) || present(delta.get("function_call"))) throw toolCalls();
                if (present(delta.get("audio"))) throw new GatewayException(HttpStatus.BAD_GATEWAY,
                        "The model produced non-text output, which this gateway does not support.");
                JsonNode content = delta.get("content");
                if (present(content)) {
                    if (!content.isString()) throw new GatewayException(HttpStatus.BAD_GATEWAY,
                            "The model produced non-text output, which this gateway does not support.");
                    text = content.asString();
                }
            }
            JsonNode finish = choice.get("finish_reason");
            if (present(finish)) {
                if (!finish.isString()) throw HostAiRuntime.invalidResponse();
                switch (finish.asString()) {
                    case "stop", "length" -> finishSeen = true;
                    case "tool_calls", "function_call" -> throw toolCalls();
                    case "content_filter" -> throw new GatewayException(HttpStatus.BAD_GATEWAY,
                            "The engine stopped the generation with its content filter.");
                    default -> throw HostAiRuntime.invalidResponse();
                }
            }
            if (!text.isEmpty()) sink.next(new Api.ChatChunk(text, false, null, null));
        }

        /** Null, JSON null and an empty array all count as "not sent". */
        private static boolean present(JsonNode node) {
            return node != null && !node.isNull() && !(node.isArray() && node.isEmpty());
        }

        private static GatewayException toolCalls() {
            return new GatewayException(HttpStatus.BAD_GATEWAY,
                    "The model requested a tool call, which this gateway does not support.");
        }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    record ModelList(List<ModelEntry> data) {}
    @JsonIgnoreProperties(ignoreUnknown = true)
    record ModelEntry(String id) {}
}
