package com.hostai.backend;

import java.time.Duration;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Scheduler;

/**
 * The configured loopback origins. Every read probes each origin's protocol, merges the models
 * (first runtime wins a duplicate name, a duplicate runtime id makes the later origin unavailable)
 * and resolves model names to runtimes. Nothing is cached.
 */
@Component
public class RuntimeCatalog {
    record Origin(String display, WebClient client, boolean openai) {
        Origin(String display, WebClient client) { this(display, client, false); }
    }

    private final List<Origin> origins;
    private final Scheduler scheduler;
    private final Duration metadataTimeout;
    private final Duration idleTimeout;
    private final Duration generationTimeout;

    @Autowired
    public RuntimeCatalog(@Value("${hostai.runtime-urls:}") String runtimeUrls, LocalOllamaEndpoint ollama,
                          @Value("${hostai.openai-urls:}") String openaiUrls,
                          Scheduler inferenceScheduler,
                          @Value("${hostai.metadata-timeout:3s}") Duration metadataTimeout,
                          @Value("${hostai.stream-idle-timeout:60s}") Duration idleTimeout,
                          @Value("${hostai.generation-timeout:10m}") Duration generationTimeout) {
        this(origins(runtimeUrls, ollama, openaiUrls), inferenceScheduler, metadataTimeout, idleTimeout, generationTimeout);
    }

    RuntimeCatalog(List<Origin> origins, Scheduler scheduler, Duration metadataTimeout, Duration idleTimeout,
                   Duration generationTimeout) {
        if (origins.isEmpty()) throw new IllegalArgumentException("At least one runtime origin is required");
        this.origins = List.copyOf(origins);
        this.scheduler = scheduler;
        this.metadataTimeout = metadataTimeout;
        this.idleTimeout = idleTimeout;
        this.generationTimeout = generationTimeout;
    }

    /** A single-origin catalog around an existing client, for tests and embedding. */
    static RuntimeCatalog single(WebClient client, Scheduler scheduler, Duration metadataTimeout,
                                 Duration idleTimeout, Duration generationTimeout) {
        return new RuntimeCatalog(List.of(new Origin("http://127.0.0.1", client)), scheduler,
                metadataTimeout, idleTimeout, generationTimeout);
    }

    static List<Origin> origins(String runtimeUrls, LocalOllamaEndpoint ollama) {
        return origins(runtimeUrls, ollama, "");
    }

    static List<Origin> origins(String runtimeUrls, LocalOllamaEndpoint ollama, String openaiUrls) {
        List<String> values = runtimeUrls == null ? List.of() : java.util.Arrays.stream(runtimeUrls.split(","))
                .map(String::trim).filter(value -> !value.isEmpty()).toList();
        List<String> compatible = openaiUrls == null ? List.of() : java.util.Arrays.stream(openaiUrls.split(","))
                .map(String::trim).filter(value -> !value.isEmpty()).toList();
        List<LocalOllamaEndpoint> endpoints = values.isEmpty() ? (compatible.isEmpty() ? List.of(ollama) : List.of())
                : values.stream().map(value -> LocalOllamaEndpoint.parse(value, "HOSTAI_RUNTIME_URLS")).toList();
        List<Origin> result = new ArrayList<>();
        endpoints.forEach(endpoint -> result.add(new Origin(endpoint.displayUrl(), BackendConfiguration.runtimeClient(endpoint))));
        compatible.stream().map(value -> LocalOllamaEndpoint.parse(value, "HOSTAI_OPENAI_URLS"))
                .forEach(endpoint -> result.add(new Origin(endpoint.displayUrl(), BackendConfiguration.runtimeClient(endpoint), true)));
        return List.copyOf(result);
    }

    /** The configured origins as typed, joined with ", ". */
    public String displayUrl() {
        return origins.stream().map(Origin::display).collect(Collectors.joining(", "));
    }

    /** True when any configured runtime answers its liveness probe. */
    public Mono<Boolean> connected() {
        return Flux.fromIterable(origins)
                .flatMap(origin -> resolve(origin).flatMap(runtime -> runtime.map(InferenceRuntime::connected)
                        .orElse(Mono.just(false))).onErrorReturn(false))
                .any(Boolean::booleanValue).defaultIfEmpty(false);
    }

    public Mono<Catalog> read() {
        return Flux.fromIterable(origins)
                .flatMapSequential(origin -> resolve(origin).flatMap(runtime -> runtime
                        .map(found -> found.models().onErrorReturn(new Api.Models(List.of(), false))
                                .map(models -> new Entry(found, models)))
                        .orElse(Mono.just(new Entry(null, new Api.Models(List.of(), false))))))
                .collectList()
                .publishOn(scheduler)
                .map(RuntimeCatalog::merge);
    }

    private Mono<Optional<InferenceRuntime>> resolve(Origin origin) {
        if (origin.openai()) {
            String id = "openai-" + java.util.UUID.nameUUIDFromBytes(origin.display().getBytes(java.nio.charset.StandardCharsets.UTF_8))
                    .toString().replace("-", "").substring(0, 24);
            return Mono.just(Optional.of(new OpenAiRuntime(id, origin.client(), scheduler,
                    metadataTimeout, idleTimeout, generationTimeout)));
        }
        return HostAiRuntime.probe(origin.client(), scheduler, metadataTimeout, idleTimeout, generationTimeout)
                .map(probe -> probe.hostai() ? probe.valid().<InferenceRuntime>map(runtime -> runtime)
                        : Optional.<InferenceRuntime>of(new OllamaRuntime(origin.client(), scheduler,
                                metadataTimeout, idleTimeout, generationTimeout)));
    }

    private record Entry(InferenceRuntime runtime, Api.Models models) {}

    private static Catalog merge(List<Entry> entries) {
        List<InferenceRuntime> runtimes = new ArrayList<>();
        Map<String, InferenceRuntime> byModel = new LinkedHashMap<>();
        List<Api.Model> models = new ArrayList<>();
        Set<String> ids = new HashSet<>();
        boolean connected = false;
        for (Entry entry : entries) {
            if (entry.runtime() == null || !ids.add(entry.runtime().id())) continue;
            runtimes.add(entry.runtime());
            connected |= entry.models().connected();
            for (Api.Model model : entry.models().models()) {
                if (byModel.putIfAbsent(model.name(), entry.runtime()) == null) models.add(model);
            }
        }
        return new Catalog(List.copyOf(runtimes), new Api.Models(List.copyOf(models), connected), Map.copyOf(byModel));
    }

    /** One consistent read of every configured runtime. */
    public record Catalog(List<InferenceRuntime> runtimes, Api.Models models, Map<String, InferenceRuntime> byModel) {
        public Optional<InferenceRuntime> runtime(String id) {
            return runtimes.stream().filter(runtime -> runtime.id().equals(id)).findFirst();
        }

        public Optional<Api.Model> model(String name) {
            return models.models().stream().filter(model -> model.name().equals(name)).findFirst();
        }

        /**
         * The runtime listing this model. An unlisted name falls back to the first Ollama runtime so
         * that Ollama keeps reporting its own installed-model errors; otherwise the request fails here.
         */
        public InferenceRuntime forModel(String name) {
            InferenceRuntime listed = byModel.get(name);
            if (listed != null) return listed;
            return runtimes.stream().filter(runtime -> runtime instanceof OllamaRuntime).findFirst()
                    .orElseThrow(() -> models.connected()
                            ? new GatewayException(HttpStatus.BAD_REQUEST, "This model is not available on any configured runtime.")
                            : HostAiRuntime.unavailable());
        }
    }
}
