package com.hostai.backend;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/** Also runnable using only the JDK when Maven dependencies are unavailable. */
public final class CoreChecks {
    public static void main(String[] args) throws Exception {
        endpointValidation();
        admissionAndTerminalStates();
        boundedNewestFirstHistory();
        concurrentFinishesReleaseExactlyOnce();
        System.out.println("PASS: loopback URL validation; two-slot admission and terminal states; bounded newest-first history; 200 concurrent terminal races on virtual threads");
    }

    static void endpointValidation() {
        equal("http://127.0.0.1:11434", LocalOllamaEndpoint.parse("http://localhost:11434/").requestUrl().toString());
        equal("http://[::1]:11434", LocalOllamaEndpoint.parse("http://[::1]:11434").requestUrl().toString());
        equal("https://127.0.0.1:444", LocalOllamaEndpoint.parse("https://127.0.0.1:444").displayUrl());
        for (String value : List.of("http://example.com", "http://192.168.0.1", "http://0.0.0.0",
                "http://127.0.0.1.evil.test", "http://127.1", "http://2130706433", "file:///tmp/test",
                "http://localhost/api", "http://localhost?target=evil", "http://localhost#fragment",
                "http://user:password@localhost", "http://localhost:0", "http://localhost:65536", "invalid")) {
            expect(IllegalArgumentException.class, () -> LocalOllamaEndpoint.parse(value));
        }
    }

    static void admissionAndTerminalStates() {
        InferenceRegistry registry = new InferenceRegistry();
        var first = registry.acquire("first");
        var second = registry.acquire("second");
        equal(2, registry.counters().activeRequests());
        equal(2L, registry.counters().totalRequests());
        equal(null, registry.requests().getFirst().durationMs());
        equal(null, registry.requests().getFirst().outputTokens());
        expect(InferenceRegistry.OverloadedException.class, () -> registry.acquire("third"));
        equal(2L, registry.counters().totalRequests());
        first.completed(42L);
        first.failed();
        first.close();
        equal(1, registry.counters().activeRequests());
        equal(0L, registry.counters().failedRequests());
        second.failed();
        equal(0, registry.counters().activeRequests());
        equal(1L, registry.counters().failedRequests());
        var third = registry.acquire("third");
        third.close();
        third.close();
        equal("cancelled", registry.requests().getFirst().status());
        equal("failed", registry.requests().get(1).status());
        equal("completed", registry.requests().get(2).status());
        equal(42L, registry.requests().get(2).outputTokens());
        check(registry.requests().stream().allMatch(r -> r.durationMs() != null && r.durationMs() >= 0), "Terminal durations");
        equal(0, registry.counters().activeRequests());
        equal(1L, registry.counters().failedRequests());
    }

    static void boundedNewestFirstHistory() {
        InferenceRegistry registry = new InferenceRegistry();
        var longRunning = registry.acquire("old-running");
        for (int i = 0; i < 80; i++) {
            registry.acquire("model-" + i).completed((long) i);
        }
        equal(50, registry.requests().size());
        equal("model-79", registry.requests().getFirst().model());
        equal("model-30", registry.requests().getLast().model());
        longRunning.close();
        equal(0, registry.counters().activeRequests());
        equal(81L, registry.counters().totalRequests());
    }

    static void concurrentFinishesReleaseExactlyOnce() throws Exception {
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            for (int round = 0; round < 200; round++) {
                InferenceRegistry registry = new InferenceRegistry();
                var first = registry.acquire("race");
                var second = registry.acquire("held");
                CountDownLatch ready = new CountDownLatch(3);
                CountDownLatch start = new CountDownLatch(1);
                List<Future<?>> futures = new ArrayList<>();
                for (Runnable finish : List.<Runnable>of(() -> first.completed(3L), first::failed, first::close)) {
                    futures.add(executor.submit(() -> {
                        check(Thread.currentThread().isVirtual(), "Must run the race on virtual threads");
                        ready.countDown();
                        check(start.await(5, TimeUnit.SECONDS), "Race start");
                        finish.run();
                        return null;
                    }));
                }
                check(ready.await(5, TimeUnit.SECONDS), "Race participants ready");
                expect(InferenceRegistry.OverloadedException.class, () -> registry.acquire("overload"));
                start.countDown();
                for (Future<?> future : futures) future.get(5, TimeUnit.SECONDS);
                equal(1, registry.counters().activeRequests());
                var replacement = registry.acquire("replacement");
                expect(InferenceRegistry.OverloadedException.class, () -> registry.acquire("overload"));
                replacement.close();
                second.close();
                equal(0, registry.counters().activeRequests());
                check(registry.counters().failedRequests() <= 1, "Failure counted at most once");
            }
        }
    }

    private static void expect(Class<? extends Throwable> type, Runnable action) {
        try {
            action.run();
        } catch (Throwable error) {
            if (type.isInstance(error)) return;
            throw new AssertionError("Expected " + type.getName(), error);
        }
        throw new AssertionError("Expected " + type.getName());
    }

    private static void equal(Object expected, Object actual) {
        check(java.util.Objects.equals(expected, actual), "Expected " + expected + ", got " + actual);
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
