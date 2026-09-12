package com.hostai.backend;

import jakarta.validation.Valid;
import java.lang.management.ManagementFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.info.BuildProperties;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.http.server.reactive.ServerHttpResponse;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@RestController
@RequestMapping("/api")
public class ApiController {
    private static final String MODEL_UI_PREFIX = "/api/model-ui/";
    private final RuntimeCatalog catalog;
    private final ChatService chat;
    private final InferenceRegistry registry;
    private final String version;

    public ApiController(RuntimeCatalog catalog, ChatService chat, InferenceRegistry registry,
                         ObjectProvider<BuildProperties> build) {
        this.catalog = catalog;
        this.chat = chat;
        this.registry = registry;
        BuildProperties properties = build.getIfAvailable();
        this.version = properties == null ? "0.1.0" : properties.getVersion();
    }

    @GetMapping("/status")
    public Mono<Api.Status> status() {
        return catalog.connected().map(connected -> {
            InferenceRegistry.Counters counts = registry.counters();
            return new Api.Status("online", connected, catalog.displayUrl(), version,
                    System.getProperty("java.version"), ManagementFactory.getRuntimeMXBean().getUptime() / 1000,
                    counts.activeRequests(), InferenceRegistry.MAX_CONCURRENT,
                    counts.totalRequests(), counts.failedRequests());
        });
    }

    @GetMapping("/models")
    public Mono<Api.Models> models() { return catalog.read().map(RuntimeCatalog.Catalog::models); }

    @GetMapping("/requests")
    public Api.Requests requests() { return new Api.Requests(registry.requests()); }

    @PostMapping(value = "/chat", consumes = MediaType.APPLICATION_JSON_VALUE,
            produces = MediaType.APPLICATION_NDJSON_VALUE)
    public Flux<Api.ChatChunk> chat(@Valid @RequestBody Api.ChatRequest request, ServerHttpResponse response) {
        streaming(response);
        return chat.chat(request);
    }

    @PostMapping(value = "/infer", consumes = MediaType.APPLICATION_JSON_VALUE,
            produces = MediaType.APPLICATION_NDJSON_VALUE)
    public Flux<Api.InferRecord> infer(@Valid @RequestBody Api.InferRequest request, ServerHttpResponse response) {
        streaming(response);
        return chat.infer(request);
    }

    /**
     * Proxied model-UI file. The CSP origin is this listener's own origin; the web app's proxy
     * replaces it with the browser-facing origin.
     */
    @GetMapping("/model-ui/{runtime}/**")
    public Mono<ResponseEntity<byte[]>> modelUi(@PathVariable String runtime, ServerWebExchange exchange) {
        var request = exchange.getRequest();
        String raw = request.getPath().value();
        String prefix = MODEL_UI_PREFIX + runtime + "/";
        if (request.getURI().getRawQuery() != null || !raw.startsWith(prefix)
                || !ModelUiAssets.RUNTIME_ID.matcher(runtime).matches()) return Mono.error(ModelUiAssets.notFound());
        String path = raw.substring(prefix.length());
        String host = request.getHeaders().getFirst("Host");
        String origin = request.getURI().getScheme() + "://" + (host == null ? request.getURI().getRawAuthority() : host);
        return catalog.read().flatMap(resolved -> resolved.runtime(runtime).map(Mono::just)
                        .orElseGet(() -> Mono.error(ModelUiAssets.notFound())))
                .flatMap(found -> ModelUiAssets.serve(found, path))
                .map(asset -> {
                    var builder = ResponseEntity.ok().contentType(asset.type());
                    return builder.headers(headers -> ModelUiAssets.headers(headers, origin)).body(asset.bytes());
                });
    }

    private static void streaming(ServerHttpResponse response) {
        response.getHeaders().setCacheControl("no-store");
        response.getHeaders().set("X-Accel-Buffering", "no");
    }
}
