package com.hostai.backend;

import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import tools.jackson.databind.JsonNode;

/** One configured loopback process that lists models and runs inference; payloads stay opaque. */
public interface InferenceRuntime {
    /** Stable id used in model records and asset routes. */
    String id();

    /** Bounded liveness probe; never starts a download or loads a model. */
    Mono<Boolean> connected();

    /** Installed models with their {@link Api.ModelUi}; unavailable metadata is {@code connected:false}. */
    Mono<Api.Models> models();

    /** Chat generation; runtimes without a chat protocol answer with an error before the first record. */
    Flux<Api.ChatChunk> chat(Api.ChatRequest request);

    /** Opaque inference; runtimes without one answer with an error before the first record. */
    Flux<Api.InferRecord> infer(String model, JsonNode input);

    /** A UI asset relative to the runtime origin (no leading slash); empty means not found. */
    Mono<byte[]> asset(String relativePath);

    /** Where this runtime's UI files live, or null. */
    default Api.ModelUi ui() { return null; }
}
