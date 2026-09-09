package com.hostai.backend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import jakarta.validation.Validation;
import jakarta.validation.ValidatorFactory;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.client.reactive.ReactorClientHttpConnector;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Scheduler;
import reactor.core.scheduler.Schedulers;
import reactor.netty.http.client.HttpClient;
import tools.jackson.databind.json.JsonMapper;

class InternetSharingTest {
    static final URI PUBLIC = URI.create("https://fixture-only.trycloudflare.com");
    static final Duration WAIT = Duration.ofSeconds(6);
    static final JsonMapper JSON = JsonMapper.builder().build();
    @TempDir Path temporary;
    SharingRuntimeStub runtime;
    Scheduler scheduler;
    ValidatorFactory validators;
    InferenceRegistry registry;
    OllamaGateway gateway;
    SharingService sharing;
    InternetSharing internet;
    AtomicBoolean reachable = new AtomicBoolean(true);
    AtomicReference<InternetSharing.Probe> verifier = new AtomicReference<>((origin, gate) -> reachable.get());
    AtomicReference<PublicIngress> ingress = new AtomicReference<>();
    AtomicReference<GuestServer> listener = new AtomicReference<>();
    Path executable;
    GuestSocketTest.Assets assets;

    @BeforeEach void prepare() throws Exception {
        assets = new GuestSocketTest.Assets(temporary);
        runtime = new SharingRuntimeStub();
        scheduler = Schedulers.newBoundedElastic(2, 100, "internet-sharing-test");
        validators = Validation.buildDefaultValidatorFactory();
        registry = new InferenceRegistry();
        var config = new BackendConfiguration();
        gateway = new OllamaGateway(config.ollamaClient(LocalOllamaEndpoint.parse(runtime.origin())), scheduler,
                WAIT, Duration.ofSeconds(30), Duration.ofSeconds(60));
        executable = temporary.resolve("fake-cloudflared");
        Files.writeString(executable, "#!/bin/sh\nprintf '%s\\n' 'https://fixture-only.trycloudflare.com'\nexec /bin/sleep 600\n");
        Files.setPosixFilePermissions(executable, PosixFilePermissions.fromString("rwx------"));
        internet = new InternetSharing(executable.toString(), (origin, gate) -> {
            ingress.set(gate); return verifier.get().verify(origin, gate);
        }, Duration.ofMillis(500), Duration.ofMillis(100));
        sharing = new SharingService(gateway, new ChatService(registry, gateway), validators.getValidator(), JSON,
                scheduler, temporary.resolve("access"), 0, Clock.systemUTC(), internet);
        assertThat(sharing.start("fixture-shared:small", "Fixture host").block(WAIT).state()).isEqualTo("local");
    }

    private void start() {
        internet.start(gate -> {
            var server = GuestServer.start(sharing, JSON, scheduler, 0, gate);
            listener.set(server); return server;
        });
        await().atMost(WAIT).untilAsserted(() -> assertThat(internet.status().state()).isEqualTo("live"));
    }

    @Test void localKeysNeverGainInternetAccessAndInternetKeysNeverWorkLocally() {
        var local = sharing.create("Local visitor", 1);
        assertThatThrownBy(() -> sharing.create("Remote visitor", 1, "internet")).isInstanceOf(GatewayException.class);
        start();
        var remote = sharing.create("Remote visitor", 1, "internet");
        assertThat(remote.inviteUrl()).startsWith(PUBLIC + "/#access=");
        assertThat(local.grant().channel()).isEqualTo("local");
        assertThat(remote.grant().channel()).isEqualTo("internet");
        var permit = ingress.get().permit();
        assertThatThrownBy(() -> sharing.authenticate(local.token(), permit)).isInstanceOfSatisfying(GatewayException.class,
                error -> assertThat(error.status()).isEqualTo(HttpStatus.UNAUTHORIZED));
        assertThatThrownBy(() -> sharing.authenticate(remote.token())).isInstanceOfSatisfying(GatewayException.class,
                error -> assertThat(error.status()).isEqualTo(HttpStatus.UNAUTHORIZED));
        assertThat(sharing.session(remote.token(), permit).block(WAIT).scope()).isEqualTo("temporary-internet");
        assertThat(runtime.chats.get()).isZero();
    }

