package com.hostai.backend;

import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import java.util.concurrent.atomic.AtomicReference;

@Service
public class ChatService {
    private final InferenceRegistry registry;
    private final OllamaGateway gateway;

    public ChatService(InferenceRegistry registry, OllamaGateway gateway) {
        this.registry = registry;
        this.gateway = gateway;
    }

    public Flux<Api.ChatChunk> chat(Api.ChatRequest request) {
        return chat(request, false, Mono.never());
    }

    public Flux<Api.ChatChunk> chatGuest(Api.ChatRequest request, Mono<String> accessEnded) {
        return chat(request, true, accessEnded);
    }

    private Flux<Api.ChatChunk> chat(Api.ChatRequest request, boolean guest, Mono<String> accessEnded) {
        // using owns the lease even if the subscriber cancels before headers arrive.
        return Flux.using(() -> guest ? registry.acquireGuest(request.model()) : registry.acquire(request.model()), lease -> {
            AtomicReference<String> ended = new AtomicReference<>();
            Flux<Api.ChatChunk> source = gateway.chat(request);
            if (guest) source = source.takeUntilOther(accessEnded.doOnNext(ended::set))
                    .concatWith(Flux.defer(() -> ended.get() == null ? Flux.empty()
                            : Flux.error(new AccessEndedException())));
            return source
                    // done:true completes inference even if the client stops reading on that
                    // record. Commit accounting before exposing it to downstream cancellation.
                    .doOnNext(chunk -> { if (chunk.done()) lease.completed(chunk.outputTokens()); })
                    .doOnError(error -> {
                        if (error instanceof AccessEndedException) lease.close(); else lease.failed();
                    })
                    .switchOnFirst((first, stream) -> {
                        // A failure before the first record remains an HTTP ProblemDetail.
                        // After commitment the only legal error is a terminal NDJSON record.
                        if (first.isOnError()) return stream;
                        return stream.onErrorResume(error -> Flux.just(Api.ChatChunk.error(
                                error instanceof GatewayException || error instanceof AccessEndedException ? error.getMessage()
                                        : "The generation stream failed.")));
                    });
        }, InferenceRegistry.Lease::close);
    }

    public static final class AccessEndedException extends RuntimeException {
        AccessEndedException() { super("Client access ended. Reconnect with a valid access key."); }
    }
}
