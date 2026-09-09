package com.hostai.backend;

import java.time.Instant;
import java.util.ArrayDeque;
import java.util.List;
import java.util.UUID;

/** One lock keeps admission, terminal state, history, and counters consistent. No prompts. */
public final class InferenceRegistry {
    public static final int MAX_CONCURRENT = 2;
    public static final int HISTORY_LIMIT = 50;
    private final ArrayDeque<Entry> history = new ArrayDeque<>();
    private int active;
    private long total;
    private long failed;

    public synchronized Lease acquire(String model) {
        if (active == MAX_CONCURRENT) {
            throw new OverloadedException();
        }
        Entry entry = new Entry(model);
        history.addFirst(entry);
        while (history.size() > HISTORY_LIMIT) {
            history.removeLast();
        }
        active++;
        total++;
        return new Lease(entry);
    }

    public synchronized Counters counters() {
        return new Counters(active, total, failed);
    }

    public synchronized List<RequestView> requests() {
        return history.stream().map(Entry::view).toList();
    }

    public record Counters(int activeRequests, long totalRequests, long failedRequests) {}

    public record RequestView(String id, String model, String status, String startedAt,
                              Long durationMs, Long outputTokens) {}

    public static final class OverloadedException extends RuntimeException {
        public OverloadedException() {
            super("Both inference slots are occupied. Try again after a request finishes.");
        }
    }

    public final class Lease implements AutoCloseable {
        private final Entry entry;

        private Lease(Entry entry) {
            this.entry = entry;
        }

        public void completed(Long outputTokens) { finish("completed", outputTokens); }
        public void failed() { finish("failed", null); }
        @Override public void close() { finish("cancelled", null); }

        private void finish(String status, Long outputTokens) {
            synchronized (InferenceRegistry.this) {
                if (!entry.status.equals("running")) {
                    return;
                }
                entry.status = status;
                entry.durationMs = Math.max(0L, (System.nanoTime() - entry.startedNanos) / 1_000_000);
                entry.outputTokens = outputTokens;
                active--;
                if (status.equals("failed")) {
                    failed++;
                }
            }
        }
    }

    private static final class Entry {
        final String id = UUID.randomUUID().toString();
        final String model;
        final String startedAt = Instant.now().toString();
        final long startedNanos = System.nanoTime();
        String status = "running";
        Long durationMs;
        Long outputTokens;

        Entry(String model) { this.model = model; }

        RequestView view() {
            return new RequestView(id, model, status, startedAt, durationMs, outputTokens);
        }
    }
}
