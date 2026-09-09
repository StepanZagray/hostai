package com.hostai.backend;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.annotation.PreDestroy;
import java.net.URI;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

/** Owns one temporary tunnel attempt; HTTP callers never wait for spawn, probing, or teardown. */
@Service
final class InternetSharing implements AutoCloseable {
    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(InternetSharing.class);
    interface Probe {
        boolean verify(URI publicOrigin, PublicIngress ingress);
        default String failure() { return "The public endpoint could not be verified for HTTPS streaming."; }
    }
    private final String configured;
    private final Probe probe;
    private final Duration startupTimeout;
    private final Duration checkInterval;
    private Attempt current;
    private boolean closed;
    private volatile Status status;

    InternetSharing(String configured) { this(configured, Duration.ofMinutes(2)); }
    @Autowired InternetSharing(@Value("${hostai.cloudflared-path:}") String configured,
            @Value("${hostai.tunnel-startup-timeout:PT2M}") Duration startupTimeout) {
        this(configured, new TunnelReachability(), startupTimeout, Duration.ofSeconds(15));
        if (startupTimeout.compareTo(Duration.ofSeconds(1)) < 0 || startupTimeout.compareTo(Duration.ofMinutes(10)) > 0)
            throw new IllegalArgumentException("Tunnel startup timeout must be between one second and ten minutes.");
    }
    InternetSharing(String configured, Probe probe, Duration startupTimeout, Duration checkInterval) {
        this.configured = configured; this.probe = probe; this.startupTimeout = startupTimeout; this.checkInterval = checkInterval;
        status = new Status("off", "cloudflare-quick", available().isPresent(), null, null, null);
    }
    private Optional<Path> available() { return QuickTunnelProcess.findExecutable(configured); }
    Status status() { return status; }

