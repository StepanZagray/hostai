package com.hostai.backend;

import jakarta.validation.Valid;
import java.lang.management.ManagementFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.info.BuildProperties;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.http.server.reactive.ServerHttpResponse;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@RestController
@RequestMapping("/api")
public class ApiController {
    private final OllamaGateway gateway;
    private final ChatService chat;
    private final InferenceRegistry registry;
    private final LocalOllamaEndpoint endpoint;
    private final String version;

    public ApiController(OllamaGateway gateway, ChatService chat, InferenceRegistry registry,
                         LocalOllamaEndpoint endpoint, ObjectProvider<BuildProperties> build) {
        this.gateway = gateway;
        this.chat = chat;
        this.registry = registry;
        this.endpoint = endpoint;
        BuildProperties properties = build.getIfAvailable();
        this.version = properties == null ? "0.1.0" : properties.getVersion();
    }

    @GetMapping("/status")
    public Mono<Api.Status> status() {
        return gateway.connected().map(connected -> {
            InferenceRegistry.Counters counts = registry.counters();
            return new Api.Status("online", connected, endpoint.displayUrl(), version,
                    System.getProperty("java.version"), ManagementFactory.getRuntimeMXBean().getUptime() / 1000,
                    counts.activeRequests(), InferenceRegistry.MAX_CONCURRENT,
                    counts.totalRequests(), counts.failedRequests());
        });
    }

    @GetMapping("/models")
    public Mono<Api.Models> models() { return gateway.models(); }

    @GetMapping("/requests")
    public Api.Requests requests() { return new Api.Requests(registry.requests()); }

    @PostMapping(value = "/chat", consumes = MediaType.APPLICATION_JSON_VALUE,
            produces = MediaType.APPLICATION_NDJSON_VALUE)
    public Flux<Api.ChatChunk> chat(@Valid @RequestBody Api.ChatRequest request, ServerHttpResponse response) {
        response.getHeaders().setCacheControl("no-store");
        response.getHeaders().set("X-Accel-Buffering", "no");
        return chat.chat(request);
    }
}
