package com.hostai.backend;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Function;
import java.util.function.Predicate;
import org.springframework.core.codec.DecodingException;
import org.springframework.core.io.buffer.DataBuffer;
import org.springframework.core.io.buffer.DataBufferLimitException;
import org.springframework.core.io.buffer.DataBufferUtils;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientRequestException;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Scheduler;
import tools.jackson.databind.JsonNode;

/** A process speaking the HostAI runtime protocol (docs/model-ui.md): manifest, opaque infer, UI files. */
public final class HostAiRuntime implements InferenceRuntime {
    static final int MAX_ERROR_LENGTH = 256;
    private final WebClient client;
    private final Scheduler scheduler;
    private final Duration idleTimeout;
    private final Duration generationTimeout;
    private final String id;
    private final Api.ModelUi ui;
    private final Api.Models models;

    private HostAiRuntime(WebClient client, Scheduler scheduler, Duration idleTimeout, Duration generationTimeout,
                          String id, Api.ModelUi ui, List<Api.Model> models) {
        this.client = client; this.scheduler = scheduler; this.idleTimeout = idleTimeout;
        this.generationTimeout = generationTimeout; this.id = id; this.ui = ui;
        this.models = new Api.Models(models, true);
    }

    /** Result of GET /hostai/manifest: not the protocol, or the protocol with a valid or broken manifest. */
    record Probe(boolean hostai, HostAiRuntime runtime) {
        static final Probe OLLAMA = new Probe(false, null);
        Optional<HostAiRuntime> valid() { return Optional.ofNullable(runtime); }
    }

    static Mono<Probe> probe(WebClient client, Scheduler scheduler, Duration metadataTimeout,
                             Duration idleTimeout, Duration generationTimeout) {
        return client.get().uri("/hostai/manifest").accept(MediaType.APPLICATION_JSON)
                .exchangeToMono(response -> {
                    if (response.statusCode().value() != 200) return response.releaseBody().thenReturn(Probe.OLLAMA);
                    return response.bodyToMono(Manifest.class)
                            .map(manifest -> new Probe(true, build(client, scheduler, idleTimeout, generationTimeout, manifest)))
                            .defaultIfEmpty(new Probe(true, null))
                            .onErrorReturn(new Probe(true, null));
                })
                .timeout(metadataTimeout)
                .onErrorReturn(Probe.OLLAMA);
    }

    private static HostAiRuntime build(WebClient client, Scheduler scheduler, Duration idleTimeout,
                                       Duration generationTimeout, Manifest manifest) {
        if (manifest.protocol() == null || manifest.protocol() != 1 || manifest.runtime() == null
                || !ModelUiAssets.RUNTIME_ID.matcher(manifest.runtime()).matches() || manifest.models() == null) return null;
        Api.ModelUi ui = null;
        Api.Capabilities defaults = capabilities(manifest.capabilities(), Api.Capabilities.INFER);
        JsonNode defaultInteraction = InteractionContract.validate(manifest.interaction());
        if (manifest.ui() != null) {
            String entry = ModelUiAssets.entry(manifest.ui().entry());
            if (entry == null || ModelUiAssets.root(entry).isEmpty() || !entry.toLowerCase(java.util.Locale.ROOT).endsWith(".html")) return null;
            ui = new Api.ModelUi(manifest.runtime(), entry);
        }
        List<Api.Model> models = new java.util.ArrayList<>();
        for (ManifestModel model : manifest.models()) {
            if (model == null || model.name() == null || model.name().isBlank() || model.sizeBytes() == null
                    || model.sizeBytes() < 0) return null;
            Api.Capabilities supported = capabilities(model.capabilities(), defaults);
            JsonNode interaction = model.interaction() == null ? defaultInteraction : InteractionContract.validate(model.interaction());
            String reason = ModelAdmission.reason(model.name());
            Api.ModelUi modelUi = reason == null && supported.infer() ? ui : null;
            if (supported.infer() && interaction == null) return null;
            if (reason == null && !supported.chat()) reason = "This model does not support chat.";
            models.add(new Api.Model(model.name(), model.sizeBytes(), text(model.parameterSize()),
                    text(model.quantization()), text(model.modifiedAt()), reason, modelUi, supported, interaction));
        }
        return new HostAiRuntime(client, scheduler, idleTimeout, generationTimeout, manifest.runtime(), ui, List.copyOf(models));
    }

