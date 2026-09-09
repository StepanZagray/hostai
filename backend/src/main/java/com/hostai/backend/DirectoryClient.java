package com.hostai.backend;

import com.fasterxml.jackson.annotation.JsonInclude;
import io.netty.channel.ChannelOption;
import java.net.URI;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.CancellationException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.BooleanSupplier;
import org.springframework.http.MediaType;
import org.springframework.http.client.reactive.ReactorClientHttpConnector;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;
import reactor.netty.http.client.HttpClient;
import tools.jackson.core.StreamReadConstraints;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Fixed-origin, bounded directory protocol. No credentials, redirects, proxies, or retries. */
final class DirectoryClient {
    static final int MAX_RESPONSE = 128 * 1024;
    static final long TTL_MILLIS = 90_000;
    static final String UNAVAILABLE = "The configured directory is unavailable or returned an invalid response. Check its configuration and try again.";
    static final String BUSY = "The directory is busy or full. Publication can retry after the next verified connection update.";
    static final String MISSING = "Set HOSTAI_DIRECTORY_URL to an HTTPS registry origin to enable directory publication.";
    static final String INVALID = "HOSTAI_DIRECTORY_URL must be an HTTPS root origin without credentials, query, or fragment. Development HTTP requires HOSTAI_DIRECTORY_ALLOW_LOOPBACK=true and literal 127.0.0.1 with a valid port.";
    static final JsonMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .streamReadConstraints(StreamReadConstraints.builder().maxDocumentLength(MAX_RESPONSE)
                    .maxNestingDepth(5).maxStringLength(2048).maxNameLength(40)
                    .maxNumberLength(16).maxTokenCount(4096).build()).build())
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
    private static final Base64.Encoder BASE64 = Base64.getUrlEncoder().withoutPadding();
    private final Configuration configuration;
    private final WebClient http;

    DirectoryClient(Configuration configuration) {
        this.configuration = configuration;
        http = configuration.origin() == null ? null : WebClient.builder()
                .clientConnector(new ReactorClientHttpConnector(HttpClient.newConnection()
                        .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, 1500)
                        .followRedirect(false).disableRetry(true).compress(false)
                        .responseTimeout(Duration.ofSeconds(3))))
                .codecs(codecs -> { codecs.defaultCodecs().maxInMemorySize(MAX_RESPONSE);
                    codecs.defaultCodecs().enableLoggingRequestDetails(false); })
                .build();
    }

    record Configuration(URI origin, String error) {
        static Configuration parse(String value, String allowLoopback) {
            if (value == null || value.isBlank()) return new Configuration(null, MISSING);
            try {
                if (!Set.of("true", "false").contains(allowLoopback)) throw new IllegalArgumentException();
                URI uri = new URI(value);
                String host = uri.getHost();
                int port = uri.getPort();
                if (value.length() > 2048 || host == null || uri.getRawUserInfo() != null
                        || uri.getRawQuery() != null || uri.getRawFragment() != null
                        || !(uri.getRawPath().isEmpty() || uri.getRawPath().equals("/"))
                        || port == 0 || port > 65535
                        || !("https".equals(uri.getScheme()) || ("true".equals(allowLoopback)
                            && "http".equals(uri.getScheme()) && "127.0.0.1".equals(host) && port > 0))) {
                    throw new IllegalArgumentException();
                }
                URI origin = new URI(uri.getScheme(), null, host, port, null, null, null);
                // Reject empty/malformed ports and ambiguous authorities instead of normalizing them.
                if (!uri.getRawAuthority().equals(origin.getRawAuthority())) throw new IllegalArgumentException();
                // Signed audience uses URL.origin semantics: lowercase host,
                // no default HTTPS port, and no trailing slash.
                origin = new URI(uri.getScheme(), null, host.toLowerCase(Locale.ROOT),
                        "https".equals(uri.getScheme()) && port == 443 || "http".equals(uri.getScheme()) && port == 80
                                ? -1 : port, null, null, null);
                return new Configuration(origin, null);
            } catch (Exception ignored) { return new Configuration(null, INVALID); }
        }
    }

    Listings listings() {
        var root = exchange("/registry/v1/listings", null, MAX_RESPONSE, () -> false, deadline());
        try {
            exact(root, "version", "servedAt", "listings");
            version(root);
            long servedAt = timestamp(root.get("servedAt"));
            var items = root.get("listings");
            if (!items.isArray() || items.size() > 100) throw new Failure();
            var result = new ArrayList<Entry>();
            var ids = new HashSet<String>();
            for (var item : items) {
                exact(item, "id", "hostLabel", "model", "guestUrl", "updatedAt", "expiresAt", "invitationRequired");
                String id = identityId(item.get("id"));
                if (!ids.add(id)) throw new Failure();
                Listing listing = listing(string(item.get("hostLabel")), string(item.get("model")), string(item.get("guestUrl")));
                if (!item.get("invitationRequired").isBoolean() || !item.get("invitationRequired").booleanValue()) throw new Failure();
                long updated = timestamp(item.get("updatedAt")), expires = timestamp(item.get("expiresAt"));
                if (expires - updated != TTL_MILLIS || updated > servedAt || servedAt - updated > 900_000) throw new Failure();
                result.add(new Entry(id, listing.hostLabel(), listing.model(), listing.guestUrl(), updated, expires, true));
            }
            return new Listings(1, servedAt, List.copyOf(result));
        } catch (RuntimeException ignored) { throw new Failure(); }
    }

    Mutation mutate(DirectoryIdentity identity, Listing listing, BooleanSupplier cancelled) {
        long deadline = deadline();
        check(cancelled);
        String publicKey = identity.publicKey();
        String id = identity.id();
        var challenge = exchange("/registry/v1/challenges", JSON.writeValueAsBytes(
                JSON.createObjectNode().put("publicKey", publicKey)), 2048, cancelled, deadline);
        String nonce;
        try {
            exact(challenge, "version", "nonce", "expiresAt");
            version(challenge);
            nonce = string(challenge.get("nonce"));
            byte[] decoded = Base64.getUrlDecoder().decode(nonce);
            timestamp(challenge.get("expiresAt"));
            // The registry enforces its nonce deadline. Comparing its wall
            // clock with this host's clock incorrectly rejects valid proofs.
            // Our complete exchange is bounded by a monotonic five-second deadline.
            if (decoded.length != 32 || !BASE64.encodeToString(decoded).equals(nonce)) throw new Failure();
        } catch (RuntimeException ignored) { throw new Failure(); }
        check(cancelled);
        var payload = JSON.createObjectNode().put("version", 1)
                .put("audience", configuration.origin().toString()).put("nonce", nonce)
                .put("operation", listing == null ? "withdraw" : "publish");
        if (listing == null) payload.putNull("listing");
        else payload.set("listing", JSON.valueToTree(listing));
        byte[] bytes = JSON.writeValueAsBytes(payload);
        String signature = identity.sign(bytes);
        check(cancelled);
        var result = exchange("/registry/v1/listings", JSON.writeValueAsBytes(JSON.createObjectNode()
                .put("publicKey", publicKey).put("payload", BASE64.encodeToString(bytes)).put("signature", signature)),
                2048, cancelled, deadline);
        try {
            exact(result, "version", "id", "state", "updatedAt", "expiresAt");
            version(result);
            if (!identityId(result.get("id")).equals(id)
                    || !string(result.get("state")).equals(listing == null ? "off" : "listed")) throw new Failure();
            if (listing == null) {
                if (!result.get("updatedAt").isNull() || !result.get("expiresAt").isNull()) throw new Failure();
                return new Mutation(id, null, null);
            }
            long updated = timestamp(result.get("updatedAt")), expires = timestamp(result.get("expiresAt"));
            if (expires - updated != TTL_MILLIS) throw new Failure();
            return new Mutation(id, updated, expires);
        } catch (RuntimeException ignored) { throw new Failure(); }
    }

    private static long deadline() { return System.nanoTime() + Duration.ofSeconds(5).toNanos(); }

    private JsonNode exchange(String path, byte[] body, int maximum, BooleanSupplier cancelled, long deadline) {
        check(cancelled);
        if (http == null || body != null && body.length > 8192) throw new Failure();
        var request = body == null ? http.get().uri(configuration.origin().resolve(path))
                : http.post().uri(configuration.origin().resolve(path)).contentType(MediaType.APPLICATION_JSON).bodyValue(body);
        var future = request.accept(MediaType.APPLICATION_JSON).exchangeToMono(response -> {
            if (response.statusCode().value() == 429) return Mono.<byte[]>error(new Failure(BUSY));
            var headers = response.headers().asHttpHeaders();
            MediaType type;
            try { type = headers.getContentType(); }
            catch (RuntimeException ignored) { return Mono.<byte[]>error(new Failure()); }
            if (response.statusCode().value() != 200 || type == null
                    || headers.getOrEmpty("Content-Type").size() != 1
                    || !type.getType().equals("application") || !type.getSubtype().equals("json")
                    || type.getParameters().keySet().stream().anyMatch(key -> !key.equals("charset"))
                    || type.getCharset() != null && !type.getCharset().equals(java.nio.charset.StandardCharsets.UTF_8)
                    || headers.getContentLength() > maximum || headers.containsHeader("Content-Encoding")) {
                return Mono.<byte[]>error(new Failure());
            }
            return response.bodyToMono(byte[].class).filter(bytes -> bytes.length > 0 && bytes.length <= maximum)
                    .switchIfEmpty(Mono.error(new Failure()));
        }).toFuture();
        try {
            while (true) {
                check(cancelled);
                if (System.nanoTime() >= deadline) throw new Failure();
                try {
                    byte[] bytes = future.get(50, TimeUnit.MILLISECONDS);
                    check(cancelled);
                    // JSON is UTF-8 on the wire. Reject UTF-16/32 and invalid UTF-8 before parsing.
                    var decoder = java.nio.charset.StandardCharsets.UTF_8.newDecoder();
                    var root = JSON.readTree(decoder.decode(java.nio.ByteBuffer.wrap(bytes)).toString());
                    if (root == null) throw new Failure();
                    return root;
                } catch (TimeoutException ignored) { /* Poll intent; cancellation never interrupts transport sharing. */ }
            }
        } catch (CancellationException cancelledRequest) { throw cancelledRequest; }
        catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new CancellationException(); }
        catch (java.util.concurrent.ExecutionException failed) {
            if (failed.getCause() instanceof Failure failure) throw failure;
            throw new Failure();
        }
        catch (Exception ignored) { throw new Failure(); }
        finally { future.cancel(true); }
    }

    static Listing listing(String label, String model, String guestUrl) {
        if (!printable(label, 80) || !label.equals(label.trim()) || !printable(model, 200)
                || !model.matches("[A-Za-z0-9][A-Za-z0-9._/-]*:[A-Za-z0-9_][A-Za-z0-9_.-]*")
                || model.endsWith(":cloud") || model.endsWith("-cloud")
                || guestUrl == null || !guestUrl.matches("https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.trycloudflare\\.com/")) throw new Failure();
        return new Listing(label, model, guestUrl, true);
    }

    private static boolean printable(String value, int maximum) {
        return value != null && !value.isBlank() && value.length() <= maximum
                && value.codePoints().noneMatch(point -> Character.isISOControl(point)
                    || Character.getType(point) == Character.FORMAT || Character.getType(point) == Character.SURROGATE
                    || Character.getType(point) == Character.LINE_SEPARATOR || Character.getType(point) == Character.PARAGRAPH_SEPARATOR);
    }
    private static void check(BooleanSupplier cancelled) { if (cancelled.getAsBoolean()) throw new CancellationException(); }
    private static void exact(JsonNode node, String... fields) {
        if (node == null || !node.isObject() || !new HashSet<>(node.propertyNames()).equals(Set.of(fields))) throw new Failure();
    }
    private static void version(JsonNode node) {
        if (!node.get("version").isInt() || node.get("version").intValue() != 1) throw new Failure();
    }
    private static long timestamp(JsonNode node) {
        if (node == null || !node.isIntegralNumber() || !node.canConvertToLong()
                || node.longValue() < 0 || node.longValue() > 9_007_199_254_740_991L) throw new Failure();
        return node.longValue();
    }
    private static String string(JsonNode node) { if (node == null || !node.isString()) throw new Failure(); return node.stringValue(); }
    private static String identityId(JsonNode node) {
        String value = string(node);
        if (!value.matches("[0-9a-f]{64}")) throw new Failure();
        return value;
    }
    static final class Failure extends RuntimeException {
        Failure() { this(UNAVAILABLE); }
        private Failure(String message) { super(message, null, false, false); }
    }
    record Listing(String hostLabel, String model, String guestUrl, boolean invitationRequired) {}
    record Entry(String id, String hostLabel, String model, String guestUrl, long updatedAt, long expiresAt, boolean invitationRequired) {}
    record Listings(int version, long servedAt, List<Entry> listings) {}
    @JsonInclude(JsonInclude.Include.ALWAYS)
    record Mutation(String id, Long updatedAt, Long expiresAt) {}
}
