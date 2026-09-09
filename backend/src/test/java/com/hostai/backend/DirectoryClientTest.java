package com.hostai.backend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.time.Clock;
import java.time.Duration;
import java.util.Base64;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.web.reactive.server.WebTestClient;
import tools.jackson.databind.JsonNode;

class DirectoryClientTest {
    @TempDir Path temporary;
    static final String GUEST = "https://fixture-only.trycloudflare.com/";
    static final DirectoryClient.Listing LISTING = DirectoryClient.listing("Fixture host", "fixture:small", GUEST);

    @Test void configurationIsNonfatalAndOnlyExplicitOriginsAreAccepted() {
        assertThat(DirectoryClient.Configuration.parse("", "false").error()).isEqualTo(DirectoryClient.MISSING);
        for (String invalid : List.of("http://registry.example", "http://localhost:8090", "http://127.0.0.2:8090",
                "http://127.0.0.1", "http://127.0.0.1:0", "https://registry.example:65536", "https://registry.example:",
                "https://user:secret@registry.example", "https://registry.example/path", "https://registry.example/?secret",
                "https://registry.example/#secret", "https://registry.example/%2f", "https://registry.example:0443",
                "ftp://registry.example", "//registry.example", "secret")) {
            var config = DirectoryClient.Configuration.parse(invalid, "true");
            assertThat(config.origin()).isNull();
            assertThat(config.error()).isEqualTo(DirectoryClient.INVALID);
        }
        assertThat(DirectoryClient.Configuration.parse("http://127.0.0.1:8090", "false").origin()).isNull();
        assertThat(DirectoryClient.Configuration.parse("https://registry.example", "invalid").origin()).isNull();
        assertThat(DirectoryClient.Configuration.parse("https://registry.example:8443/", "false").origin().toString())
                .isEqualTo("https://registry.example:8443");
        assertThat(DirectoryClient.Configuration.parse("http://127.0.0.1:8090", "true").origin()).isNotNull();
        assertThat(DirectoryClient.Configuration.parse("http://127.0.0.1:80", "true").origin().toString())
                .isEqualTo("http://127.0.0.1");
        assertThat(DirectoryClient.Configuration.parse("https://REGISTRY.example:443/", "false").origin().toString())
                .isEqualTo("https://registry.example");
    }

    @Test void signedWireUsesFreshChallengesExactPayloadsAndStablePublicIdentity() throws Exception {
        try (var fixture = new Fixture(); var identity = new DirectoryIdentity(temporary.resolve("identity"))) {
            var client = fixture.client();
            var result = client.mutate(identity, LISTING, () -> false);
            assertThat(result.id()).isEqualTo(identity.id());
            assertThat(result.expiresAt() - result.updatedAt()).isEqualTo(90_000);
            assertThat(client.listings().listings()).singleElement().satisfies(entry -> {
                assertThat(entry.hostLabel()).isEqualTo("Fixture host");
                assertThat(entry.model()).isEqualTo("fixture:small");
                assertThat(entry.guestUrl()).isEqualTo(GUEST);
                assertThat(entry.invitationRequired()).isTrue();
            });
            assertThat(client.mutate(identity, null, () -> false).updatedAt()).isNull();
            assertThat(client.listings().listings()).isEmpty();
            assertThat(fixture.operations).containsExactly("publish", "withdraw");
            assertThat(fixture.challenges.get()).isEqualTo(2);
            assertThat(fixture.violation.get()).isFalse();
        }
    }

    @Test void listingsRejectErrorsRedirectsWrongTypesOversizeAndInvalidSchemasWithoutEcho() throws Exception {
        try (var fixture = new Fixture()) {
            String valid = "{\"version\":1,\"servedAt\":1,\"listings\":[]}";
            List<Reply> invalid = List.of(new Reply(503, "application/json", "secret-registry-error"),
                    new Reply(302, "application/json", valid), new Reply(200, "text/html", valid),
                    new Reply(200, "application/problem+json", valid), new Reply(200, "application/json; charset=UTF-16", valid),
                    new Reply(200, "application/json", "x".repeat(DirectoryClient.MAX_RESPONSE + 1)),
                    new Reply(200, "application/json", "{\"version\":1,\"servedAt\":1.5,\"listings\":[]}"),
                    new Reply(200, "application/json", "{\"version\":1,\"version\":1,\"servedAt\":1,\"listings\":[]}"),
                    new Reply(200, "application/json", valid + valid),
                    new Reply(200, "application/json", "{\"version\":1,\"servedAt\":1,\"listings\":[],\"secret\":\"raw\"}"),
                    new Reply(200, "application/json", "{\"version\":1,\"servedAt\":1,\"listings\":[null]}"),
                    new Reply(200, "application/json", "{" + "\"secret\":".repeat(10)));
            var client = fixture.client();
            for (Reply reply : invalid) {
                fixture.override = request -> reply;
                assertThatThrownBy(client::listings).isInstanceOf(DirectoryClient.Failure.class)
                        .hasMessage(DirectoryClient.UNAVAILABLE).hasCause(null);
            }
            assertThat(fixture.paths).allMatch(path -> path.equals("GET /registry/v1/listings"));
            assertThat(fixture.paths).hasSize(invalid.size()); // No redirects or retries.
        }
    }

