package com.hostai.backend;

import com.fasterxml.jackson.annotation.JsonFormat;
import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.annotation.PreDestroy;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.UUID;
import java.util.function.Function;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import reactor.core.publisher.BaseSubscriber;
import reactor.core.publisher.Flux;

/** Owns pull subscriptions independently of the HTTP requests which manage them. */
@Service
public final class ModelDownloadService implements AutoCloseable {
    static final int HISTORY_LIMIT = 20;
    private final LinkedHashMap<UUID, Entry> history = new LinkedHashMap<>();
    private final Function<String, Flux<OllamaPullGateway.PullRecord>> pull;
    private Entry active;
    private boolean closed;

    @Autowired
    public ModelDownloadService(OllamaPullGateway gateway) { this(gateway::pull); }

    // Allows deterministic subscription scheduling in lifecycle tests with a loopback gateway.
    ModelDownloadService(Function<String, Flux<OllamaPullGateway.PullRecord>> pull) { this.pull = pull; }

    public Started start(UUID id, String model) {
        if (id == null) throw new GatewayException(HttpStatus.BAD_REQUEST, "A requestId UUID is required.");
        Entry entry;
        synchronized (this) {
            Entry existing = history.get(id);
            if (existing != null) {
                if (!existing.job.model().equals(model)) throw conflict("This requestId belongs to a different model.");
                return new Started(existing.job, false);
            }
            DownloadModelAdmission.validate(model);
            if (closed) throw new GatewayException(HttpStatus.SERVICE_UNAVAILABLE, "The download service is shutting down.");
            if (active != null) throw conflict("Another model download is already running.");
            entry = new Entry(id, model);
            history.put(id, entry);
            if (history.size() > HISTORY_LIMIT) history.pollFirstEntry();
            active = entry;
        }
        // The subscriber is owned before publication. BaseSubscriber remembers cancellation
        // before onSubscribe, including shutdown/cancel while the source is being constructed.
        // Subscribe outside the lock: callbacks may be synchronous or arrive on another thread.
        try {
            if (!entry.subscriber.isDisposed()) pull.apply(model).subscribe(entry.subscriber);
        } catch (Exception error) {
            failed(entry, error);
        }
        synchronized (this) { return new Started(entry.job, true); }
    }

    public synchronized List<Job> downloads() {
        return history.reversed().values().stream().map(entry -> entry.job).toList();
    }

    public synchronized Job cancel(UUID id) {
        Entry entry = history.get(id);
        if (entry == null) throw new GatewayException(HttpStatus.NOT_FOUND, "The model download does not exist.");
        finish(entry, "cancelled", "Download cancelled.", null);
        return entry.job;
    }

    private synchronized void progress(Entry entry, OllamaPullGateway.PullRecord record) {
        if (!entry.job.state().equals("running")) return;
        Job old = entry.job;
        boolean newLayer = record.digest() != null && !record.digest().equals(old.digest());
        String digest = record.digest() == null ? old.digest() : record.digest();
        Long completed = record.completedBytes() != null ? record.completedBytes() : newLayer ? null : old.completedBytes();
        Long total = record.totalBytes() != null ? record.totalBytes() : newLayer ? null : old.totalBytes();
        if (completed != null && total != null && completed > total) {
            failed(entry, OllamaPullGateway.invalid());
            return;
        }
        entry.job = new Job(old.id(), old.model(), "running", record.phase(), record.message(), digest,
                completed, total, old.createdAt(), Instant.now(), null);
        if (record.success()) finish(entry, "completed", "Download completed.", null);
    }

    private synchronized void failed(Entry entry, Throwable error) {
        finish(entry, "failed", "Download failed.", error instanceof GatewayException
                ? error.getMessage() : "The model download failed.");
    }

    // All mutations and terminal decisions share one lock. Disposal also happens before
    // releasing the active slot, so late callbacks cannot change a terminal snapshot.
    private void finish(Entry entry, String state, String message, String error) {
        Job old = entry.job;
        if (!old.state().equals("running")) return;
        entry.job = new Job(old.id(), old.model(), state, old.phase(), message, old.digest(),
                old.completedBytes(), old.totalBytes(), old.createdAt(), Instant.now(), error);
        entry.subscriber.dispose();
        if (active == entry) active = null;
    }

    @Override
    @PreDestroy
    public synchronized void close() {
        closed = true;
        if (active != null) finish(active, "cancelled", "Download cancelled.", null);
    }

    private static GatewayException conflict(String message) { return new GatewayException(HttpStatus.CONFLICT, message); }

    private final class Entry {
        Job job;
        final BaseSubscriber<OllamaPullGateway.PullRecord> subscriber = new BaseSubscriber<>() {
            @Override protected void hookOnNext(OllamaPullGateway.PullRecord record) { progress(Entry.this, record); }
            @Override protected void hookOnError(Throwable error) { failed(Entry.this, error); }
            @Override protected void hookOnComplete() {
                failed(Entry.this, new GatewayException(HttpStatus.BAD_GATEWAY,
                        "Ollama ended the download without reporting success."));
            }
        };

        Entry(UUID id, String model) {
            Instant now = Instant.now();
            job = new Job(id, model, "running", "starting", "Starting model download.",
                    null, null, null, now, now, null);
        }
    }

    public record Started(Job job, boolean created) {}

    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Job(UUID id, String model, String state, String phase, String message, String digest,
                      Long completedBytes, Long totalBytes,
                      @JsonFormat(shape = JsonFormat.Shape.STRING) Instant createdAt,
                      @JsonFormat(shape = JsonFormat.Shape.STRING) Instant updatedAt, String error) {}
}