    @Override public String id() { return id; }
    @Override public Api.ModelUi ui() { return ui; }
    @Override public Mono<Boolean> connected() { return Mono.just(true); }
    @Override public Mono<Api.Models> models() { return Mono.just(models); }

    @Override
    public Flux<Api.ChatChunk> chat(Api.ChatRequest request) {
        if (!capabilitiesFor(request.model()).chat()) return Flux.error(new GatewayException(HttpStatus.BAD_REQUEST,
                "This model does not support chat."));
        return stream("/hostai/chat", request, HostAiRuntime::chatRecord, node -> {
            Api.ChatChunk chunk = chatRecord(node);
            if (!chunk.done()) throw invalidResponse();
            return chunk;
        }, Api.ChatChunk::done);
    }

    @Override
    public Flux<Api.InferRecord> infer(String model, JsonNode input) {
        if (!capabilitiesFor(model).infer()) return Flux.error(new GatewayException(HttpStatus.BAD_REQUEST,
                "This model does not support opaque inference."));
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", model);
        body.put("input", input);
        return stream("/hostai/infer", body, HostAiRuntime::record,
                node -> new Api.InferRecord(node, true, null), Api.InferRecord::done);
    }

    private Api.Capabilities capabilitiesFor(String model) {
        return models.models().stream().filter(item -> item.name().equals(model))
                .map(Api.Model::capabilities).findFirst().orElse(Api.Capabilities.NONE);
    }

    /** Both contracts share bounded decoding, deadlines, cancellation and terminal-record handling. */
    private <T> Flux<T> stream(String path, Object body, Function<JsonNode, T> record,
                                Function<JsonNode, T> single, Predicate<T> done) {
        return Flux.defer(() -> {
            AtomicBoolean terminalSeen = new AtomicBoolean();
            AtomicBoolean deadlineReached = new AtomicBoolean();
            return client.post().uri(path).contentType(MediaType.APPLICATION_JSON)
                    .accept(MediaType.APPLICATION_JSON, MediaType.APPLICATION_NDJSON).bodyValue(body)
                    .<T>exchangeToFlux(response -> {
                        int code = response.statusCode().value();
                        if (code == 400) {
                            // Only the runtime's short, sanitized message crosses; the raw body never does.
                            return response.bodyToMono(ErrorBody.class).map(error -> sanitize(error.error()))
                                    .defaultIfEmpty(sanitize(null)).onErrorReturn(sanitize(null))
                                    .flatMapMany(message -> Flux.error(new GatewayException(HttpStatus.BAD_REQUEST, message)));
                        }
                        if (code != 200) {
                            return response.createException().flatMapMany(ignored -> Flux.error(
                                    new GatewayException(HttpStatus.BAD_GATEWAY, "The runtime rejected the generation request.")));
                        }
                        MediaType type = response.headers().contentType().orElse(null);
                        if (type != null && MediaType.APPLICATION_NDJSON.isCompatibleWith(type))
                            return response.bodyToFlux(JsonNode.class).map(record);
                        if (type != null && MediaType.APPLICATION_JSON.isCompatibleWith(type))
                            return response.bodyToMono(JsonNode.class).map(single).flux();
                        return response.releaseBody().thenMany(Flux.error(invalidResponse()));
                    })
                    .timeout(idleTimeout)
                    .takeUntilOther(Mono.delay(generationTimeout).doOnNext(ignored -> deadlineReached.set(true)))
                    .publishOn(scheduler, 1)
                    .doOnNext(item -> { if (done.test(item)) terminalSeen.set(true); })
                    .takeUntil(done)
                    .concatWith(Flux.defer(() -> terminalSeen.get() ? Flux.empty()
                            : Flux.error(deadlineReached.get()
                                    ? new GatewayException(HttpStatus.GATEWAY_TIMEOUT, "The inference exceeded its time limit.")
                                    : invalidResponse())))
                    .onErrorMap(error -> {
                        if (error instanceof GatewayException) return error;
                        if (error instanceof TimeoutException) {
                            return new GatewayException(HttpStatus.GATEWAY_TIMEOUT,
                                    "The inference stream made no progress within the stream time limit.");
                        }
                        if (error instanceof WebClientRequestException) return unavailable();
                        if (error instanceof DecodingException || error instanceof DataBufferLimitException) return invalidResponse();
                        return invalidResponse();
                    });
        });
    }