    @Test void hostClockSkewDoesNotRejectRegistryChallengesOrPublicationTimes() throws Exception {
        try (var fixture = new Fixture(); var identity = new DirectoryIdentity(temporary.resolve("identity"))) {
            for (long hours : List.of(-24L, 24L)) {
                fixture.clock = Clock.offset(Clock.systemUTC(), Duration.ofHours(hours));
                var client = fixture.client();
                assertThat(client.mutate(identity, LISTING, () -> false).expiresAt()).isNotNull();
                assertThat(client.listings().listings()).hasSize(1);
                client.mutate(identity, null, () -> false);
            }
            assertThat(fixture.violation.get()).isFalse();
        }
    }

    @Test void listingsValidateEveryEntryAndEnforceTheHundredEntryLimit() throws Exception {
        try (var fixture = new Fixture(); var identity = new DirectoryIdentity(temporary.resolve("identity"))) {
            var client = fixture.client();
            client.mutate(identity, LISTING, () -> false);
            var good = DirectoryClient.JSON.valueToTree(client.listings());
            long servedAt = good.get("servedAt").longValue();
            for (long[] times : List.of(new long[] {servedAt, servedAt + 89_999},
                    new long[] {servedAt + 1, servedAt + 90_001},
                    new long[] {servedAt - 900_001, servedAt - 810_001})) {
                var bad = good.deepCopy();
                var row = (tools.jackson.databind.node.ObjectNode) bad.get("listings").get(0);
                row.put("updatedAt", times[0]).put("expiresAt", times[1]);
                fixture.override = request -> Reply.json(bad);
                assertThatThrownBy(client::listings).hasMessage(DirectoryClient.UNAVAILABLE);
            }
            var noInvitation = good.deepCopy();
            ((tools.jackson.databind.node.ObjectNode) noInvitation.get("listings").get(0)).put("invitationRequired", false);
            fixture.override = request -> Reply.json(noInvitation);
            assertThatThrownBy(client::listings).hasMessage(DirectoryClient.UNAVAILABLE);
            for (String field : List.of("id", "hostLabel", "model", "guestUrl", "invitationRequired", "updatedAt", "expiresAt")) {
                var bad = good.deepCopy();
                ((tools.jackson.databind.node.ObjectNode) bad.get("listings").get(0)).put(field, "invalid\nfield");
                fixture.override = request -> Reply.json(bad);
                assertThatThrownBy(client::listings).hasMessage(DirectoryClient.UNAVAILABLE);
            }
            var duplicate = good.deepCopy();
            var array = (tools.jackson.databind.node.ArrayNode) duplicate.get("listings");
            array.add(array.get(0).deepCopy());
            fixture.override = request -> Reply.json(duplicate);
            assertThatThrownBy(client::listings).hasMessage(DirectoryClient.UNAVAILABLE);
            var excessive = good.deepCopy();
            var entries = (tools.jackson.databind.node.ArrayNode) excessive.get("listings");
            for (int index = 1; index <= 100; index++) {
                var next = (tools.jackson.databind.node.ObjectNode) entries.get(0).deepCopy();
                next.put("id", String.format("%064x", index)); entries.add(next);
            }
            fixture.override = request -> Reply.json(excessive);
            assertThatThrownBy(client::listings).hasMessage(DirectoryClient.UNAVAILABLE);
            for (String guest : List.of("https://fixture-only.trycloudflare.com/#access=secret",
                    "https://fixture-only.trycloudflare.com:443/", "https://user@fixture-only.trycloudflare.com/",
                    "http://fixture-only.trycloudflare.com/", "https://nested.fixture-only.trycloudflare.com/")) {
                assertThatThrownBy(() -> DirectoryClient.listing("Fixture", "fixture:small", guest)).hasMessage(DirectoryClient.UNAVAILABLE);
            }
        }
    }

