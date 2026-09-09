package com.hostai.backend;

import java.time.Instant;
import java.util.ArrayDeque;
import java.util.List;
import java.util.UUID;

/** One lock keeps admission, terminal state, history, and counters consistent. No prompts. */
public final class InferenceRegistry {
    public static final int MAX_CONCURRENT = 2;
    public static final int HISTORY_LIMIT = 50;
    public static final int MAX_GUEST_CONCURRENT = MAX_CONCURRENT - 1;
    private final ArrayDeque<Entry> history = new ArrayDeque<>();
    private int active;
    private int guests;
    private long total;
    private long failed;

    public Lease acquire(String model) { return acquire(model, false); }

    public Lease acquireGuest(String model) { return acquire(model, true); }

    private synchronized Lease acquire(String model, boolean guest) {
        if (active == MAX_CONCURRENT || (guest && guests == MAX_GUEST_CONCURRENT)) {
            throw new OverloadedException();
        }
        Entry entry = new Entry(model, guest);
        history.addFirst(entry);
        while (history.size() > HISTORY_LIMIT) {
            history.removeLast();
        }
        active++;
        if (guest) guests++;
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
                if (entry.guest) guests--;
                if (status.equals("failed")) {
                    failed++;
                }
            }
        }
    }

    private static final class Entry {
        final String id = UUID.randomUUID().toString();
        final String model;
        final boolean guest;
        final String startedAt = Instant.now().toString();
        final long startedNanos = System.nanoTime();
        String status = "running";
        Long durationMs;
        Long outputTokens;

        Entry(String model, boolean guest) { this.model = model; this.guest = guest; }

        RequestView view() {
            return new RequestView(id, model, status, startedAt, durationMs, outputTokens);
        }
    }
}
