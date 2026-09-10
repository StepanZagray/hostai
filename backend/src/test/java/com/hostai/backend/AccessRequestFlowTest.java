package com.hostai.backend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import jakarta.validation.Validation;
import jakarta.validation.ValidatorFactory;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.HttpStatus;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Scheduler;
import reactor.core.scheduler.Schedulers;
import reactor.netty.http.client.HttpClient;
import reactor.netty.resources.LoopResources;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Real private guest HTTP + durable store; tunnel observations are explicitly synthetic. */
class AccessRequestFlowTest {
    static final URI PUBLIC = URI.create("https://fixture-only.trycloudflare.com");
    static final String MODEL = "fixture-shared:small";
    static final Duration WAIT = Duration.ofSeconds(5);
    static final JsonMapper JSON = JsonMapper.builder().build();
    @TempDir Path temporary;
    SharingRuntimeStub runtime;
    SharingService sharing;
    InternetSharing internet;
    PublicIngress ingress;
    GuestServer server;
    Scheduler scheduler;
    LoopResources loops;
    ValidatorFactory validators;
    GuestSocketTest.Assets assets;
    GuestSocketTest.TestClock clock = new GuestSocketTest.TestClock();
    long attempt = 1;

    @BeforeEach void prepare() throws Exception {
        assets = new GuestSocketTest.Assets(temporary);
        runtime = new SharingRuntimeStub();
        scheduler = Schedulers.newBoundedElastic(2, 100, "request-flow-test");
        loops = LoopResources.create("request-flow-http", 1, true);
        validators = Validation.buildDefaultValidatorFactory();
        var gateway = new OllamaGateway(new BackendConfiguration().ollamaClient(LocalOllamaEndpoint.parse(runtime.origin())),
                scheduler, WAIT, Duration.ofSeconds(30), Duration.ofSeconds(60));
        internet = mock(InternetSharing.class);
        observe("live");
        sharing = new SharingService(gateway, new ChatService(new InferenceRegistry(), gateway), validators.getValidator(), JSON,
                scheduler, temporary.resolve("access"), 0, clock, internet);
        sharing.start(MODEL, "Fixture host").block(WAIT);
        ingress = new PublicIngress(); ingress.announced(PUBLIC); ingress.verified();
        server = GuestServer.start(sharing, JSON, scheduler, 0, ingress);
        runtime.metadata.set(0); runtime.chats.set(0);
    }

    void observe(String state) {
        var status = new InternetSharing.Status(state, "cloudflare-quick", true,
                state.equals("live") ? PUBLIC.toString() : null, Instant.now(), null);
        when(internet.status()).thenReturn(status);
        when(internet.observation()).thenReturn(new InternetSharing.Observation(status, attempt, attempt));
        if (state.equals("live")) when(internet.publicOrigin()).thenReturn(PUBLIC);
        else when(internet.publicOrigin()).thenThrow(PublicIngress.unavailable());
    }

    @AfterEach void clean() throws Exception {
        if (server != null) server.close();
        if (sharing != null) sharing.close();
        if (ingress != null) ingress.close();
        if (runtime != null) runtime.close();
        if (validators != null) validators.close();
        if (scheduler != null) scheduler.dispose();
        if (loops != null) loops.disposeLater().block(WAIT);
        if (assets != null) assets.close();
    }

