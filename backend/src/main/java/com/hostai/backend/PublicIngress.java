package com.hostai.backend;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.http.HttpStatus;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Sinks;

/** One tunnel attempt, with independent permission epochs for reachability loss and recovery. */
final class PublicIngress {
    static final String HEADER = "Cf-Warp-Tag-Hostai-Ingress";
    static final String PROBE_PREFIX = "/guest/v1/reachability/";
    private final String secret = random();
    private final String probeKey = random();
    private final String proof = random();
    private final AtomicBoolean closed = new AtomicBoolean();
    private final Sinks.One<String> lifetime = Sinks.one();
    private volatile URI origin;
    private volatile Epoch epoch;

    String secret() { return secret; }
    String probePath() { return PROBE_PREFIX + probeKey; }
    String proof() { return proof; }
    URI origin() { return origin; }
    boolean closed() { return closed.get(); }

    synchronized void announced(URI candidate) {
        if (closed.get()) return;
        if (origin != null && !origin.equals(candidate)) throw new IllegalStateException("Tunnel origin changed.");
        origin = candidate;
    }

    boolean accepts(URI request, List<String> headers) {
        URI expected = origin;
        return !closed.get() && expected != null && request.getHost() != null
                && expected.getHost().equalsIgnoreCase(request.getHost())
                && (request.getPort() == -1 || request.getPort() == 443)
                && headers.size() == 1 && equal(secret, headers.getFirst());
    }

    synchronized void verified() {
        if (!closed.get() && epoch == null) epoch = new Epoch();
    }

    void interrupted() {
        Epoch previous;
        synchronized (this) { previous = epoch; epoch = null; }
        if (previous != null) previous.ended.tryEmitValue("Internet access ended");
    }

    void close() {
        closed.set(true);
        interrupted();
        lifetime.tryEmitValue("Internet access ended");
    }

    Permit permit() {
        Epoch current = epoch;
        if (closed.get() || current == null) throw unavailable();
        return new Permit(this, current);
    }

    Flux<ProbeChunk> probe(String supplied) {
        if (closed.get() || !equal(probeKey, supplied))
            return Flux.error(new GatewayException(HttpStatus.NOT_FOUND, "The requested endpoint does not exist."));
        // Two flushed records let the verifier distinguish streaming from a buffered response.
        return Flux.concat(Flux.just(new ProbeChunk(0, proof)),
                Mono.delay(Duration.ofSeconds(2)).map(ignored -> new ProbeChunk(1, proof)))
                .takeUntilOther(lifetime.asMono());
    }

    private static String random() {
        byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }
    private static boolean equal(String expected, String actual) {
        return actual != null && actual.length() == expected.length()
                && MessageDigest.isEqual(expected.getBytes(StandardCharsets.US_ASCII), actual.getBytes(StandardCharsets.UTF_8));
    }
    static GatewayException unavailable() {
        return new GatewayException(HttpStatus.SERVICE_UNAVAILABLE, "Internet access is unavailable. Ask the host to check sharing.");
    }
    @Override public String toString() { return "PublicIngress[credentials=<redacted>]"; }
    private static final class Epoch { final Sinks.One<String> ended = Sinks.one(); }
    record ProbeChunk(int sequence, String proof) {}

    static final class Permit {
        static final Permit LOCAL = new Permit(null, null);
        private final PublicIngress ingress;
        private final Epoch epoch;
        private Permit(PublicIngress ingress, Epoch epoch) { this.ingress = ingress; this.epoch = epoch; }
        String channel() { return ingress == null ? "local" : "internet"; }
        String scope() { return ingress == null ? "local-preview" : "temporary-internet"; }
        void requireActive() {
            if (ingress != null && (ingress.closed.get() || ingress.epoch != epoch)) throw unavailable();
        }
        Mono<String> ended() { return ingress == null ? Mono.never() : epoch.ended.asMono(); }
        @Override public String toString() { return "GuestPermit[channel=" + channel() + "]"; }
    }
}