    @Test void invalidChallengesCannotReachMutationAndCancellationDoesNotReplay() throws Exception {
        try (var fixture = new Fixture(); var identity = new DirectoryIdentity(temporary.resolve("identity"))) {
            fixture.override = request -> request.path().equals("/registry/v1/challenges")
                    ? new Reply(200, "application/json", "{\"version\":1,\"nonce\":\"secret\",\"expiresAt\":1}") : null;
            assertThatThrownBy(() -> fixture.client().mutate(identity, LISTING, () -> false)).hasMessage(DirectoryClient.UNAVAILABLE);
            assertThat(fixture.paths).containsExactly("POST /registry/v1/challenges");
            var cancelled = new AtomicBoolean();
            fixture.override = request -> { cancelled.set(true); return null; };
            assertThatThrownBy(() -> fixture.client().mutate(identity, LISTING, cancelled::get))
                    .isInstanceOf(java.util.concurrent.CancellationException.class);
            assertThat(fixture.operations).isEmpty();
        }
    }

    @Test void mutationReplyCannotChangeTheRegistryTtl() throws Exception {
        try (var fixture = new Fixture(); var identity = new DirectoryIdentity(temporary.resolve("identity"))) {
            fixture.override = request -> request.path().equals("/registry/v1/listings")
                    ? Reply.json(DirectoryClient.JSON.createObjectNode().put("version", 1).put("id", identity.id())
                        .put("state", "listed").put("updatedAt", 1_800_000_000_000L).put("expiresAt", 1_800_000_090_001L)) : null;
            assertThatThrownBy(() -> fixture.client().mutate(identity, LISTING, () -> false))
                    .hasMessage(DirectoryClient.UNAVAILABLE);
        }
    }

    @Test void directoryAdmissionIsDistinguishedFromConfigurationFailureWithoutEchoingItsBody() throws Exception {
        try (var fixture = new Fixture(); var identity = new DirectoryIdentity(temporary.resolve("identity"))) {
            fixture.override = request -> new Reply(429, "text/plain", "private-registry-error");
            assertThatThrownBy(() -> fixture.client().mutate(identity, LISTING, () -> false))
                    .hasMessage(DirectoryClient.BUSY).hasCause(null);
            assertThat(fixture.paths).containsExactly("POST /registry/v1/challenges");
        }
    }

    @Test void stalledRegistryResponseHasAHardDeadlineAndNoRetry() throws Exception {
        try (var fixture = new Fixture()) {
            var release = new CountDownLatch(1);
            fixture.override = request -> {
                try { release.await(8, TimeUnit.SECONDS); }
                catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
                return Reply.json(new DirectoryClient.Listings(1, System.currentTimeMillis(), List.of()));
            };
            long before = System.nanoTime();
            try {
                assertThatThrownBy(() -> fixture.client().listings()).hasMessage(DirectoryClient.UNAVAILABLE);
                assertThat(Duration.ofNanos(System.nanoTime() - before)).isLessThan(Duration.ofSeconds(6));
                assertThat(fixture.paths).containsExactly("GET /registry/v1/listings");
            } finally { release.countDown(); }
        }
    }