    @Test void lossOfReachabilityEndsPublicGenerationAndRecoveryNeverRevivesOldPermit() throws Exception {
        start();
        var remote = sharing.create("Remote visitor", 1, "internet");
        var oldPermit = ingress.get().permit();
        runtime.records = SharingRuntimeStub.hold();
        var chunks = new java.util.concurrent.CopyOnWriteArrayList<Api.ChatChunk>();
        var future = sharing.chat(remote.token(), request(), oldPermit).doOnNext(chunks::add).collectList().toFuture();
        try {
            await().atMost(WAIT).untilAsserted(() -> assertThat(chunks).hasSize(1));
            reachable.set(false);
            await().atMost(WAIT).untilAsserted(() -> {
                assertThat(internet.status().state()).isEqualTo("interrupted");
                assertThat(internet.status().publicUrl()).isNull();
                assertThat(registry.counters().activeRequests()).isZero();
                assertThat(runtime.connections.get()).isZero();
            });
            assertThat(future.get(2, java.util.concurrent.TimeUnit.SECONDS).getLast().error()).contains("Client access ended");
            reachable.set(true);
            await().atMost(WAIT).untilAsserted(() -> assertThat(internet.status().state()).isEqualTo("live"));
            assertThatThrownBy(oldPermit::requireActive).isInstanceOf(GatewayException.class);
            ingress.get().permit().requireActive();
        } finally { future.cancel(true); }
    }

    @Test void stoppingInternetKeepsLocalPublicationAndLocalCredentialsUsable() {
        var local = sharing.create("Local visitor", 1);
        start();
        var previous = ingress.get().permit();
        sharing.stopInternet();
        await().atMost(WAIT).untilAsserted(() -> assertThat(internet.status().state()).isEqualTo("off"));
        assertThat(sharing.status().state()).isEqualTo("local");
        assertThat(sharing.authenticate(local.token())).isEqualTo(local.grant());
        assertThatThrownBy(previous::requireActive).isInstanceOf(GatewayException.class);
        assertThat(internet.status().publicUrl()).isNull();
    }

    @Test void failedStartupIsReapedAndNeverAdvertisesPublicUrl() {
        reachable.set(false);
        internet.start(gate -> { var server = GuestServer.start(sharing, JSON, scheduler, 0, gate); listener.set(server); return server; });
        await().atMost(WAIT).untilAsserted(() -> assertThat(internet.status().state()).isEqualTo("failed"));
        assertThat(internet.status().publicUrl()).isNull();
        assertThat(internet.status().error()).contains("could not be verified");
        assertThat(sharing.status().state()).isEqualTo("local");
    }

    @Test void restartRetainsInternetKeyPermissionUntilExplicitRevocation() {
        start();
        var remote = sharing.create("Remote visitor", 1, "internet");
        var previous = ingress.get().permit();
        sharing.stopInternet();
        await().atMost(WAIT).untilAsserted(() -> assertThat(internet.status().state()).isEqualTo("off"));
        start();
        assertThatThrownBy(previous::requireActive).isInstanceOf(GatewayException.class);
        assertThat(sharing.authenticate(remote.token(), ingress.get().permit())).isEqualTo(remote.grant());
        sharing.revoke(remote.grant().id());
        assertThatThrownBy(() -> sharing.authenticate(remote.token(), ingress.get().permit())).isInstanceOf(GatewayException.class);
    }

