package com.hostai.backend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import reactor.core.publisher.Flux;
import reactor.core.publisher.SignalType;

class ModelDownloadLifecycleTest {
    private static final String MODEL = "local-test:tag";
    private static final Duration WAIT = Duration.ofSeconds(3);

    @ParameterizedTest @ValueSource(booleans = {false, true})
    void cancelOrShutdownBeforeSubscriptionCannotLeaveAnOrphan(boolean shutdown) throws Exception {
        try (var stub = new DownloadRuntimeStub(); var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var gateway = stub.gateway(WAIT, Duration.ofSeconds(10));
            CountDownLatch constructing = new CountDownLatch(1);
            CountDownLatch release = new CountDownLatch(1);
            AtomicBoolean disposed = new AtomicBoolean();
            try (var service = new ModelDownloadService(model -> {
                constructing.countDown();
                awaitLatch(release);
                return gateway.pull(model).doFinally(signal -> disposed.set(signal == SignalType.CANCEL));
            })) {
                UUID id = UUID.randomUUID();
                var pending = executor.submit(() -> service.start(id, MODEL));
                try {
                    assertThat(constructing.await(3, TimeUnit.SECONDS)).isTrue();
                    if (shutdown) service.close(); else service.cancel(id);
                    var terminal = service.cancel(id);
                    assertThat(terminal.state()).isEqualTo("cancelled");
                    release.countDown();
                    assertThat(pending.get(3, TimeUnit.SECONDS).job()).isEqualTo(terminal);
                    assertThat(disposed).isTrue();
                    assertThat(service.cancel(id)).isEqualTo(terminal);
                    awaitClosed(stub);
                    if (shutdown) {
                        assertThatThrownBy(() -> service.start(UUID.randomUUID(), MODEL))
                                .isInstanceOf(GatewayException.class).hasMessageContaining("shutting down");
                    } else {
                        stub.records = Flux.just("{\"status\":\"success\"}\n");
                        UUID next = UUID.randomUUID();
                        service.start(next, MODEL);
                        awaitState(service, "completed");
                        awaitClosed(stub);
                    }
                } finally { release.countDown(); }
            }
        }
    }

    @Test void cancellationWhileOnSubscribeIsBeingDeliveredCancelsTheLateSubscription() throws Exception {
        try (var stub = new DownloadRuntimeStub(); var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            CountDownLatch attaching = new CountDownLatch(1);
            CountDownLatch release = new CountDownLatch(1);
            AtomicBoolean disposed = new AtomicBoolean();
            var gateway = stub.gateway(WAIT, Duration.ofSeconds(10));
            try (var service = new ModelDownloadService(model -> gateway.pull(model)
                    .doOnSubscribe(subscription -> { attaching.countDown(); awaitLatch(release); })
                    .doFinally(signal -> disposed.set(signal == SignalType.CANCEL)))) {
                UUID id = UUID.randomUUID();
                var pending = executor.submit(() -> service.start(id, MODEL));
                try {
                    assertThat(attaching.await(3, TimeUnit.SECONDS)).isTrue();
                    var cancelled = service.cancel(id);
                    release.countDown();
                    assertThat(pending.get(3, TimeUnit.SECONDS).job()).isEqualTo(cancelled);
                    assertThat(disposed).isTrue();
                    awaitClosed(stub);
                } finally { release.countDown(); }
            }
        }
    }

    @ParameterizedTest @ValueSource(booleans = {false, true})
    void synchronousTerminalSignalsReleaseTheSlotAndRemainImmutable(boolean success) {
        try (var stub = new DownloadRuntimeStub()) {
            stub.records = Flux.just(success ? "{\"status\":\"success\"}\n" : "{\"error\":\"private runtime detail\"}\n");
            // Warm a replay from the actual loopback HTTP gateway to exercise synchronous
            // terminal delivery; no runtime response is replaced with a mocked exchange.
            var replay = stub.gateway(WAIT, Duration.ofSeconds(10)).pull(MODEL).cache();
            replay.materialize().collectList().block(WAIT);
            awaitClosed(stub);
            try (var service = new ModelDownloadService(ignored -> replay)) {
                for (int index = 0; index < 30; index++) {
                    UUID id = UUID.randomUUID();
                    var started = service.start(id, MODEL);
                    assertThat(started.created()).isTrue();
                    assertThat(started.job().state()).isEqualTo(success ? "completed" : "failed");
                    assertThat(service.cancel(id)).isEqualTo(started.job());
                    assertThat(service.start(id, MODEL).job()).isEqualTo(started.job());
                }
                assertThat(service.downloads()).hasSize(20);
                var beforeClose = service.downloads();
                service.close();
                assertThat(service.downloads()).isEqualTo(beforeClose);
                assertThat(stub.calls.get()).isEqualTo(1);
            }
        }
    }

