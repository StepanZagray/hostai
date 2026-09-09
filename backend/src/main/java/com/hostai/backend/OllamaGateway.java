package com.hostai.backend;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.codec.DecodingException;
import org.springframework.core.io.buffer.DataBufferLimitException;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientRequestException;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Scheduler;

@Component
public class OllamaGateway {
    private final WebClient client;
    private final Scheduler scheduler;
    private final Duration metadataTimeout;
    private final Duration idleTimeout;
    private final Duration generationTimeout;

    public OllamaGateway(WebClient ollamaClient, Scheduler inferenceScheduler,
                         @Value("${hostai.metadata-timeout:3s}") Duration metadataTimeout,
                         @Value("${hostai.stream-idle-timeout:60s}") Duration idleTimeout,
                         @Value("${hostai.generation-timeout:10m}") Duration generationTimeout) {
        this.client = ollamaClient;
        this.scheduler = inferenceScheduler;
        this.metadataTimeout = metadataTimeout;
        this.idleTimeout = idleTimeout;
        this.generationTimeout = generationTimeout;
    }

    public Mono<Boolean> connected() {
        return client.get().uri("/api/version").retrieve().bodyToMono(Version.class)
                .timeout(metadataTimeout)
                .map(version -> version.version() != null && !version.version().isBlank())
                .defaultIfEmpty(false).onErrorReturn(false);
    }

    public Mono<Api.Models> models() {
        return client.get().uri("/api/tags").retrieve().bodyToMono(Tags.class)
                .timeout(metadataTimeout).publishOn(scheduler)
                .map(tags -> {
                    if (tags.models() == null) {
                        throw GatewayException.invalidResponse();
                    }
                    List<Api.Model> models = tags.models().stream().map(model -> {
                        if (model == null || model.name() == null || model.name().isBlank()
                                || model.size() == null || model.size() < 0) {
                            throw GatewayException.invalidResponse();
                        }
                        Details details = model.details();
                        return new Api.Model(model.name(), model.size(),
                                details == null ? "" : text(details.parameterSize()),
                                details == null ? "" : text(details.quantizationLevel()),
                                text(model.modifiedAt()), ModelAdmission.reason(model.name()));
                    }).toList();
                    return new Api.Models(models, true);
                })
                .defaultIfEmpty(new Api.Models(List.of(), false))
                .onErrorReturn(new Api.Models(List.of(), false));
    }

    public Flux<Api.ChatChunk> chat(Api.ChatRequest request) {
        return Flux.defer(() -> {
            AtomicBoolean terminalSeen = new AtomicBoolean();
            AtomicBoolean deadlineReached = new AtomicBoolean();
            Map<String, Object> body = Map.of(
                    "model", request.model(), "messages", request.messages(), "stream", true,
                    "options", Map.of("temperature", request.temperature(), "num_predict", request.maxTokens()));
            return client.post().uri("/api/chat").contentType(MediaType.APPLICATION_JSON)
                    .accept(MediaType.APPLICATION_NDJSON).bodyValue(body)
                    .<ChatRecord>exchangeToFlux(response -> {
                        if (!response.statusCode().is2xxSuccessful()) {
                            int code = response.statusCode().value();
                            GatewayException error = switch (code) {
                                case 400, 404 -> new GatewayException(HttpStatus.BAD_REQUEST,
                                        "Ollama rejected the model or chat request. Use an installed local model.");
                                case 429, 503 -> GatewayException.unavailable();
                                default -> new GatewayException(HttpStatus.BAD_GATEWAY,
                                        "Ollama rejected the chat request.");
                            };
                            // WebClient bounds and releases the error body; never expose its contents.
                            return response.createException().flatMapMany(ignored -> Flux.error(error));
                        }
                        return response.bodyToFlux(ChatRecord.class);
                    })
                    .timeout(idleTimeout)
                    // Emit a deadline value so takeUntilOther cancels the active HTTP source.
                    .takeUntilOther(Mono.delay(generationTimeout).doOnNext(ignored -> deadlineReached.set(true)))
                    .publishOn(scheduler, 1)
                    .map(record -> convert(record, terminalSeen))
                    .takeUntil(Api.ChatChunk::done)
                    .concatWith(Flux.defer(() -> terminalSeen.get() ? Flux.empty()
                            : Flux.error(deadlineReached.get()
                                    ? new GatewayException(HttpStatus.GATEWAY_TIMEOUT, "The generation exceeded its time limit.")
                                    : GatewayException.invalidResponse())))
                    .onErrorMap(error -> {
                        if (error instanceof GatewayException) return error;
                        if (error instanceof TimeoutException) {
                            return new GatewayException(HttpStatus.GATEWAY_TIMEOUT,
                                    "The generation stream made no progress within the stream time limit.");
                        }
                        if (error instanceof DecodingException || error instanceof DataBufferLimitException) {
                            return GatewayException.invalidResponse();
                        }
                        if (error instanceof WebClientRequestException) return GatewayException.unavailable();
                        return GatewayException.invalidResponse();
                    });
        });
    }

    private Api.ChatChunk convert(ChatRecord record, AtomicBoolean terminalSeen) {
        if (record.error() != null) {
            throw new GatewayException(HttpStatus.BAD_GATEWAY, "Ollama reported a generation error.");
        }
        if (record.done() == null || (record.evalCount() != null && record.evalCount() < 0)
                || (!record.done() && (record.message() == null || record.message().content() == null))) {
            throw GatewayException.invalidResponse();
        }
        terminalSeen.set(record.done());
        return new Api.ChatChunk(record.message() == null ? "" : text(record.message().content()),
                record.done(), record.done() ? record.evalCount() : null, null);
    }

    private static String text(String value) { return value == null ? "" : value; }

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Version(String version) {}
    @JsonIgnoreProperties(ignoreUnknown = true)
    record Tags(List<Tag> models) {}
    @JsonIgnoreProperties(ignoreUnknown = true)
    record Tag(String name, Long size, @JsonProperty("modified_at") String modifiedAt, Details details) {}
    @JsonIgnoreProperties(ignoreUnknown = true)
    record Details(@JsonProperty("parameter_size") String parameterSize,
                   @JsonProperty("quantization_level") String quantizationLevel) {}
    @JsonIgnoreProperties(ignoreUnknown = true)
    record ChatRecord(OllamaMessage message, Boolean done, @JsonProperty("eval_count") Long evalCount,
                      String error) {}
    @JsonIgnoreProperties(ignoreUnknown = true)
    record OllamaMessage(String content) {}
}
