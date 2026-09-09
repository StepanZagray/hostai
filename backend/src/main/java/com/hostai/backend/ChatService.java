package com.hostai.backend;

import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

@Service
public class ChatService {
    private final InferenceRegistry registry;
    private final OllamaGateway gateway;

    public ChatService(InferenceRegistry registry, OllamaGateway gateway) {
        this.registry = registry;
        this.gateway = gateway;
    }

    public Flux<Api.ChatChunk> chat(Api.ChatRequest request) {
        // using owns the lease even if the subscriber cancels before headers arrive.
        return Flux.using(() -> registry.acquire(request.model()), lease -> {
            return gateway.chat(request)
                    // done:true completes inference even if the client stops reading on that
                    // record. Commit accounting before exposing it to downstream cancellation.
                    .doOnNext(chunk -> { if (chunk.done()) lease.completed(chunk.outputTokens()); })
                    .doOnError(error -> lease.failed())
                    .switchOnFirst((first, stream) -> {
                        // A failure before the first record remains an HTTP ProblemDetail.
                        // After commitment the only legal error is a terminal NDJSON record.
                        if (first.isOnError()) return stream;
                        return stream.onErrorResume(error -> Flux.just(Api.ChatChunk.error(
                                error instanceof GatewayException ? error.getMessage()
                                        : "The generation stream failed.")));
                    });
        }, InferenceRegistry.Lease::close);
    }
}
