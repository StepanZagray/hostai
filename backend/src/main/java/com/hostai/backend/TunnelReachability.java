package com.hostai.backend;

import io.netty.channel.ChannelOption;
import io.netty.handler.codec.http.websocketx.TextWebSocketFrame;
import io.netty.handler.codec.http.websocketx.WebSocketClientHandshakeException;
import java.net.URI;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicLong;
import reactor.netty.http.client.HttpClient;
import reactor.netty.http.client.WebsocketClientSpec;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.json.JsonMapper;

/** Bounded strict-TLS WSS proof of this attempt and incremental frame delivery; never runs inference. */
final class TunnelReachability implements InternetSharing.Probe {
    private static final String UNVERIFIED = "The public endpoint could not be verified for secure WebSocket streaming.";
    private static final JsonMapper JSON = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT).build();
    private final HttpClient client;
    private volatile String failure = UNVERIFIED;

    TunnelReachability() { this(HttpClient.newConnection().secure()); }

    // Test seam can supply private DNS and a fixture CA. Production uses platform trust and hostname verification.
    TunnelReachability(HttpClient client) {
        this.client = client.option(ChannelOption.CONNECT_TIMEOUT_MILLIS, 3000)
                .followRedirect(false).disableRetry(true).responseTimeout(Duration.ofSeconds(5))
                .httpResponseDecoder(decoder -> decoder.maxInitialLineLength(2048).maxHeaderSize(8192));
    }
    @Override public String failure() { return failure; }

    @Override public boolean verify(URI publicOrigin, PublicIngress ingress) {
        failure = UNVERIFIED;
        if (publicOrigin == null || ingress.closed()
                || !QuickTunnelProcess.publicOrigin(publicOrigin.toString()).filter(publicOrigin::equals).isPresent()) return false;
        // Reconstruct only from the already validated canonical HTTPS hostname; no redirects or URL adapter.
        URI socket = URI.create("wss://" + publicOrigin.getHost() + ingress.probePath());
        AtomicLong first = new AtomicLong();
        try {
            var result = client.websocket(WebsocketClientSpec.builder().maxFramePayloadLength(2048).compress(false).build())
                    .uri(socket.toString()).handle((inbound, outbound) -> inbound.aggregateFrames(2048).receiveFrames()
                            .map(frame -> {
                                if (!(frame instanceof TextWebSocketFrame text)) throw rejected();
                                var record = JSON.readTree(text.text());
                                if (record == null || !record.isObject() || record.size() != 2
                                        || !record.hasNonNull("sequence") || !record.get("sequence").isIntegralNumber()
                                        || !record.hasNonNull("proof") || !record.get("proof").isString()) throw rejected();
                                return JSON.treeToValue(record, PublicIngress.ProbeChunk.class);
                            }).take(2).index().map(item -> {
                                long now = System.nanoTime();
                                if (item.getT1() == 0) first.set(now);
                                var chunk = item.getT2();
                                if (chunk.sequence() != item.getT1().intValue() || !ingress.proof().equals(chunk.proof())) {
                                    failure = "The public endpoint did not return this tunnel's verification proof.";
                                    return false;
                                }
                                if (item.getT1() == 1 && now - first.get() < Duration.ofSeconds(1).toNanos()) {
                                    failure = "The relay buffered the verification response. Incremental chat delivery could not be verified.";
                                    return false;
                                }
                                return true;
                            }))
                    .timeout(Duration.ofSeconds(5)).collectList().block(Duration.ofSeconds(9));
            if (result == null || result.size() != 2) {
                failure = "The public connection ended before both verification records arrived.";
                return false;
            }
            return !ingress.closed() && result.stream().allMatch(Boolean::booleanValue);
        } catch (RuntimeException error) {
            // Never echo handshake messages, response bodies, raw frames, hostnames or proof URLs.
            Throwable cause = error;
            for (int depth = 0; cause != null && depth < 8; depth++, cause = cause.getCause()) {
                if (cause instanceof javax.net.ssl.SSLException) { failure = "The public endpoint's HTTPS certificate or TLS connection could not be verified."; break; }
                if (cause instanceof java.net.UnknownHostException) { failure = "The public hostname could not be resolved. Check DNS and try again."; break; }
                if (cause instanceof java.net.ConnectException) { failure = "The public endpoint could not be reached. Check the network and try again."; break; }
                if (cause instanceof java.util.concurrent.TimeoutException) { failure = "The public streaming check timed out. Check the network and try again."; break; }
                if (cause instanceof WebSocketClientHandshakeException handshake && handshake.response() != null) {
                    failure = "The public verification request returned HTTP " + handshake.response().status().code() + "."; break;
                }
            }
            return false;
        }
    }

    private static IllegalArgumentException rejected() { return new IllegalArgumentException("Invalid verification record."); }
}
