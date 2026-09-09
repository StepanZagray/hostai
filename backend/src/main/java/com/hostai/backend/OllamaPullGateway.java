package com.hostai.backend;

import io.netty.channel.ChannelOption;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.client.reactive.ReactorClientHttpConnector;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientRequestException;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.netty.http.client.HttpClient;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Dedicated pull transport: fixed path, loopback pinning, bounded records and deadlines. */
@Component
public final class OllamaPullGateway {
    private static final JsonMapper JSON = JsonMapper.builder()
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build();
    private final WebClient client;
    private final Duration idleTimeout;
    private final Duration overallTimeout;

    public OllamaPullGateway(LocalOllamaEndpoint endpoint,
            @Value("${hostai.download-connect-timeout:2s}") Duration connectTimeout,
            @Value("${hostai.download-idle-timeout:5m}") Duration idleTimeout,
            @Value("${hostai.download-overall-timeout:2h}") Duration overallTimeout) {
        requirePositive(connectTimeout);
        requirePositive(idleTimeout);
        requirePositive(overallTimeout);
        if (connectTimeout.toMillis() < 1 || connectTimeout.toMillis() > Integer.MAX_VALUE) {
            throw new IllegalArgumentException("Download connect timeout is outside the supported range");
        }
        // Revalidate even an explicitly constructed endpoint; never use a supplied path or DNS.
        var origin = LocalOllamaEndpoint.parse(endpoint.requestUrl().toString()).requestUrl();
        HttpClient transport = HttpClient.newConnection()
                .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, (int) connectTimeout.toMillis())
                .followRedirect(false).disableRetry(true).responseTimeout(idleTimeout);
        this.client = WebClient.builder().baseUrl(origin.toString())
                .clientConnector(new ReactorClientHttpConnector(transport))
                .codecs(codecs -> codecs.defaultCodecs().maxInMemorySize(BackendConfiguration.MAX_BODY_BYTES))
                .build();
        this.idleTimeout = idleTimeout;
        this.overallTimeout = overallTimeout;
    }

    public Flux<PullRecord> pull(String model) {
        return Flux.defer(() -> {
            DownloadModelAdmission.validate(model);
            AtomicBoolean success = new AtomicBoolean();
            AtomicBoolean deadlineReached = new AtomicBoolean();
            return client.post().uri("/api/pull").contentType(MediaType.APPLICATION_JSON)
                    .accept(MediaType.APPLICATION_NDJSON)
                    .bodyValue(Map.of("model", model, "stream", true))
                    .<String>exchangeToFlux(response -> {
                        if (!response.statusCode().is2xxSuccessful()) {
                            // Cancel/release the body without persisting or exposing upstream text.
                            return response.releaseBody().thenMany(Flux.error(failure(
                                    "Ollama rejected the model download.")));
                        }
                        // Decode one NDJSON line at a time, including lines split across TCP packets.
                        return response.bodyToFlux(String.class);
                    })
                    .timeout(idleTimeout)
                    // A value from the deadline cancels the source. An error from takeUntilOther
                    // can terminate downstream without cancelling its main subscription.
                    .takeUntilOther(Mono.delay(overallTimeout).doOnNext(ignored -> deadlineReached.set(true)))
                    .map(OllamaPullGateway::decode)
                    .doOnNext(record -> { if (record.success()) success.set(true); })
                    .takeUntil(PullRecord::success)
                    .concatWith(Flux.defer(() -> success.get() ? Flux.empty()
                            : Flux.error(failure(deadlineReached.get()
                                    ? "The model download exceeded its time limit."
                                    : "Ollama ended the download without reporting success."))))
                    .onErrorMap(error -> {
                        if (error instanceof GatewayException) return error;
                        if (error instanceof TimeoutException || hasReadTimeout(error)) {
                            return failure("The model download made no progress within the time limit.");
                        }
                        if (error instanceof WebClientRequestException) {
                            return failure("Ollama is unavailable for model downloads.");
                        }
                        return failure("Ollama returned an invalid model download record.");
                    });
        });
    }

    private static PullRecord decode(String line) {
        JsonNode node = JSON.readTree(line);
        if (node == null || !node.isObject()) throw invalid();
        if (node.hasNonNull("error")) {
            throw failure("Ollama reported a model download error.");
        }
        String status = string(node, "status", 1024);
        if (status == null) throw invalid();
        String digest = string(node, "digest", 256);
        if (digest != null && !digest.matches("[a-zA-Z0-9][a-zA-Z0-9:._-]*")) throw invalid();
        Long total = count(node, "total");
        Long completed = count(node, "completed");
        if (total != null && completed != null && completed > total) throw invalid();
        return switch (status) {
            case "success" -> new PullRecord("finalizing", "Download completed.", digest, completed, total, true);
            case "pulling manifest" -> new PullRecord("starting", "Pulling manifest.", digest, completed, total, false);
            case "verifying sha256 digest" -> new PullRecord("verifying", "Verifying model integrity.", digest, completed, total, false);
            case "writing manifest" -> new PullRecord("finalizing", "Writing model manifest.", digest, completed, total, false);
            default -> new PullRecord("downloading", status.startsWith("pulling ")
                    ? "Downloading model layer." : "Downloading model.", digest, completed, total, false);
        };
    }

    private static String string(JsonNode node, String field, int maxLength) {
        JsonNode value = node.get(field);
        if (value == null || value.isNull()) return null;
        if (!value.isString() || value.stringValue().isBlank() || value.stringValue().length() > maxLength
                || value.stringValue().chars().anyMatch(Character::isISOControl)) throw invalid();
        return value.stringValue();
    }

    private static Long count(JsonNode node, String field) {
        JsonNode value = node.get(field);
        if (value == null || value.isNull()) return null;
        if (!value.isIntegralNumber() || !value.canConvertToLong() || value.longValue() < 0) throw invalid();
        return value.longValue();
    }

    private static boolean hasReadTimeout(Throwable error) {
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            if (cause instanceof io.netty.handler.timeout.ReadTimeoutException) return true;
        }
        return false;
    }

    private static void requirePositive(Duration timeout) {
        if (timeout.isZero() || timeout.isNegative()) throw new IllegalArgumentException("Download deadlines must be positive");
    }

    static GatewayException invalid() { return failure("Ollama returned an invalid model download record."); }
    private static GatewayException failure(String message) { return new GatewayException(HttpStatus.BAD_GATEWAY, message); }

    public record PullRecord(String phase, String message, String digest, Long completedBytes,
                             Long totalBytes, boolean success) {}
}