    @Test void aTunnelCloseFailureStillReleasesTheLocalListenerAndAccessStore() throws Exception {
        sharing.close();
        var failingClose = org.mockito.Mockito.mock(InternetSharing.class);
        org.mockito.Mockito.doThrow(new IllegalStateException("Fixture close failure")).when(failingClose).close();
        sharing = new SharingService(gateway, new ChatService(registry, gateway), validators.getValidator(), JSON,
                scheduler, temporary.resolve("access"), 0, Clock.systemUTC(), failingClose);
        var status = sharing.start("fixture-shared:small", "Fixture host").block(WAIT);
        assertThatThrownBy(sharing::close).hasMessage("Fixture close failure");
        try (var socket = new java.net.ServerSocket()) {
            socket.bind(new java.net.InetSocketAddress("127.0.0.1", URI.create(status.guestUrl()).getPort()));
        }
        try (var reopened = AccessGrantStore.open(temporary.resolve("access"), Clock.systemUTC())) {
            assertThat(reopened.list()).isEmpty();
        }
    }

    @Test void stopDuringVerificationInterruptsTheCheckAndNeverPublishesAnInvite() throws Exception {
        var entered = new java.util.concurrent.CountDownLatch(1);
        var interrupted = new AtomicBoolean();
        verifier.set((origin, gate) -> {
            entered.countDown();
            try { Thread.sleep(30_000); }
            catch (InterruptedException error) { interrupted.set(true); Thread.currentThread().interrupt(); }
            return true; // Even a late successful probe cannot undo Stop.
        });
        sharing.startInternet();
        assertThat(entered.await(3, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
        long before = System.nanoTime();
        sharing.stopInternet();
        assertThat(Duration.ofNanos(System.nanoTime() - before)).isLessThan(Duration.ofSeconds(1));
        await().atMost(WAIT).untilAsserted(() -> assertThat(internet.status().state()).isEqualTo("off"));
        assertThat(interrupted).isTrue();
        assertThat(internet.status().publicUrl()).isNull();
        assertThatThrownBy(() -> sharing.create("Visitor", 1, "internet")).isInstanceOf(GatewayException.class);
        assertThat(sharing.status().state()).isEqualTo("local");
    }

    @Test void stopDuringListenerBindingWaitsForOwnershipBeforeClosingThePort() throws Exception {
        var bound = new java.util.concurrent.CountDownLatch(1);
        var release = new java.util.concurrent.CountDownLatch(1);
        var interrupted = new AtomicBoolean();
        var owned = new AtomicReference<GuestServer>();
        try {
            internet.start(gate -> {
                var server = GuestServer.start(sharing, JSON, scheduler, 0, gate);
                owned.set(server); bound.countDown();
                try { release.await(); }
                catch (InterruptedException error) { interrupted.set(true); Thread.currentThread().interrupt(); }
                return server;
            });
            assertThat(bound.await(5, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            assertThat(internet.stop().state()).isEqualTo("stopping");
            assertThat(interrupted).isFalse();
            release.countDown();
            await().atMost(WAIT).untilAsserted(() -> assertThat(internet.status().state()).isEqualTo("off"));
            assertThat(interrupted).isFalse();
            try (var socket = new java.net.ServerSocket()) {
                socket.bind(new java.net.InetSocketAddress("127.0.0.1", URI.create(owned.get().origin()).getPort()));
            }
        } finally {
            release.countDown();
            if (owned.get() != null) owned.get().close();
        }
    }

    @Test void stoppingAllAccessEndsPublicGenerationAndRetainsNoPublicPermission() {
        start();
        var remote = sharing.create("Remote visitor", 1, "internet");
        var previous = ingress.get().permit();
        runtime.records = SharingRuntimeStub.hold();
        var chunks = new java.util.concurrent.CopyOnWriteArrayList<Api.ChatChunk>();
        var generation = sharing.chat(remote.token(), request(), previous).doOnNext(chunks::add).subscribe();
        try {
            await().atMost(WAIT).untilAsserted(() -> assertThat(chunks).hasSize(1));
            sharing.stop();
            await().atMost(WAIT).untilAsserted(() -> {
                assertThat(internet.status().state()).isEqualTo("off");
                assertThat(runtime.connections.get()).isZero();
                assertThat(registry.counters().activeRequests()).isZero();
            });
            assertThat(sharing.status().state()).isEqualTo("stopped");
            assertThatThrownBy(previous::requireActive).isInstanceOf(GatewayException.class);
            assertThatThrownBy(sharing::startInternet).isInstanceOf(GatewayException.class);
        } finally { generation.dispose(); }
    }

    @Test void unexpectedProcessExitFailsClosedAndDoesNotAutomaticallyRestart() throws Exception {
        Path starts = temporary.resolve("starts");
        Files.writeString(executable, "#!/bin/sh\nprintf 'start\\n' >> '" + starts + "'\nprintf '%s\\n' 'https://fixture-only.trycloudflare.com'\nexit 17\n");
        sharing.startInternet();
        await().atMost(WAIT).untilAsserted(() -> assertThat(internet.status().state()).isEqualTo("failed"));
        assertThat(internet.status().publicUrl()).isNull();
        assertThat(Files.readAllLines(starts)).containsExactly("start");
        assertThat(sharing.status().state()).isEqualTo("local");
        assertThatThrownBy(() -> sharing.create("Visitor", 1, "internet")).isInstanceOf(GatewayException.class);
        // A new attempt only follows an explicit owner request.
        sharing.startInternet();
        await().atMost(WAIT).untilAsserted(() -> assertThat(internet.status().state()).isEqualTo("failed"));
        assertThat(Files.readAllLines(starts)).containsExactly("start", "start");
    }

    @Test void publicListenerRequiresItsTagAndHostAndHasNoOwnerRoutes() {
        start();
        var remote = sharing.create("Remote visitor", 1, "internet");
        var publicClient = client(listener.get().origin());
        assertThat(status(publicClient, "/guest/v1/session", PUBLIC.getHost(), null, remote.token())).isEqualTo(403);
        assertThat(status(publicClient, "/guest/v1/session", "127.0.0.1", ingress.get().secret(), remote.token())).isEqualTo(403);
        assertThat(status(publicClient, "/guest/v1/session", PUBLIC.getHost(), ingress.get().secret(), remote.token())).isEqualTo(200);
        assertThat(status(publicClient, "/api/sharing", PUBLIC.getHost(), ingress.get().secret(), remote.token())).isEqualTo(404);
        assertThat(status(publicClient, "/guest/v1/reachability/unknown", PUBLIC.getHost(), ingress.get().secret(), null)).isEqualTo(404);
        assertThat(status(client(sharing.status().guestUrl()), "/guest/v1/session", "127.0.0.1", ingress.get().secret(), remote.token())).isEqualTo(403);
        assertThat(status(publicClient, "/guest/v1/session", "attacker.example", ingress.get().secret(), remote.token())).isEqualTo(403);
    }

    @Test void probeChecksAttemptProofAndIncrementalDeliveryThroughRealWss() throws Exception {
        start();
        var gate = ingress.get();
        try (var fixture = new TlsFixture(temporary, gate, listener.get().origin(), PUBLIC.getHost())) {
            var probe = new TunnelReachability(fixture.client());
            assertThat(probe.verify(PUBLIC, gate)).isTrue();
            assertThat(fixture.requests.get()).isEqualTo(1);
            assertThat(fixture.wrongRequests.get()).isZero();
            assertThat(status(client(listener.get().origin()), gate.probePath(), PUBLIC.getHost(), gate.secret(), null)).isEqualTo(400);
            gate.close();
            assertThat(probe.verify(PUBLIC, gate)).isFalse();
            assertThat(fixture.requests.get()).isEqualTo(1);
        }
        assertThat(runtime.chats.get()).isZero();
    }

    @Test void bufferedMalformedMismatchedOutOfOrderAndIncompleteProofsAreRejectedOverWss() throws Exception {
        var gate = new PublicIngress(); gate.announced(PUBLIC);
        try (var fixture = new TlsFixture(temporary, gate, null, PUBLIC.getHost())) {
            String first = JSON.writeValueAsString(new PublicIngress.ProbeChunk(0, gate.proof()));
            String last = JSON.writeValueAsString(new PublicIngress.ProbeChunk(1, gate.proof()));
            var probe = new TunnelReachability(fixture.client());
            fixture.records = reactor.core.publisher.Flux.just(first, last);
            assertThat(probe.verify(PUBLIC, gate)).isFalse();
            assertThat(probe.failure()).contains("buffered");
            for (var records : List.of(
                    reactor.core.publisher.Flux.just(first + last),
                    reactor.core.publisher.Flux.just("private malformed provider response"),
                    reactor.core.publisher.Flux.just(first, last.replace(gate.proof(), "wrong-proof")),
                    reactor.core.publisher.Flux.just(last, first),
                    reactor.core.publisher.Flux.just(first),
                    reactor.core.publisher.Flux.just("x".repeat(2049)),
                    reactor.core.publisher.Flux.just(first.replace("0", "0.0")),
                    reactor.core.publisher.Flux.just(first.replace("0", "0,\"sequence\":0")))) {
                fixture.records = records;
                assertThat(probe.verify(PUBLIC, gate)).isFalse();
                assertThat(probe.failure()).doesNotContain(gate.proof(), gate.probePath(), "private malformed");
            }
            int attempts = fixture.requests.get();
            for (String origin : List.of("http://127.0.0.1:8080", PUBLIC + "/", PUBLIC + ":443", PUBLIC + "?key=x", "https://attacker.example"))
                assertThat(probe.verify(URI.create(origin), gate)).isFalse();
            assertThat(fixture.requests.get()).isEqualTo(attempts);
        }
        gate.close();
    }

    @Test void closingAttemptCancelsProofBeforeItsSecondFrame() {
        start();
        var gate = ingress.get();
        try (var socket = new GuestSocketTest.Socket(HttpClient.newConnection()
                .headers(h -> h.set(HttpHeaders.HOST, PUBLIC.getHost()).set(PublicIngress.HEADER, gate.secret())
                        .set(HttpHeaders.ORIGIN, PUBLIC.toString()))
                .websocket().uri(listener.get().origin().replace("http:", "ws:") + gate.probePath()).connect().block(WAIT))) {
            socket.records(1);
            gate.close();
            socket.ended();
            assertThat(socket.frames).hasSize(1);
        }
        assertThat(runtime.chats.get()).isZero();
    }

    @Test void failedProbeExplainsBoundaryWithoutEchoingProviderDataOrRetrying() throws Exception {
        var gate = new PublicIngress(); gate.announced(PUBLIC);
        try (var fixture = new TlsFixture(temporary, gate, null, PUBLIC.getHost())) {
            fixture.status = 403;
            var denied = new TunnelReachability(fixture.client());
            assertThat(denied.verify(PUBLIC, gate)).isFalse();
            assertThat(denied.failure()).isEqualTo("The public verification request returned HTTP 403.");
            assertThat(fixture.requests.get()).isEqualTo(1);
            fixture.status = 302;
            assertThat(denied.verify(PUBLIC, gate)).isFalse();
            assertThat(fixture.requests.get()).isEqualTo(2);
            fixture.status = 200;
            fixture.httpBody = JSON.writeValueAsString(new PublicIngress.ProbeChunk(0, gate.proof())) + "\n"
                    + JSON.writeValueAsString(new PublicIngress.ProbeChunk(1, gate.proof())) + "\n";
            assertThat(denied.verify(PUBLIC, gate)).isFalse(); // Even matching HTTP NDJSON cannot verify WSS.
            assertThat(denied.failure()).isEqualTo("The public verification request returned HTTP 200.");
            fixture.status = 0;
            var cancelled = new AtomicBoolean();
            fixture.records = reactor.core.publisher.Flux.<String>never().doOnCancel(() -> cancelled.set(true));
            assertThat(denied.verify(PUBLIC, gate)).isFalse();
            assertThat(denied.failure()).contains("timed out");
            await().atMost(WAIT).untilTrue(cancelled);
            // Same private DNS, but production platform trust must reject this private self-signed certificate.
            var tls = new TunnelReachability(fixture.untrustedClient());
            assertThat(tls.verify(PUBLIC, gate)).isFalse();
            assertThat(tls.failure()).isEqualTo("The public endpoint's HTTPS certificate or TLS connection could not be verified.");
            var dns = new TunnelReachability(HttpClient.newConnection().mapConnect(ignored -> Mono.error(
                    new java.net.UnknownHostException("Synthetic private hostname"))));
            assertThat(dns.verify(PUBLIC, gate)).isFalse();
            assertThat(dns.failure()).isEqualTo("The public hostname could not be resolved. Check DNS and try again.");
        }
        gate.close();
    }

    @Test void trustedCertificateForAnotherHostStillFailsHostnameVerification() throws Exception {
        var gate = new PublicIngress(); gate.announced(PUBLIC);
        try (var fixture = new TlsFixture(temporary, gate, null, "wrong-fixture.example")) {
            var probe = new TunnelReachability(fixture.client());
            assertThat(probe.verify(PUBLIC, gate)).isFalse();
            assertThat(probe.failure()).contains("certificate or TLS");
            assertThat(fixture.requests.get()).isZero();
        }
        gate.close();
    }

    /** A private TLS edge, optionally forwarding the real WebSocket probe to GuestServer. */
    static final class TlsFixture implements AutoCloseable {
        final reactor.netty.resources.LoopResources loops = reactor.netty.resources.LoopResources.create("proof-tls-fixture", 1, true);
        final java.util.Set<reactor.netty.Connection> connections = java.util.concurrent.ConcurrentHashMap.newKeySet();
        final java.util.concurrent.atomic.AtomicInteger requests = new java.util.concurrent.atomic.AtomicInteger();
        final java.util.concurrent.atomic.AtomicInteger wrongRequests = new java.util.concurrent.atomic.AtomicInteger();
        final reactor.netty.DisposableServer server;
        final io.netty.resolver.AddressResolverGroup<java.net.InetSocketAddress> dns;
        final Path certificate;
        volatile reactor.core.publisher.Flux<String> records = reactor.core.publisher.Flux.empty();
        volatile int status;
        volatile String httpBody = "Synthetic private provider response";

        TlsFixture(Path temporary, PublicIngress gate, String upstream, String certificateHost) throws Exception {
            Path directory = Files.createTempDirectory(temporary, "tls-");
            certificate = directory.resolve("cert.pem");
            Path key = directory.resolve("key.pem");
            Process process = new ProcessBuilder("/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
                    "-subj", "/CN=" + certificateHost, "-addext", "subjectAltName=DNS:" + certificateHost,
                    "-keyout", key.toString(), "-out", certificate.toString())
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectError(ProcessBuilder.Redirect.DISCARD).start();
            try { assertThat(process.waitFor(10, java.util.concurrent.TimeUnit.SECONDS)).isTrue(); assertThat(process.exitValue()).isZero(); }
            finally { if (process.isAlive()) process.destroyForcibly(); assertThat(process.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)).isTrue(); }
            Files.setPosixFilePermissions(key, PosixFilePermissions.fromString("rw-------"));
            var context = io.netty.handler.ssl.SslContextBuilder.forServer(certificate.toFile(), key.toFile())
                    .sslProvider(io.netty.handler.ssl.SslProvider.JDK).build();
            server = reactor.netty.http.server.HttpServer.create().host("127.0.0.1").port(0).runOn(loops)
                    .secure(ssl -> ssl.sslContext(context)).doOnConnection(this::track)
                    .handle((request, response) -> {
                        requests.incrementAndGet();
                        if (!request.uri().equals(gate.probePath()) || !PUBLIC.getHost().equals(request.requestHeaders().get(HttpHeaders.HOST)))
                            wrongRequests.incrementAndGet();
                        if (status != 0) return response.status(status).header("Location", "https://attacker.example")
                                .header("Content-Type", "application/x-ndjson").sendString(Mono.just(httpBody));
                        if (upstream == null) return response.sendWebsocket((in, out) -> out.sendString(records).then());
                        return response.sendWebsocket((edgeIn, edgeOut) -> HttpClient.newConnection().runOn(loops).doOnConnected(this::track)
                                .headers(h -> h.set(HttpHeaders.HOST, PUBLIC.getHost()).set(PublicIngress.HEADER, gate.secret())
                        .set(HttpHeaders.ORIGIN, PUBLIC.toString()))
                                .websocket().uri(upstream.replace("http:", "ws:") + gate.probePath())
                                .handle((localIn, localOut) -> edgeOut.sendObject(localIn.receiveFrames()
                                        .takeUntilOther(edgeIn.receiveFrames().then()).map(io.netty.handler.codec.http.websocketx.WebSocketFrame::retain)).then()).then());
                    }).bindNow(WAIT);
            dns = GuestSocketTest.dns(server.port());
        }
        void track(reactor.netty.Connection connection) {
            connections.add(connection);
            connection.onDispose().doFinally(ignored -> connections.remove(connection)).subscribe();
        }
        HttpClient untrustedClient() { return HttpClient.newConnection().runOn(loops).resolver(dns).secure().doOnConnected(this::track); }
        HttpClient client() throws Exception {
            var context = io.netty.handler.ssl.SslContextBuilder.forClient().sslProvider(io.netty.handler.ssl.SslProvider.JDK)
                    .trustManager(certificate.toFile()).build();
            return HttpClient.newConnection().runOn(loops).resolver(dns).secure(ssl -> ssl.sslContext(context)).doOnConnected(this::track);
        }
        @Override public void close() {
            connections.forEach(reactor.netty.Connection::dispose);
            server.disposeNow(WAIT);
            await().atMost(WAIT).untilAsserted(() -> assertThat(connections).isEmpty());
            dns.close(); loops.disposeLater(Duration.ZERO, Duration.ofSeconds(5)).block(WAIT);
        }
    }

    private static WebClient client(String origin) {
        return WebClient.builder().baseUrl(origin).clientConnector(new ReactorClientHttpConnector(HttpClient.newConnection()
                .followRedirect(false).disableRetry(true).responseTimeout(Duration.ofSeconds(4)))).build();
    }
    private static int status(WebClient client, String path, String host, String tag, String token) {
        var request = client.get().uri(path).header(HttpHeaders.HOST, host);
        if (tag != null) request.header(PublicIngress.HEADER, tag);
        if (token != null) request.header(HttpHeaders.AUTHORIZATION, "Bearer " + token);
        return request.exchangeToMono(response -> response.releaseBody().thenReturn(response.statusCode().value())).block(WAIT);
    }
    private static Api.ChatRequest request() {
        return new Api.ChatRequest("fixture-shared:small", List.of(new Api.Message("user", "Fixture prompt")), 0.7, 128);
    }
    @AfterEach void close() throws Exception {
        try {
            if (sharing != null) sharing.close();
            if (internet != null) internet.close();
            if (runtime != null) {
                await().atMost(WAIT).untilAsserted(() -> {
                    assertThat(runtime.connections.get()).isZero();
                    if (registry != null) assertThat(registry.counters().activeRequests()).isZero();
                });
                runtime.close();
            }
            if (scheduler != null) scheduler.dispose();
            if (validators != null) validators.close();
        } finally { if (assets != null) assets.close(); }
    }
}