    @Test void terminalCallbackDoubleCancelAndShutdownRacesHaveOneStableOutcome() throws Exception {
        try (var stub = new DownloadRuntimeStub(); var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            stub.records = Flux.just("{\"status\":\"success\"}\n");
            var replay = stub.gateway(WAIT, Duration.ofSeconds(10)).pull(MODEL).cache();
            replay.blockLast(WAIT);
            awaitClosed(stub);
            for (int index = 0; index < 100; index++) {
                CyclicBarrier race = new CyclicBarrier(3);
                CountDownLatch callbackReady = new CountDownLatch(1);
                try (var service = new ModelDownloadService(ignored -> replay.doOnNext(record -> {
                    callbackReady.countDown();
                    awaitBarrier(race);
                }))) {
                    UUID id = UUID.randomUUID();
                    var starting = executor.submit(() -> service.start(id, MODEL));
                    assertThat(callbackReady.await(3, TimeUnit.SECONDS)).isTrue();
                    var cancelling = executor.submit(() -> { awaitBarrier(race); service.cancel(id); service.cancel(id); });
                    var closing = executor.submit(() -> { awaitBarrier(race); service.close(); });
                    starting.get(3, TimeUnit.SECONDS);
                    cancelling.get(3, TimeUnit.SECONDS);
                    closing.get(3, TimeUnit.SECONDS);
                    var terminal = service.downloads().getFirst();
                    assertThat(terminal.state()).isIn("completed", "cancelled");
                    assertThat(terminal.error()).isNull();
                    assertThat(service.cancel(id)).isEqualTo(terminal);
                    assertThat(service.start(id, MODEL).job()).isEqualTo(terminal);
                }
            }
            assertThat(stub.calls.get()).isEqualTo(1);
        }
    }

    @Test void shutdownDisposesAnActiveHttpExchangeAndRejectsNewWork() {
        try (var stub = new DownloadRuntimeStub(); var service = new ModelDownloadService(stub.gateway(WAIT, Duration.ofSeconds(10)))) {
            UUID id = UUID.randomUUID();
            service.start(id, MODEL);
            await().atMost(WAIT).untilAsserted(() -> assertThat(stub.connections.get()).isEqualTo(1));
            service.close();
            service.close();
            assertThat(service.downloads().getFirst().state()).isEqualTo("cancelled");
            awaitClosed(stub);
            assertThatThrownBy(() -> service.start(UUID.randomUUID(), MODEL)).isInstanceOf(GatewayException.class);
        }
    }

    @ParameterizedTest @ValueSource(booleans = {false, true})
    void idleDeadlineBoundsSilenceBeforeHeadersAndBetweenRecords(boolean beforeHeaders) {
        try (var stub = new DownloadRuntimeStub(); var service = new ModelDownloadService(
                stub.gateway(Duration.ofMillis(500), Duration.ofSeconds(3)))) {
            stub.beforeHeaders = beforeHeaders;
            stub.records = Flux.concat(Flux.just("{\"status\":\"pulling manifest\"}\n"), Flux.never());
            service.start(UUID.randomUUID(), MODEL);
            awaitState(service, "failed");
            assertThat(service.downloads().getFirst().error()).contains("time limit");
            awaitClosed(stub);
            assertThat(stub.calls.get()).isEqualTo(1);
        }
    }

    @Test void overallDeadlineBoundsAContinuouslyActiveRuntime() {
        try (var stub = new DownloadRuntimeStub(); var service = new ModelDownloadService(
                stub.gateway(Duration.ofSeconds(2), Duration.ofMillis(800)))) {
            var recordsSent = new java.util.concurrent.atomic.AtomicInteger();
            stub.records = Flux.interval(Duration.ofMillis(20)).map(ignored -> "{\"status\":\"pulling manifest\"}\n")
                    .doOnNext(ignored -> recordsSent.incrementAndGet());
            service.start(UUID.randomUUID(), MODEL);
            awaitState(service, "failed");
            assertThat(service.downloads().getFirst().error()).isEqualTo("The model download exceeded its time limit.");
            assertThat(recordsSent.get()).isGreaterThan(1);
            awaitClosed(stub);
            assertThat(stub.calls.get()).isEqualTo(1);
        }
    }

    private static void awaitState(ModelDownloadService service, String state) {
        await().atMost(WAIT).untilAsserted(() -> assertThat(service.downloads().getFirst().state()).isEqualTo(state));
    }
    private static void awaitClosed(DownloadRuntimeStub stub) {
        await().atMost(WAIT).untilAsserted(() -> assertThat(stub.connections.get()).isZero());
        assertThat(stub.unexpectedCalls.get()).isZero();
    }
    private static void awaitLatch(CountDownLatch latch) {
        try { if (!latch.await(3, TimeUnit.SECONDS)) throw new AssertionError("Subscription gate timed out"); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new AssertionError(error); }
    }
    private static void awaitBarrier(CyclicBarrier barrier) {
        try { barrier.await(3, TimeUnit.SECONDS); }
        catch (Exception error) { throw new AssertionError(error); }
    }
}