    Status start(Function<PublicIngress, GuestServer> listener) {
        Attempt attempt;
        Path executable;
        synchronized (this) {
            if (closed) throw new GatewayException(HttpStatus.SERVICE_UNAVAILABLE, "Internet sharing is closed.");
            if (current != null && current.thread.getState() == Thread.State.TERMINATED)
                throw new GatewayException(HttpStatus.SERVICE_UNAVAILABLE, "Restart the gateway to finish cleaning up the previous internet-sharing attempt.");
            if (current != null) throw new GatewayException(HttpStatus.CONFLICT, status.state().equals("stopping")
                    ? "Internet sharing is still stopping. Wait for it to finish before starting again."
                    : "Stop the current internet-sharing attempt before starting again.");
            executable = available().orElseThrow(() -> new GatewayException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Install cloudflared, then restart the gateway before starting internet sharing."));
            attempt = new Attempt(); current = attempt;
            status = new Status("starting", "cloudflare-quick", true, null, null, null);
            attempt.thread = Thread.ofVirtual().name("hostai-internet-sharing").unstarted(() -> run(attempt, executable, listener));
        }
        attempt.thread.start();
        return status;
    }

    Status stop() {
        Attempt attempt;
        synchronized (this) {
            attempt = current;
            if (attempt == null) {
                status = new Status("off", "cloudflare-quick", available().isPresent(), null, status.checkedAt(), null);
                return status;
            }
            // A terminal cleanup failure retains the refusing listener. Do not promise progress
            // from interrupting an already finished worker.
            if (attempt.thread.getState() == Thread.State.TERMINATED) return status;
            attempt.cancelled = true;
            set(attempt, "stopping", null, null);
            if (!attempt.cleaning && !attempt.binding) attempt.thread.interrupt();
        }
        // Sink emission can synchronously release a SharingService lease. Never emit under this monitor.
        attempt.ingress.close();
        return status;
    }

    URI publicOrigin() {
        synchronized (this) {
            if (current == null || !status.state().equals("live")) throw PublicIngress.unavailable();
            current.ingress.permit().requireActive();
            return current.ingress.origin();
        }
    }

    private void run(Attempt attempt, Path executable, Function<PublicIngress, GuestServer> listener) {
        String failure = null;
        try {
            synchronized (this) {
                if (attempt.cancelled) return;
                attempt.binding = true;
            }
            try { attempt.server = listener.apply(attempt.ingress); }
            finally { synchronized (this) { attempt.binding = false; } }
            if (attempt.cancelled) return;
            attempt.process = QuickTunnelProcess.start(executable, URI.create(attempt.server.origin()), attempt.ingress.secret(), origin -> {
                log.debug("Checking temporary public hostname {}", origin.getHost());
                attempt.announced = origin;
                attempt.notice.countDown();
            }, exit -> {
                synchronized (this) {
                    attempt.exited = true;
                    attempt.notice.countDown();
                    if (!attempt.cleaning) attempt.thread.interrupt();
                }
            });
            long deadline = System.nanoTime() + startupTimeout.toNanos();
            while (!attempt.cancelled && attempt.announced == null && !attempt.exited) {
                if (System.nanoTime() >= deadline) throw new Failed("The tunnel did not announce an address. Stop and try again.");
                attempt.notice.await(200, TimeUnit.MILLISECONDS);
            }
            if (attempt.cancelled) return;
            if (attempt.exited || !attempt.process.isAlive()) throw new Failed("The tunnel stopped unexpectedly. Start again to get a new link.");
            attempt.ingress.announced(attempt.announced);
            set(attempt, "verifying", null, null);
            // cloudflared announces before edge registration. Avoid immediately caching NXDOMAIN
            // while that registration is still completing; verification remains mandatory afterward.
            Thread.sleep(Math.min(5000, startupTimeout.toMillis() / 4));
            boolean wasLive = false;
            while (!attempt.cancelled) {
                if (attempt.exited || !attempt.process.isAlive()) throw new Failed("The tunnel stopped unexpectedly. Start again to get a new link.");
                boolean reachable = probe.verify(attempt.announced, attempt.ingress);
                if (attempt.cancelled) return;
                if (attempt.exited) throw new Failed("The tunnel stopped unexpectedly. Start again to get a new link.");
                if (reachable) {
                    attempt.ingress.verified();
                    set(attempt, "live", Instant.now(), null);
                    wasLive = true;
                } else if (wasLive) {
                    attempt.ingress.interrupted();
                    set(attempt, "interrupted", Instant.now(), probe.failure() + " Internet requests are blocked while checks retry.");
                } else if (System.nanoTime() >= deadline) {
                    throw new Failed(probe.failure() + " The tunnel has been stopped.");
                } else {
                    set(attempt, "verifying", Instant.now(), probe.failure() + " Still checking; internet access remains blocked.");
                }
                Thread.sleep(wasLive ? checkInterval.toMillis() : 1000);
            }
        } catch (InterruptedException error) {
            if (!attempt.cancelled) failure = "The tunnel stopped unexpectedly. Start again to get a new link.";
        } catch (Failed error) { failure = error.getMessage(); }
        catch (GatewayException error) { failure = error.getMessage(); }
        catch (Exception error) { failure = "Internet sharing could not start. Check cloudflared and your network, then try again."; }
        finally {
            // Serialize with both interrupt senders so no delayed interrupt can land during teardown.
            synchronized (this) { attempt.cleaning = true; }
            attempt.ingress.close();
            Thread.interrupted();
            boolean reaped = true;
            try { if (attempt.process != null) attempt.process.close(); }
            catch (RuntimeException error) { reaped = false; failure = "Internet requests are blocked, but the tunnel process could not be stopped. Restart the gateway after checking its process."; }
            // Keep the refusing listener bound if the child cannot be reaped: never retarget an orphan to a reused port.
            if (reaped && attempt.server != null) {
                Thread.interrupted();
                try { attempt.server.close(); }
                catch (RuntimeException error) {
                    reaped = false;
                    failure = "Internet requests are blocked, but the guest listener could not be closed. Restart the gateway.";
                }
            }
            synchronized (this) {
                if (current == attempt) {
                    status = new Status(failure == null ? "off" : "failed", "cloudflare-quick", available().isPresent(), null, status.checkedAt(), failure, !reaped);
                    if (reaped) current = null;
                }
            }
        }
    }

    private synchronized void set(Attempt attempt, String state, Instant checkedAt, String error) {
        if (current != attempt || (attempt.cancelled && !state.equals("stopping"))) return;
        status = new Status(state, "cloudflare-quick", true,
                state.equals("live") ? attempt.ingress.origin().toString() : null,
                checkedAt == null ? status.checkedAt() : checkedAt, error);
    }

    @Override @PreDestroy public void close() {
        Attempt attempt;
        synchronized (this) { if (closed) return; closed = true; attempt = current; }
        stop();
        if (attempt != null && attempt.thread != Thread.currentThread()) {
            try { attempt.thread.join(Duration.ofSeconds(15)); }
            catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IllegalStateException("Tunnel shutdown was interrupted."); }
            if (attempt.thread.isAlive()) throw new IllegalStateException("Tunnel shutdown has not completed.");
            synchronized (this) {
                if (current == attempt) throw new IllegalStateException("Internet-sharing cleanup has not completed.");
            }
        }
    }
    @JsonInclude(JsonInclude.Include.ALWAYS)
    record Status(String state, String provider, boolean available, String publicUrl, Instant checkedAt, String error, boolean restartRequired) {
        Status(String state, String provider, boolean available, String publicUrl, Instant checkedAt, String error) {
            this(state, provider, available, publicUrl, checkedAt, error, false);
        }
    }
    private static final class Attempt {
        final PublicIngress ingress = new PublicIngress();
        final CountDownLatch notice = new CountDownLatch(1);
        volatile boolean cancelled;
        volatile boolean exited;
        volatile boolean cleaning;
        boolean binding; // Guarded by the manager monitor; never interrupt a listener before ownership returns.
        volatile URI announced;
        Thread thread;
        GuestServer server;
        QuickTunnelProcess process;
    }
    private static final class Failed extends RuntimeException { Failed(String message) { super(message); } }
}
