package com.hostai.backend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.json.JsonMapper;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"hostai.guest-port=0", "hostai.stream-idle-timeout=3s", "hostai.generation-timeout=10s"})
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class SharingHttpTest {
    private static final SharingRuntimeStub STUB = new SharingRuntimeStub();
    static final Path directory = temporaryDirectory();
    private static Path temporaryDirectory() {
        try { return Files.createTempDirectory("hostai-sharing-http-"); }
        catch (java.io.IOException error) { throw new java.io.UncheckedIOException(error); }
    }
    @DynamicPropertySource static void properties(DynamicPropertyRegistry properties) {
        properties.add("hostai.ollama-url", STUB::origin);
        properties.add("hostai.access-directory", () -> directory.resolve("access").toString());
    }
    @Value("${local.server.port}") int port;
    @Autowired SharingService sharing;
    @Autowired InferenceRegistry registry;
    @Autowired JsonMapper json;
    HttpClient client;
    String guest;
    String token;
    UUID grantId;

    @BeforeEach void prepare() throws Exception {
        client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).version(HttpClient.Version.HTTP_1_1).build();
        sharing.stop();
        STUB.available = true; STUB.records = SharingRuntimeStub.complete();
        var started = post(owner("/api/sharing/start"), Map.of("model", "fixture-shared:small", "hostLabel", "Fixture host"), null);
        assertThat(started.statusCode()).isEqualTo(200);
        guest = (String) object(started).get("guestUrl");
        var created = post(owner("/api/sharing/grants"), Map.of("label", "Fixture visitor", "expiresInHours", 1), null);
        assertThat(created.statusCode()).isEqualTo(200);
        assertThat(created.headers().firstValue("Cache-Control")).contains("no-store");
        var body = object(created);
        token = (String) body.get("token");
        grantId = UUID.fromString((String) ((Map<?, ?>) body.get("grant")).get("id"));
        STUB.chats.set(0); STUB.metadata.set(0); STUB.unexpected.set(0);
    }

    @AfterEach void clean() throws Exception {
        sharing.stop();
        client.shutdownNow();
        assertThat(client.awaitTermination(Duration.ofSeconds(5))).isTrue();
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
            assertThat(registry.counters().activeRequests()).isZero();
            assertThat(STUB.connections.get()).isZero();
        });
        assertThat(STUB.unexpected.get()).isZero();
    }
    @AfterAll void close() throws Exception {
        sharing.close(); STUB.close();
        try (var paths = Files.walk(directory)) {
            for (var path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.delete(path);
        }
    }

    @Test void guestRouterHasNoOwnerRoutesAndServesOnlyItsOwnPage() throws Exception {
        for (String path : List.of("/api/status", "/api/models", "/api/requests", "/api/model-downloads", "/api/sharing",
                "/actuator/health", "/playground", "/models", "/sharing", "/assets/../guest.html")) {
            assertThat(get(guest + path, token).statusCode()).as(path).isEqualTo(404);
        }
        var html = get(guest + "/", null);
        assertThat(html.statusCode()).isEqualTo(200);
        assertThat(html.headers().firstValue("Content-Security-Policy").orElseThrow()).contains("frame-ancestors 'none'");
        assertThat(html.headers().firstValue("Referrer-Policy")).contains("no-referrer");
        assertThat(html.body()).doesNotContain("HostProvider", "Request activity");
        assertThat(Files.readString(directory.resolve("access/grants.json"))).doesNotContain(token);
    }

    @Test void tokenIsRequiredAndRevokedUnknownAndMissingKeysAreIndistinguishable() throws Exception {
        var missing = get(guest + "/guest/v1/session", null);
        var wrong = get(guest + "/guest/v1/session", "not-a-key");
        assertThat(missing.statusCode()).isEqualTo(401);
        assertThat(wrong.body()).isEqualTo(missing.body());
        assertThat(get(guest + "/guest/v1/session?access=" + token, null).statusCode()).isEqualTo(401);
        var cookie = client.send(HttpRequest.newBuilder(URI.create(guest + "/guest/v1/session")).header("Cookie", "access=" + token).GET().build(), HttpResponse.BodyHandlers.ofString());
        assertThat(cookie.statusCode()).isEqualTo(401);
        assertThat(post(owner("/api/sharing/grants/" + grantId + "/revoke"), Map.of(), null).statusCode()).isEqualTo(200);
        var revoked = get(guest + "/guest/v1/session", token);
        assertThat(revoked.body()).isEqualTo(missing.body());
        assertThat(STUB.metadata.get()).isZero();
        assertThat(STUB.chats.get()).isZero();
    }

    @Test void chatRejectsMissingInvalidAndDuplicateCredentialsBeforeRuntimeWork() throws Exception {
        for (String key : new String[] {null, "not-a-key"}) {
            var response = post(guest + "/guest/v1/chat", chat("fixture-shared:small", 128), key);
            assertThat(response.statusCode()).isEqualTo(401);
            assertThat(response.headers().firstValue("WWW-Authenticate")).contains("Bearer");
            assertThat(response.body()).doesNotContain("not-a-key");
        }
        var duplicate = request(guest + "/guest/v1/chat", token).header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString("{}"));
        assertThat(client.send(duplicate.build(), HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(401);
        assertThat(STUB.metadata.get()).isZero();
        assertThat(STUB.chats.get()).isZero();
    }

    @Test void guestRejectsReboundHostAndUnnormalizedAssetPaths() throws Exception {
        int guestPort = URI.create(guest).getPort();
        assertThat(rawGet(guestPort, "/guest/v1/session", "attacker.example")).startsWith("HTTP/1.1 403");
        for (String path : List.of("/assets/../guest.html", "/assets/%2e%2e%2fguest.html", "/assets/%2e%2e%2fapplication.properties")) {
            String response = rawGet(guestPort, path, "127.0.0.1:" + guestPort);
            assertThat(response.substring(0, response.indexOf("\r\n"))).matches("HTTP/1.1 (400|404).*" );
            assertThat(response).doesNotContain("<html", "spring.application.name");
        }
        assertThat(STUB.metadata.get()).isZero();
    }

    @Test void switchingPublicationNeverTransfersAnOldKeysPermission() throws Exception {
        sharing.stop();
        assertThat(post(owner("/api/sharing/start"), Map.of("model", "private-owner:small", "hostLabel", "Fixture host"), null).statusCode()).isEqualTo(200);
        STUB.metadata.set(0);
        assertThat(get(guest + "/guest/v1/session", token).statusCode()).isEqualTo(401);
        assertThat(post(guest + "/guest/v1/chat", chat("private-owner:small", 128), token).statusCode()).isEqualTo(401);
        assertThat(STUB.metadata.get()).isZero();
        assertThat(STUB.chats.get()).isZero();
    }

    private String rawGet(int port, String path, String host) throws Exception {
        try (var socket = new java.net.Socket("127.0.0.1", port)) {
            socket.setSoTimeout(5000);
            socket.getOutputStream().write(("GET " + path + " HTTP/1.1\r\nHost: " + host
                    + "\r\nAuthorization: Bearer " + token + "\r\nConnection: close\r\n\r\n").getBytes(java.nio.charset.StandardCharsets.US_ASCII));
            return new String(socket.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        }
    }

    @Test void sessionContainsOnlyGrantedModelAndSafeClientMetadata() throws Exception {
        var response = get(guest + "/guest/v1/session", token);
        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(object(response)).containsOnlyKeys("hostLabel", "model", "expiresAt", "available", "unavailableReason", "maxConcurrentGuests", "maxTokens", "requestsPerMinute", "scope")
                .containsEntry("model", "fixture-shared:small").containsEntry("hostLabel", "Fixture host")
                .containsEntry("available", true).containsEntry("scope", "local-preview");
        assertThat(response.body()).doesNotContain("private-owner", "ollamaUrl", "javaVersion", "totalRequests", "hash", token);
        var owner = get(owner("/api/sharing"), null);
        assertThat(owner.body()).doesNotContain(token, "hash", "inviteUrl");
    }

    @Test void scopeAndInputLimitsRejectBeforeAnyRuntimeWork() throws Exception {
        assertThat(post(guest + "/guest/v1/chat", chat("private-owner:small", 128), token).statusCode()).isEqualTo(403);
        assertThat(post(guest + "/guest/v1/chat", chat("fixture-shared:small", 1025), token).statusCode()).isEqualTo(400);
        var unknown = new java.util.HashMap<>(chat("fixture-shared:small", 128));
        unknown.put("insecure", true);
        assertThat(post(guest + "/guest/v1/chat", unknown, token).statusCode()).isEqualTo(400);
        var invalid = rawPost(guest + "/guest/v1/chat", "{\"model\":\"fixture-shared:small\",\"model\":\"private-owner:small\"}", token, "application/json");
        assertThat(invalid.statusCode()).isEqualTo(400);
        assertThat(rawPost(guest + "/guest/v1/chat", "{}", token, "text/plain").statusCode()).isEqualTo(415);
        assertThat(rawPost(guest + "/guest/v1/chat", "{\"model\":\"" + "x".repeat(262145) + "\"}", token, "application/json").statusCode()).isEqualTo(413);
        assertThat(STUB.metadata.get()).isZero();
        assertThat(STUB.chats.get()).isZero();
    }

    @Test void guestsHaveOneSlotAndOwnerCanStillGenerate() throws Exception {
        STUB.records = SharingRuntimeStub.hold();
        var first = stream(guest + "/guest/v1/chat", token, "fixture-shared:small");
        assertThat(first.statusCode()).isEqualTo(200);
        assertThat(new String(first.body().readNBytes(20))).contains("Partial");
        var busy = post(guest + "/guest/v1/chat", chat("fixture-shared:small", 128), token);
        assertThat(busy.statusCode()).isEqualTo(429);
        assertThat(busy.headers().firstValue("Retry-After")).contains("1");
        var owner = stream(owner("/api/chat"), null, "private-owner:small");
        assertThat(owner.statusCode()).isEqualTo(200);
        assertThat(new String(owner.body().readNBytes(20))).contains("Partial");
        assertThat(registry.counters().activeRequests()).isEqualTo(2);
        owner.body().close(); first.body().close();
    }

    @Test void revokeCommitsThenTerminatesTheGuestStreamAndItsRuntimeExchange() throws Exception {
        STUB.records = SharingRuntimeStub.hold();
        var response = stream(guest + "/guest/v1/chat", token, "fixture-shared:small");
        assertThat(response.statusCode()).isEqualTo(200);
        String prefix = new String(response.body().readNBytes(20));
        assertThat(prefix).contains("Partial");
        var revoked = post(owner("/api/sharing/grants/" + grantId + "/revoke"), Map.of(), null);
        assertThat(revoked.statusCode()).isEqualTo(200);
        String remainder = new String(response.body().readAllBytes());
        assertThat(remainder).contains("Client access ended.");
        assertThat(Files.readString(directory.resolve("access/grants.json"))).contains("\"revokedAt\":\"");
        await().atMost(Duration.ofSeconds(3)).untilAsserted(() -> assertThat(STUB.connections.get()).isZero());
        assertThat(get(guest + "/guest/v1/session", token).statusCode()).isEqualTo(401);
        assertThat(post(owner("/api/sharing/grants/" + grantId + "/revoke"), Map.of(), null).statusCode()).isEqualTo(200);
    }

    @Test void stoppingAccessEndsGuestsButDoesNotRevokeKeysOrStopLocalChat() throws Exception {
        STUB.records = SharingRuntimeStub.hold();
        var response = stream(guest + "/guest/v1/chat", token, "fixture-shared:small");
        response.body().readNBytes(20);
        assertThat(post(owner("/api/sharing/stop"), Map.of(), null).statusCode()).isEqualTo(200);
        assertThat(new String(response.body().readAllBytes())).contains("Client access ended.");
        assertThat(get(guest + "/guest/v1/session", token).statusCode()).isEqualTo(503);
        STUB.records = SharingRuntimeStub.complete();
        assertThat(post(owner("/api/chat"), chat("private-owner:small", 128), null).statusCode()).isEqualTo(200);
        assertThat(post(owner("/api/sharing/start"), Map.of("model", "fixture-shared:small", "hostLabel", "Fixture host"), null).statusCode()).isEqualTo(200);
        assertThat(get(guest + "/guest/v1/session", token).statusCode()).isEqualTo(200);
    }

    @Test void modelDisappearanceIsUnavailableWithoutSwitchingOrStartingInference() throws Exception {
        STUB.available = false;
        var session = get(guest + "/guest/v1/session", token);
        assertThat(object(session)).containsEntry("model", "fixture-shared:small").containsEntry("available", false);
        assertThat(post(guest + "/guest/v1/chat", chat("fixture-shared:small", 128), token).statusCode()).isEqualTo(503);
        assertThat(STUB.chats.get()).isZero();
    }

    @Test void sequentialGuestRequestsHaveABoundedRate() throws Exception {
        for (int i = 0; i < SharingService.REQUESTS_PER_MINUTE; i++)
            assertThat(post(guest + "/guest/v1/chat", chat("fixture-shared:small", 128), token).statusCode()).isEqualTo(200);
        var limited = post(guest + "/guest/v1/chat", chat("fixture-shared:small", 128), token);
        assertThat(limited.statusCode()).isEqualTo(429);
        assertThat(Integer.parseInt(limited.headers().firstValue("Retry-After").orElseThrow())).isBetween(1, 60);
        assertThat(STUB.chats.get()).isEqualTo(SharingService.REQUESTS_PER_MINUTE);
    }

    @Test void ownerMutationsStaySameOriginOnlyAndGuestCallsCannotReachThem() throws Exception {
        for (String path : List.of("/api/sharing/start", "/api/sharing/stop", "/api/sharing/grants", "/api/sharing/grants/" + grantId + "/revoke")) {
            var request = HttpRequest.newBuilder(URI.create(owner(path))).header("Content-Type", "application/json")
                    .header("Origin", "https://untrusted.example").POST(HttpRequest.BodyPublishers.ofString("{}")).build();
            assertThat(client.send(request, HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(403);
            assertThat(post(guest + path, Map.of(), token).statusCode()).isEqualTo(404);
        }
    }

    private String owner(String path) { return "http://127.0.0.1:" + port + path; }
    private static Map<String, Object> chat(String model, int tokens) {
        return Map.of("model", model, "messages", List.of(Map.of("role", "user", "content", "Fixture prompt")), "temperature", 0.7, "maxTokens", tokens);
    }
    private HttpRequest.Builder request(String uri, String token) {
        var result = HttpRequest.newBuilder(URI.create(uri)).timeout(Duration.ofSeconds(15));
        if (token != null) result.header("Authorization", "Bearer " + token);
        return result;
    }
    private HttpResponse<String> get(String uri, String token) throws Exception {
        return client.send(request(uri, token).GET().build(), HttpResponse.BodyHandlers.ofString());
    }
    private HttpResponse<String> post(String uri, Object body, String token) throws Exception {
        return rawPost(uri, json.writeValueAsString(body), token, "application/json");
    }
    private HttpResponse<String> rawPost(String uri, String body, String token, String type) throws Exception {
        return client.send(request(uri, token).header("Content-Type", type).POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
    }
    private HttpResponse<InputStream> stream(String uri, String token, String model) throws Exception {
        return client.send(request(uri, token).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(chat(model, 128)))).build(), HttpResponse.BodyHandlers.ofInputStream());
    }
    @SuppressWarnings("unchecked") private Map<String, Object> object(HttpResponse<String> response) { return json.readValue(response.body(), Map.class); }
}