    @Test void optInApprovalAndLostResponseRecoveryNeverDiscloseSecretsOrStartInference() throws Exception {
        assertThat(http("GET", "/guest/v1/hello", null, null, Map.of()).json().get("requestsAccepted").booleanValue()).isFalse();
        assertThat(sharing.status().requests().enabled()).isFalse();
        var local = httpAt(sharing.status().guestUrl(), "GET", "/guest/v1/hello", null, null, Map.of(), false);
        assertThat(local.status()).isEqualTo(404);
        var credential = credential();
        var intake = sharing.startRequests().requests().intakeId().toString();
        Map<String, String> body = body(intake, credential);
        var pending = http("POST", "/guest/v1/requests", credential.bearer(), body, Map.of());
        assertThat(pending.status()).isEqualTo(200);
        assertThat(pending.json().get("state").stringValue()).isEqualTo("pending");
        assertThat(sharing.status().grants()).isEmpty();
        assertThat(http("POST", "/guest/v1/requests", credential.bearer(), body, Map.of()).json()).isEqualTo(pending.json());
        assertThat(http("POST", "/guest/v1/requests", credential.bearer(), body(intake, credential()), Map.of()).status()).isEqualTo(409);
        assertThat(http("GET", "/guest/v1/session", credential.bearer(), null, Map.of()).status()).isEqualTo(401);
        UUID id = UUID.fromString(pending.json().get("id").stringValue());
        String code = pending.json().get("code").stringValue();
        var approved = sharing.approveRequest(id, code, 1);
        assertThat(approved.grants()).singleElement().satisfies(grant -> assertThat(grant.label()).isEqualTo("Request · Visitor · " + code));
        assertThat(sharing.approveRequest(id, code, 168).grants()).isEqualTo(approved.grants());
        var recovered = http("POST", "/guest/v1/requests", credential.bearer(), body, Map.of());
        assertThat(recovered.json().get("state").stringValue()).isEqualTo("approved");
        String token = credential.token(recovered.json().get("grantId").stringValue());
        assertThat(sharing.authenticate(token, ingress.permit()).channel()).isEqualTo("internet");
        assertThatThrownBy(() -> sharing.authenticate(token)).isInstanceOf(GatewayException.class);
        assertThat(runtime.metadata.get()).isZero(); assertThat(runtime.chats.get()).isZero();
        assertThat(pending.body() + recovered.body() + JSON.writeValueAsString(approved)
                + Files.readString(temporary.resolve("access/grants.json"))).doesNotContain(credential.bearer(), credential.secret(), token);
        var connected = http("GET", "/guest/v1/session", token, null, Map.of());
        assertThat(connected.status()).isEqualTo(200);
        assertThat(runtime.chats.get()).isZero();
        assertThat(http("POST", "/guest/v1/requests/self/cancel", credential.bearer(), Map.of(), Map.of()).json().get("state").stringValue()).isEqualTo("cancelled");
        assertThat(sharing.status().grants().getFirst().revokedAt()).isNotNull();
        assertThat(http("GET", "/guest/v1/session", token, null, Map.of()).status()).isEqualTo(401);
    }

    @Test void stoppingIntakePreservesApprovedKeysButNewAttemptNeedsNewOptIn() {
        var credential = credential();
        var row = submit(credential);
        var status = sharing.approveRequest(row.id(), row.code(), 1);
        String token = credential.token(status.grants().getFirst().id().toString());
        sharing.stopRequests();
        assertThat(sharing.status().requests().enabled()).isFalse();
        assertThat(sharing.authenticate(token, ingress.permit())).isNotNull();
        assertThatThrownBy(() -> sharing.pollRequest(ingress.permit(), credential.bearer())).isInstanceOf(GatewayException.class);
        sharing.startRequests();
        attempt++; observe("live");
        assertThat(sharing.status().requests().enabled()).isFalse();
        assertThat(sharing.requestHello(ingress.permit()).requestsAccepted()).isFalse();
    }

    @Test void sameAttemptInterruptionRetainsQueueButRejectsStalePermitUntilRecovery() {
        var credential = credential(); var row = submit(credential); var permit = ingress.permit();
        ingress.interrupted(); observe("interrupted");
        assertThat(sharing.status().requests().enabled()).isTrue();
        assertThat(sharing.status().requests().available()).isFalse();
        assertThatThrownBy(() -> sharing.approveRequest(row.id(), row.code(), 1)).isInstanceOf(GatewayException.class);
        assertThatThrownBy(() -> sharing.pollRequest(permit, credential.bearer())).isInstanceOf(GatewayException.class);
        observeLiveAgain();
        assertThat(sharing.approveRequest(row.id(), row.code(), 1).grants()).hasSize(1);
        assertThatThrownBy(() -> sharing.pollRequest(permit, credential.bearer())).isInstanceOf(GatewayException.class);
    }

    void observeLiveAgain() {
        // Mockito's when() would call the currently throwing stub; reset that method first.
        org.mockito.Mockito.doReturn(PUBLIC).when(internet).publicOrigin();
        observe("live"); ingress.verified();
    }

