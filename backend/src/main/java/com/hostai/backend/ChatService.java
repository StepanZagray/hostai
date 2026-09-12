package com.hostai.backend;

import java.util.function.Function;
import java.util.function.Predicate;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import java.util.concurrent.atomic.AtomicReference;

/** Leased chat and opaque inference over the runtime catalog; both share the two inference slots. */
@Service
public class ChatService {
    private final InferenceRegistry registry;
    private final RuntimeCatalog catalog;

    public ChatService(InferenceRegistry registry, RuntimeCatalog catalog) {
        this.registry = registry;
        this.catalog = catalog;
    }

    public Flux<Api.ChatChunk> chat(Api.ChatRequest request) {
        return run(request.model(), false, Mono.never(), catalog.read(), runtime -> runtime.chat(request), CHAT);
    }

    /** Guest chat over a catalog the caller has already read for its own availability check. */
    public Flux<Api.ChatChunk> chatGuest(RuntimeCatalog.Catalog resolved, Api.ChatRequest request, Mono<String> accessEnded) {
        return run(request.model(), true, accessEnded, Mono.just(resolved), runtime -> runtime.chat(request), CHAT);
    }

    public Flux<Api.InferRecord> infer(Api.InferRequest request) {
        return run(request.model(), false, Mono.never(), catalog.read(),
                runtime -> runtime.infer(request.model(), request.input()), INFER);
    }

    public Flux<Api.InferRecord> inferGuest(RuntimeCatalog.Catalog resolved, Api.InferRequest request, Mono<String> accessEnded) {
        return run(request.model(), true, accessEnded, Mono.just(resolved),
                runtime -> runtime.infer(request.model(), request.input()), INFER);
    }

    /** How one record kind reports completion, failure, tokens, and a terminal error. */
    private record Kind<T>(Predicate<T> done, Predicate<T> failed, Function<T, Long> tokens, Function<String, T> error) {}

    private static final Kind<Api.ChatChunk> CHAT = new Kind<>(Api.ChatChunk::done, chunk -> chunk.error() != null,
            Api.ChatChunk::outputTokens, Api.ChatChunk::error);
    private static final Kind<Api.InferRecord> INFER = new Kind<>(Api.InferRecord::done,
            record -> record.error() != null, record -> null, Api.InferRecord::error);

    private <T> Flux<T> run(String model, boolean guest, Mono<String> accessEnded, Mono<RuntimeCatalog.Catalog> resolved,
                            Function<InferenceRuntime, Flux<T>> start, Kind<T> kind) {
        // using owns the lease even if the subscriber cancels before headers arrive.
        return Flux.using(() -> guest ? registry.acquireGuest(model) : registry.acquire(model), lease -> {
            AtomicReference<String> ended = new AtomicReference<>();
            Flux<T> source = resolved.flatMapMany(catalog -> start.apply(catalog.forModel(model)));
            if (guest) source = source.takeUntilOther(accessEnded.doOnNext(ended::set))
                    .concatWith(Flux.defer(() -> ended.get() == null ? Flux.empty()
                            : Flux.error(new AccessEndedException())));
            return source
                    // done:true completes inference even if the client stops reading on that
                    // record. Commit accounting before exposing it to downstream cancellation.
                    .doOnNext(record -> {
                        if (!kind.done().test(record)) return;
                        if (kind.failed().test(record)) lease.failed(); else lease.completed(kind.tokens().apply(record));
                    })
                    .doOnError(error -> {
                        if (error instanceof AccessEndedException) lease.close(); else lease.failed();
                    })
                    .switchOnFirst((first, stream) -> {
                        // A failure before the first record remains an HTTP ProblemDetail.
                        // After commitment the only legal error is a terminal record.
                        if (first.isOnError()) return stream;
                        return stream.onErrorResume(error -> Flux.just(kind.error().apply(
                                error instanceof GatewayException || error instanceof AccessEndedException ? error.getMessage()
                                        : "The generation stream failed.")));
                    });
        }, InferenceRegistry.Lease::close);
    }

    public static final class AccessEndedException extends RuntimeException {
        AccessEndedException() { super("Client access ended. Reconnect with a valid access key."); }
    }
}