    @Test void ownerRoutesEnforceEmptyJsonAndNeverAcceptAnAlternateRegistry() throws Exception {
        try (var fixture = new Fixture()) {
            var transport = new DirectoryPublicationTest.Transport();
            try (var directory = new DirectoryPublication(fixture.configuration(), () -> { throw new AssertionError(); },
                    transport.internet, () -> { throw new AssertionError(); })) {
                var web = WebTestClient.bindToController(new DirectoryController(directory)).controllerAdvice(new ApiErrors()).build();
                web.get().uri("/api/directory").exchange().expectStatus().isOk().expectHeader().valueEquals("Cache-Control", "no-store")
                        .expectBody().jsonPath("$.identityId").isEqualTo(null).jsonPath("$.expiresAt").isEqualTo(null);
                for (String route : List.of("/api/directory", "/api/directory/listings")) {
                    web.get().uri(route).header("Origin", "https://foreign.invalid").exchange().expectStatus().isForbidden();
                    for (String site : List.of("cross-site", "same-site")) {
                        web.get().uri(route).header("Sec-Fetch-Site", site).exchange().expectStatus().isForbidden();
                    }
                }
                assertThat(fixture.paths).isEmpty();
                for (String body : List.of("null", "[]", "{\"url\":\"http://forbidden.invalid\"}", "{}{}", "{\"x\":1,\"x\":2}")) {
                    web.post().uri("/api/directory/start").contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                            .bodyValue(body).exchange().expectStatus().isBadRequest()
                            .expectBody().jsonPath("$.detail").isEqualTo("Directory actions require an empty JSON object {}.");
                }
                for (String route : List.of("start", "stop")) {
                    web.post().uri("/api/directory/" + route).contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                            .header("Origin", "https://foreign.invalid").bodyValue("{}").exchange().expectStatus().isForbidden();
                    web.post().uri("/api/directory/" + route).contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                            .header("Sec-Fetch-Site", "cross-site").bodyValue("{}").exchange().expectStatus().isForbidden();
                }
                web.post().uri("/api/directory/stop").contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                        .bodyValue("{}").exchange().expectStatus().isOk();
                web.get().uri("/api/directory/listings?url=http://forbidden.invalid&query=secret").exchange()
                        .expectStatus().isOk().expectBody().jsonPath("$.listings").isArray();
                assertThat(fixture.paths).containsExactly("GET /registry/v1/listings");
                fixture.override = request -> new Reply(503, "text/plain", "secret-registry-error");
                web.get().uri("/api/directory/listings").exchange().expectStatus().isEqualTo(503)
                        .expectHeader().valueEquals("Cache-Control", "no-store")
                        .expectBody().jsonPath("$.detail").isEqualTo(DirectoryClient.UNAVAILABLE);
            }
        }
    }

    record Request(String method, String path, JsonNode body) {}
    record Reply(int status, String type, String body) {
        static Reply json(Object body) { return new Reply(200, "application/json", DirectoryClient.JSON.writeValueAsString(body)); }
    }

    /** Ephemeral loopback-only signed registry. Delays and malformed replies are bounded test controls. */
    static final class Fixture implements AutoCloseable {
        final HttpServer server;
        volatile Clock clock = Clock.systemUTC();
        final java.util.concurrent.ExecutorService executor = Executors.newFixedThreadPool(2);
        final List<String> paths = new CopyOnWriteArrayList<>();
        final List<String> operations = new CopyOnWriteArrayList<>();
        final AtomicInteger challenges = new AtomicInteger();
        final AtomicBoolean violation = new AtomicBoolean();
        volatile Function<Request, Reply> override = request -> null;
        volatile boolean failWithdraw;
        volatile CountDownLatch publishEntered;
        volatile CountDownLatch releasePublish;
        private String nonce;
        private String nonceKey;
        private DirectoryClient.Entry entry;