    @Test void cancelRacingApprovalNeverLeavesAnActivePermission() throws Exception {
        var credential = credential(); var row = submit(credential);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var approval = CompletableFuture.runAsync(() -> sharing.approveRequest(row.id(), row.code(), 1), executor);
            var cancel = CompletableFuture.runAsync(() -> sharing.cancelRequest(ingress.permit(), credential.bearer()), executor);
            CompletableFuture.allOf(approval, cancel).get(5, java.util.concurrent.TimeUnit.SECONDS);
        }
        assertThat(sharing.status().grants()).allSatisfy(grant -> assertThat(grant.revokedAt()).isNotNull());
        assertThat(sharing.status().requests().items().getFirst().state()).isEqualTo("cancelled");
    }

    @Test void ownerLimitsRefuseCleanlyAndDoNotPoisonOrAccidentallyApprove() {
        var credential = credential(); var row = submit(credential);
        for (int i = 0; i < 20; i++) sharing.create("Request · fixture " + i, 1, "internet");
        assertThat(sharing.status().requests().remainingRequestSlots()).isZero();
        assertThatThrownBy(() -> sharing.approveRequest(row.id(), row.code(), 1)).isInstanceOfSatisfying(GatewayException.class,
                error -> assertThat(error.status()).isEqualTo(HttpStatus.CONFLICT));
        assertThat(sharing.status().requests().items().getFirst().state()).isEqualTo("pending");
        assertThat(sharing.status().state()).isEqualTo("local");
        sharing.revoke(sharing.status().grants().getFirst().id());
        assertThat(sharing.approveRequest(row.id(), row.code(), 1).grants()).hasSize(21);
        assertThat(sharing.status().requests().remainingGrantSlots()).isEqualTo(79);
    }

    @Test void tunnelReplacementDuringApprovalRollsBackTheCommittedKey() {
        var credential = credential(); var row = submit(credential);
        var current = internet.observation();
        when(internet.observation()).thenReturn(current,
                new InternetSharing.Observation(current.status(), current.attempt() + 1, current.sequence() + 1));
        assertThatThrownBy(() -> sharing.approveRequest(row.id(), row.code(), 1)).isInstanceOf(GatewayException.class);
        var status = sharing.status();
        assertThat(status.state()).isEqualTo("local");
        assertThat(status.requests().enabled()).isFalse();
        assertThat(status.grants()).singleElement().satisfies(grant -> assertThat(grant.revokedAt()).isNotNull());
    }

    @Test void cancellingApprovedKeyWithStorageFailureNeverReportsSuccess() throws Exception {
        var credential = credential(); var row = submit(credential);
        sharing.approveRequest(row.id(), row.code(), 1);
        Path file = temporary.resolve("access/grants.json"); Files.delete(file); Files.createDirectory(file);
        assertThatThrownBy(() -> sharing.cancelRequest(ingress.permit(), credential.bearer())).isInstanceOf(GatewayException.class);
        assertThat(sharing.status().state()).isEqualTo("unavailable");
        assertThat(sharing.status().requests().enabled()).isFalse();
    }

    @Test void durableStorageLimitCountsExpiredAndRevokedKeysAndKeepsPendingRequest() {
        var credential = credential(); var row = submit(credential);
        for (int i = 0; i < 100; i++) sharing.create("Manual fixture " + i, 1, "local");
        sharing.revoke(sharing.status().grants().getFirst().id());
        assertThat(sharing.status().requests().remainingGrantSlots()).isZero();
        assertThat(sharing.requestHello(ingress.permit()).requestsAccepted()).isFalse();
        assertThatThrownBy(() -> sharing.approveRequest(row.id(), row.code(), 1)).isInstanceOfSatisfying(GatewayException.class,
                error -> assertThat(error.status()).isEqualTo(HttpStatus.CONFLICT));
        assertThat(sharing.status().requests().items().getFirst().state()).isEqualTo("pending");
        assertThat(sharing.status().state()).isEqualTo("local");
    }

    @Test void acceptedHostNamesRemainUsableForRequestIntake() {
        for (String label : List.of("Host 💻", "Host\u200d", "Host\u3000")) {
            sharing.stop();
            sharing.start(MODEL, label).block(WAIT);
            assertThat(sharing.startRequests().requests().enabled()).isTrue();
            assertThat(sharing.requestHello(ingress.permit()).hostLabel()).isEqualTo(label);
        }
    }

    @Test void staleOwnerRejectionExplainsThatApprovedPermissionNeedsRevocation() {
        var row = submit(credential());
        var approved = sharing.approveRequest(row.id(), row.code(), 1);
        assertThatThrownBy(() -> sharing.rejectRequest(row.id(), row.code())).isInstanceOfSatisfying(GatewayException.class,
                error -> assertThat(error.status()).isEqualTo(HttpStatus.CONFLICT));
        assertThat(sharing.status().grants()).isEqualTo(approved.grants());
    }

    @Test void failedApprovalPersistenceStopsSharingAndCannotBeRetried() throws Exception {
        var credential = credential(); var row = submit(credential);
        Path file = temporary.resolve("access/grants.json"); Files.delete(file); Files.createDirectory(file);
        assertThatThrownBy(() -> sharing.approveRequest(row.id(), row.code(), 1)).isInstanceOf(GatewayException.class);
        assertThat(sharing.status().state()).isEqualTo("unavailable");
        assertThat(sharing.status().requests().enabled()).isFalse();
        assertThatThrownBy(() -> sharing.approveRequest(row.id(), row.code(), 1)).isInstanceOf(GatewayException.class);
    }

    @Test void newRoutesRejectCrossOriginQueriesOversizedAndAmbiguousBodiesBeforeAnyGrant() {
        var credential = credential(); var intake = sharing.startRequests().requests().intakeId().toString();
        for (var headers : List.of(Map.of("Origin", "https://evil.test"), Map.of("Sec-Fetch-Site", "cross-site"),
                Map.of("Origin", PUBLIC + "/"), Map.of("Sec-Fetch-Site", "same-site"))) {
            assertThat(http("POST", "/guest/v1/requests", credential.bearer(), body(intake, credential), headers).status()).isEqualTo(403);
        }
        assertThat(http("GET", "/guest/v1/hello?access=x", null, null, Map.of()).status()).isEqualTo(403);
        assertThat(http("POST", "/guest/v1/requests", credential.bearer(), " ".repeat(2049), Map.of()).status()).isEqualTo(413);
        for (String raw : List.of("{}{}", "null", "{\"name\":\"A\",\"name\":\"B\"}", "{\"extra\":1}"))
            assertThat(http("POST", "/guest/v1/requests", credential.bearer(), raw, Map.of()).status()).isEqualTo(400);
        assertThat(http("POST", "/guest/v1/requests", "wrong", Map.of(), Map.of()).status()).isEqualTo(401);
        assertThat(sharing.status().grants()).isEmpty();
        assertThat(sharing.status().requests().items()).isEmpty();
        assertThat(runtime.metadata.get()).isZero(); assertThat(runtime.chats.get()).isZero();
    }

    AccessRequestInbox.GuestView submit(Credential credential) {
        var intake = sharing.startRequests().requests().intakeId().toString();
        return sharing.submitRequest(ingress.permit(), credential.bearer(), intake, "Visitor", MODEL, credential.commitment());
    }
    static Map<String, String> body(String intake, Credential credential) {
        return Map.of("intakeId", intake, "name", "Visitor", "model", MODEL, "accessCommitment", credential.commitment());
    }
    static Credential credential() {
        try {
            byte[] request = new byte[32], access = new byte[32]; var random = new SecureRandom();
            random.nextBytes(request); random.nextBytes(access);
            return new Credential("hgq1." + Base64.getUrlEncoder().withoutPadding().encodeToString(request),
                    Base64.getUrlEncoder().withoutPadding().encodeToString(access),
                    HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(access)));
        } catch (Exception error) { throw new AssertionError(error); }
    }
    record Credential(String bearer, String secret, String commitment) {
        String token(String id) { return "hga1." + id + "." + secret; }
        @Override public String toString() { return "Credential[redacted]"; }
    }
    record Reply(int status, String body) { JsonNode json() { return JSON.readTree(body); } }
    Reply http(String method, String path, String bearer, Object body, Map<String, String> headers) {
        return httpAt(server.origin(), method, path, bearer, body, headers, true);
    }
    Reply httpAt(String origin, String method, String path, String bearer, Object body, Map<String, String> headers, boolean tagged) {
        var client = HttpClient.newConnection().runOn(loops).responseTimeout(WAIT).headers(values -> {
            if (tagged) { values.set("Host", PUBLIC.getHost()); values.set(PublicIngress.HEADER, ingress.secret()); }
            if (bearer != null) values.set("Authorization", "Bearer " + bearer);
            if (body != null) values.set("Content-Type", "application/json");
            headers.forEach(values::set);
        });
        if (method.equals("GET")) return client.get().uri(origin + path)
                .responseSingle((response, bytes) -> bytes.asString().defaultIfEmpty("").map(text -> new Reply(response.status().code(), text))).block(WAIT);
        return client.post().uri(origin + path).send(reactor.netty.ByteBufFlux.fromString(Mono.just(body instanceof String text ? text : JSON.writeValueAsString(body))))
                .responseSingle((response, bytes) -> bytes.asString().defaultIfEmpty("").map(text -> new Reply(response.status().code(), text))).block(WAIT);
    }
}