    private static Api.ChatChunk chatRecord(JsonNode node) {
        if (node == null || !node.isObject()) throw invalidResponse();
        JsonNode content = node.get("content"), done = node.get("done"), tokens = node.get("outputTokens"), error = node.get("error");
        if (content == null || !content.isString() || done == null || !done.isBoolean()) throw invalidResponse();
        Long count = null;
        if (tokens != null && !tokens.isNull()) {
            if (!tokens.isIntegralNumber() || !tokens.canConvertToLong() || tokens.asLong() < 0) throw invalidResponse();
            count = tokens.asLong();
        }
        String message = null;
        if (error != null && !error.isNull()) {
            if (!error.isString() || !done.asBoolean()) throw invalidResponse();
            message = sanitize(error.asString());
        }
        return new Api.ChatChunk(content.asString(), done.asBoolean(), count, message);
    }

    /** Omission preserves v1 inference runtimes; explicit metadata must use actual booleans. */
    private static Api.Capabilities capabilities(JsonNode node, Api.Capabilities fallback) {
        if (node == null) return fallback;
        if (!node.isObject() || !node.has("chat") || !node.get("chat").isBoolean()
                || !node.has("infer") || !node.get("infer").isBoolean()) throw invalidResponse();
        return new Api.Capabilities(node.get("chat").asBoolean(), node.get("infer").asBoolean());
    }

    private static Api.InferRecord record(JsonNode node) {
        if (node == null || !node.isObject()) throw invalidResponse();
        JsonNode done = node.get("done");
        if (done == null || !done.isBoolean()) throw invalidResponse();
        JsonNode error = node.get("error");
        String message = null;
        if (error != null && !error.isNull()) {
            if (!error.isString() || !done.asBoolean()) throw invalidResponse();
            message = sanitize(error.asString());
        }
        JsonNode event = node.get("event");
        return new Api.InferRecord(event == null || event.isNull() ? null : event, done.asBoolean(), message);
    }

    @Override
    public Mono<byte[]> asset(String relativePath) {
        return client.get().uri("/" + relativePath)
                .exchangeToMono(response -> {
                    int code = response.statusCode().value();
                    if (code == 404) return response.releaseBody().then(Mono.empty());
                    if (code != 200) return response.createException().flatMap(ignored -> Mono.error(
                            new GatewayException(HttpStatus.BAD_GATEWAY, "The runtime could not serve the asset.")));
                    return DataBufferUtils.join(response.bodyToFlux(DataBuffer.class), ModelUiAssets.MAX_ASSET_BYTES)
                            .map(buffer -> {
                                byte[] bytes = new byte[buffer.readableByteCount()];
                                try { buffer.read(bytes); } finally { DataBufferUtils.release(buffer); }
                                return bytes;
                            });
                })
                .timeout(idleTimeout)
                .onErrorMap(error -> {
                    if (error instanceof GatewayException) return error;
                    if (error instanceof DataBufferLimitException)
                        return new GatewayException(HttpStatus.BAD_GATEWAY, "The asset exceeds the 8 MiB limit.");
                    if (error instanceof WebClientRequestException) return unavailable();
                    return new GatewayException(HttpStatus.BAD_GATEWAY, "The runtime could not serve the asset.");
                });
    }

    static String sanitize(String message) {
        if (message == null) return "The runtime rejected the request.";
        StringBuilder clean = new StringBuilder();
        message.codePoints().filter(point -> !Character.isISOControl(point)).limit(MAX_ERROR_LENGTH).forEach(clean::appendCodePoint);
        String result = clean.toString().strip();
        return result.isEmpty() ? "The runtime rejected the request." : result;
    }

    static GatewayException unavailable() {
        return new GatewayException(HttpStatus.SERVICE_UNAVAILABLE, "The model runtime is unavailable. Check that it is running.");
    }

    static GatewayException invalidResponse() {
        return new GatewayException(HttpStatus.BAD_GATEWAY, "The model runtime returned an invalid or incomplete response.");
    }

    private static String text(String value) { return value == null ? "" : value; }

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Manifest(Integer protocol, String runtime, List<ManifestModel> models, Ui ui, JsonNode capabilities,
                    JsonNode interaction) {}
    @JsonIgnoreProperties(ignoreUnknown = true)
    record ManifestModel(String name, Long sizeBytes, String parameterSize, String quantization, String modifiedAt,
                         JsonNode capabilities, JsonNode interaction) {}
    @JsonIgnoreProperties(ignoreUnknown = true)
    record Ui(String entry) {}
    @JsonIgnoreProperties(ignoreUnknown = true)
    record ErrorBody(String error) {}
}