        Fixture() throws IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 8);
            server.setExecutor(executor);
            server.createContext("/", this::handle);
            server.start();
        }
        DirectoryClient.Configuration configuration() {
            return DirectoryClient.Configuration.parse("http://127.0.0.1:" + server.getAddress().getPort(), "true");
        }
        DirectoryClient client() { return new DirectoryClient(configuration()); }
        private void handle(HttpExchange exchange) throws IOException {
            try {
                String method = exchange.getRequestMethod(), path = exchange.getRequestURI().toString();
                paths.add(method + " " + path);
                if (exchange.getRequestHeaders().containsKey("Cookie") || exchange.getRequestHeaders().containsKey("Authorization")
                        || exchange.getRequestHeaders().containsKey("Proxy-Authorization")) throw new IllegalStateException();
                byte[] bytes = exchange.getRequestBody().readNBytes(8193);
                if (bytes.length > 8192) throw new IllegalStateException();
                if (method.equals("POST") && !"application/json".equals(exchange.getRequestHeaders().getFirst("Content-Type")))
                    throw new IllegalStateException();
                var request = new Request(method, path, bytes.length == 0 ? null : DirectoryClient.JSON.readTree(bytes));
                Reply reply = override.apply(request);
                if (reply == null) reply = protocol(request);
                if (path.equals("/registry/v1/listings") && method.equals("POST") && request.body() != null
                        && DirectoryClient.JSON.readTree(Base64.getUrlDecoder().decode(request.body().get("payload").stringValue()))
                            .get("operation").stringValue().equals("publish") && publishEntered != null) {
                    publishEntered.countDown();
                    if (releasePublish != null) releasePublish.await(3, TimeUnit.SECONDS);
                }
                exchange.getResponseHeaders().set("Content-Type", reply.type());
                if (reply.status() == 302) exchange.getResponseHeaders().set("Location", configuration().origin() + "/forbidden");
                byte[] output = reply.body().getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(reply.status(), output.length);
                exchange.getResponseBody().write(output);
            } catch (IOException ignored) { /* A cancelled client can close an already-applied mutation response. */ }
            catch (Exception ignored) { violation.set(true); exchange.sendResponseHeaders(500, -1); }
            finally { exchange.close(); }
        }
        private synchronized Reply protocol(Request request) throws Exception {
            if (request.method().equals("GET") && request.path().equals("/registry/v1/listings"))
                return Reply.json(new DirectoryClient.Listings(1, clock.millis(), entry == null ? List.of() : List.of(entry)));
            JsonNode body = request.body();
            if (request.path().equals("/registry/v1/challenges")) {
                exact(body, "publicKey");
                nonceKey = body.get("publicKey").stringValue();
                byte[] random = new byte[32]; new java.security.SecureRandom().nextBytes(random);
                nonce = Base64.getUrlEncoder().withoutPadding().encodeToString(random);
                challenges.incrementAndGet();
                return Reply.json(DirectoryClient.JSON.createObjectNode().put("version", 1).put("nonce", nonce)
                        .put("expiresAt", clock.millis() + 30_000));
            }
            if (!request.path().equals("/registry/v1/listings") || !request.method().equals("POST")) throw new IllegalStateException();
            exact(body, "publicKey", "payload", "signature");
            String publicKey = body.get("publicKey").stringValue();
            byte[] der = Base64.getUrlDecoder().decode(publicKey);
            String id = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(der));
            byte[] payload = Base64.getUrlDecoder().decode(body.get("payload").stringValue());
            var signature = Signature.getInstance("Ed25519");
            signature.initVerify(KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(der)));
            signature.update(payload);
            if (!signature.verify(Base64.getUrlDecoder().decode(body.get("signature").stringValue()))) throw new IllegalStateException();
            var mutation = DirectoryClient.JSON.readTree(payload);
            exact(mutation, "version", "audience", "nonce", "operation", "listing");
            if (mutation.get("version").intValue() != 1 || !publicKey.equals(nonceKey)
                    || !mutation.get("audience").stringValue().equals(configuration().origin().toString())
                    || !mutation.get("nonce").stringValue().equals(nonce)) throw new IllegalStateException();
            nonce = null;
            String operation = mutation.get("operation").stringValue();
            operations.add(operation);
            long updated = clock.millis();
            if (operation.equals("publish")) {
                var listing = mutation.get("listing");
                exact(listing, "hostLabel", "model", "guestUrl", "invitationRequired");
                if (!listing.get("invitationRequired").booleanValue()) throw new IllegalStateException();
                DirectoryClient.Listing validated = DirectoryClient.listing(listing.get("hostLabel").stringValue(),
                        listing.get("model").stringValue(), listing.get("guestUrl").stringValue());
                entry = new DirectoryClient.Entry(id, validated.hostLabel(), validated.model(), validated.guestUrl(),
                        updated, updated + 90_000, true);
            } else if (operation.equals("withdraw") && mutation.get("listing").isNull()) {
                if (failWithdraw) return new Reply(503, "application/json", "secret-withdraw-error");
                entry = null;
            } else throw new IllegalStateException();
            var result = DirectoryClient.JSON.createObjectNode().put("version", 1).put("id", id)
                    .put("state", entry == null ? "off" : "listed");
            if (entry == null) result.putNull("updatedAt").putNull("expiresAt");
            else result.put("updatedAt", entry.updatedAt()).put("expiresAt", entry.expiresAt());
            return Reply.json(result);
        }
        private static void exact(JsonNode node, String... fields) {
            if (!node.isObject() || !new HashSet<>(node.propertyNames()).equals(Set.of(fields))) throw new IllegalStateException();
        }
        @Override public void close() throws Exception {
            if (releasePublish != null) releasePublish.countDown();
            server.stop(0); executor.shutdownNow();
            if (!executor.awaitTermination(2, TimeUnit.SECONDS)) throw new IllegalStateException("Fixture worker cleanup failed.");
        }
    }
}
