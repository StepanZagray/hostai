package com.hostai.backend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class QuickTunnelProcessTest {
    private static final Duration WAIT = Duration.ofSeconds(10);
    private static final URI LOOPBACK = URI.create("http://127.0.0.1:32123");
    private static final URI PUBLIC = URI.create("https://fixture-tunnel.trycloudflare.com");
    private static final String SECRET = Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[32]);
    private static final String HOLD = "exec /bin/sleep 120\n";

    @TempDir Path temporary;
    private final List<QuickTunnelProcess> owners = new ArrayList<>();
    private final List<ProcessHandle> handles = new ArrayList<>();
    private final List<Fixture> fixtures = new ArrayList<>();

    @AfterEach void cleanup() throws Exception {
        var failures = new ArrayList<Throwable>();
        for (QuickTunnelProcess owner : owners) {
            try { owner.close(); }
            catch (RuntimeException failure) { failures.add(failure); }
        }
        for (ProcessHandle handle : handles) {
            if (handle.isAlive()) {
                handle.destroyForcibly();
                await().atMost(WAIT).until(() -> !handle.isAlive());
                failures.add(new AssertionError("Fixture process required fallback cleanup: " + handle.pid()));
            }
            assertThat(handle.isAlive()).as("owned PID %s is gone", handle.pid()).isFalse();
            assertThat(ProcessHandle.of(handle.pid())).as("owned PID %s was reaped", handle.pid()).isEmpty();
        }
        for (Fixture fixture : fixtures) {
            if (Files.exists(fixture.path("work")))
                assertThat(Path.of(Files.readString(fixture.path("work")).strip())).doesNotExist();
        }
        assertThat(failures).as("every owner cleaned up successfully").isEmpty();
    }

    @ParameterizedTest @ValueSource(strings = {
            "https://fixture-tunnel.trycloudflare.com",
            "|https://fixture-tunnel.trycloudflare.com|",
            "2026-01-01 INF |  https://fixture-tunnel.trycloudflare.com  | ready",
            "\thttps://fixture-tunnel.trycloudflare.com\t",
            "https://fixture-tunnel.trycloudflare.com\r",
            "HTTPS://FIXTURE-TUNNEL.TRYCLOUDFLARE.COM",
            "https://fixture-tunnel.trycloudflare.com | https://fixture-tunnel.trycloudflare.com"
    })
    void acceptsOnlyCompleteCanonicalPublicOrigins(String line) {
        assertThat(QuickTunnelProcess.publicOrigin(line)).contains(PUBLIC);
    }

    @Test void rejectsHostileSuffixesPrefixesAndNonOrigins() {
        for (String suffix : List.of(".evil", ".", ":443", ":", "/", "/secret", "?x=y", "#secret", "@evil",
                "%2eevil", "%2f", "\\evil", "-evil", "_evil", "é", "\u200b", "\u0000", "\u001b[0m",
                "\r.evil", ")", ",", ";", "=evil", "!evil")) {
            assertThat(QuickTunnelProcess.publicOrigin("| " + PUBLIC + suffix + " |"))
                    .as("suffix %s must not become a valid-prefix match", suffix).isEmpty();
        }
        for (String line : Arrays.asList(null, "", "no URL", "http://fixture-tunnel.trycloudflare.com",
                "https://trycloudflare.com", "https://a.b.trycloudflare.com", "https://a_b.trycloudflare.com",
                "https://-a.trycloudflare.com", "https://a-.trycloudflare.com", "https://a..trycloudflare.com",
                "https://user@fixture-tunnel.trycloudflare.com", "https://user:pass@fixture-tunnel.trycloudflare.com",
                "prefix" + PUBLIC, "https://evil/" + PUBLIC, "https://" + "a".repeat(64) + ".trycloudflare.com",
                PUBLIC + "\n", PUBLIC + " https://different.trycloudflare.com")) {
            assertThat(QuickTunnelProcess.publicOrigin(line)).as("invalid line").isEmpty();
        }
        assertThat(QuickTunnelProcess.publicOrigin("https://a.trycloudflare.com"))
                .contains(URI.create("https://a.trycloudflare.com"));
        String longest = "https://" + "a".repeat(63) + ".trycloudflare.com";
        assertThat(QuickTunnelProcess.publicOrigin(longest)).contains(URI.create(longest));
        assertThat(QuickTunnelProcess.publicOrigin(" ".repeat(16 * 1024 - PUBLIC.toString().length()) + PUBLIC))
                .contains(PUBLIC);
        assertThat(QuickTunnelProcess.publicOrigin(" ".repeat(16 * 1024) + PUBLIC)).isEmpty();
        assertThat(QuickTunnelProcess.publicOrigin("é".repeat(8192) + " " + PUBLIC)).isEmpty();
    }

    @Test void discoveryOnlyReturnsExecutableRegularFilesWithoutExpansionOrInvocation() throws Exception {
        Fixture fixture = fixture("exit 93\n");
        assertThat(QuickTunnelProcess.findExecutable(fixture.executable().toString())).contains(fixture.executable());
        assertThat(QuickTunnelProcess.findExecutable(fixture.directory().toString())).isEmpty();
        assertThat(QuickTunnelProcess.findExecutable(fixture.path("missing").toString())).isEmpty();
        assertThat(QuickTunnelProcess.findExecutable("\u0000")).isEmpty();
        assertThat(QuickTunnelProcess.findExecutable("~/cloudflared")).isEmpty();
        assertThat(QuickTunnelProcess.findExecutable("$HOME/cloudflared")).isEmpty();
        assertThat(QuickTunnelProcess.findExecutable(fixture.executable() + " --version")).isEmpty();
        assertThat(fixture.path("pid")).doesNotExist();
        Files.setPosixFilePermissions(fixture.executable(), PosixFilePermissions.fromString("rw-------"));
        assertThat(QuickTunnelProcess.findExecutable(fixture.executable().toString())).isEmpty();
        IOException failure = assertThrows(IOException.class,
                () -> QuickTunnelProcess.start(fixture.executable(), LOOPBACK, SECRET, ignored -> {}, ignored -> {}));
        assertSanitized(failure, "Quick Tunnel could not be started.");
        for (Path unavailable : Arrays.asList(null, fixture.directory(), fixture.path("missing"))) {
            assertSanitized(assertThrows(IOException.class,
                    () -> QuickTunnelProcess.start(unavailable, LOOPBACK, SECRET, ignored -> {}, ignored -> {})),
                    "Quick Tunnel could not be started.");
        }
        assertThat(fixture.path("pid")).doesNotExist();
    }

    @Test void rejectsEveryMalformedArgumentBeforeStartingAnything() throws Exception {
        Fixture fixture = fixture(HOLD);
        for (String origin : Arrays.asList(null, "http://localhost:32123", "https://127.0.0.1:32123",
                "http://127.0.0.2:32123", "http://[::1]:32123", "http://127.0.0.1", "http://127.0.0.1:0",
                "http://127.0.0.1:65536", "http://127.0.0.1:32123/", "http://127.0.0.1:32123/path",
                "http://127.0.0.1:32123?", "http://127.0.0.1:32123#", "http://user@127.0.0.1:32123",
                "http://127.0.0.1:032123", "HTTP://127.0.0.1:32123")) {
            assertSanitized(assertThrows(IllegalArgumentException.class,
                    () -> QuickTunnelProcess.start(fixture.executable(), origin == null ? null : URI.create(origin),
                            SECRET, ignored -> {}, ignored -> {})),
                    "Quick Tunnel requires an IPv4 loopback HTTP origin.");
        }
        for (String secret : Arrays.asList(null, "", "short", "A".repeat(42), "A".repeat(44), "A".repeat(42) + "B",
                SECRET + "=", "+" + "A".repeat(42), "/" + "A".repeat(42), "A".repeat(42) + "\n")) {
            assertSanitized(assertThrows(IllegalArgumentException.class,
                    () -> QuickTunnelProcess.start(fixture.executable(), LOOPBACK, secret, ignored -> {}, ignored -> {})),
                    "Quick Tunnel requires a valid ingress secret.");
        }
        assertThrows(IllegalArgumentException.class,
                () -> QuickTunnelProcess.start(fixture.executable(), LOOPBACK, SECRET, null, ignored -> {}));
        assertThrows(IllegalArgumentException.class,
                () -> QuickTunnelProcess.start(fixture.executable(), LOOPBACK, SECRET, ignored -> {}, null));
        assertThat(fixture.path("pid")).doesNotExist();
    }

    @Test void commandAndEnvironmentAreIsolatedAndOnlyPrivateFilesAreDeleted() throws Exception {
        Fixture fixture = fixture("/usr/bin/env -0 > \"$fixture/environment\"\n" + HOLD);
        var events = new Events();
        QuickTunnelProcess owner = start(fixture, events);
        Path directory = privateDirectory(fixture);
        awaitFile(fixture.path("environment"));
        assertThat(owner.isAlive()).isTrue();
        ProcessHandle executable = ProcessHandle.of(Long.parseLong(Files.readString(fixture.path("pid")).strip()))
                .orElseThrow();
        handles.add(executable);
        assertThat(executable.parent()).contains(ProcessHandle.of(owner.pid()).orElseThrow());
        List<String> args = Files.readAllLines(fixture.path("args"));
        assertThat(args).containsExactly("tunnel", "--config", directory.resolve("tunnel.yaml").toString(),
                "--no-autoupdate", "--metrics", "127.0.0.1:0", "--protocol", "http2", "--loglevel", "info",
                "--url", LOOPBACK.toString());
        assertMode(directory, "rwx------");
        assertMode(directory.resolve("tunnel.yaml"), "rw-------");
        assertThat(Files.readString(directory.resolve("tunnel.yaml"))).isEqualTo("tag:\n  - Hostai-Ingress=" + SECRET + "\n");
        Map<String, String> environment = environment(fixture.path("environment"));
        assertThat(environment.keySet()).isSubsetOf("PATH", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "TMPDIR",
                "PWD", "SHLVL", "_"); // A shell fixture may itself supply these last three variables.
        assertThat(environment.get("PATH")).isEqualTo(System.getenv().getOrDefault("PATH", "/usr/bin:/bin"));
        for (var entry : Map.of("HOME", "home", "XDG_CONFIG_HOME", "config", "XDG_DATA_HOME", "data", "TMPDIR", "tmp").entrySet()) {
            assertThat(environment.get(entry.getKey())).isEqualTo(directory.resolve(entry.getValue()).toString());
            assertMode(directory.resolve(entry.getValue()), "rwx------");
        }
        Path outside = Files.writeString(fixture.path("keep"), "fixture data");
        Files.createSymbolicLink(directory.resolve("external-link"), fixture.directory());
        owner.close();
        owner.close();
        assertThat(owner.isAlive()).isFalse();
        events.awaitExit("Quick Tunnel stopped.");
        assertThat(directory).doesNotExist();
        assertThat(Files.readString(outside)).isEqualTo("fixture data");
    }

    @ParameterizedTest @ValueSource(booleans = {false, true})
    void abruptParentJvmDeathReapsTheWatchdogAndExecutable(boolean ignoreTerm) throws Exception {
        Fixture fixture = fixture((ignoreTerm ? "trap '' TERM\n" : "")
                + "if IFS= read -r unexpected; then exit 94; fi\n" + announce() + HOLD);
        Path scratch = Files.createDirectory(fixture.path("jvm-tmp"),
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        Path output = fixture.path("probe-output");
        var builder = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-XX:-UsePerfData", "-Djava.io.tmpdir=" + scratch,
                "-cp", System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")),
                ParentDeathProbe.class.getName(), fixture.executable().toString(), fixture.directory().toString())
                .redirectErrorStream(true).redirectOutput(output.toFile());
        builder.environment().clear();
        builder.environment().put("PATH", "/usr/bin:/bin");
        builder.environment().put("HOME", fixture.directory().toString());
        Process probe = builder.start();
        handles.add(probe.toHandle());
        var descendants = new java.util.LinkedHashSet<ProcessHandle>();
        try {
            await().pollInterval(Duration.ofMillis(10)).atMost(WAIT).until(() -> {
                probe.descendants().forEach(descendants::add);
                if (!probe.isAlive()) throw new AssertionError("Parent probe failed: " + Files.readString(output));
                return Files.exists(fixture.path("ready")) && Files.size(fixture.path("ready")) > 0
                        && descendants.size() == 3;
            });
            handles.addAll(descendants);
            long wrapperPid = Long.parseLong(Files.readString(fixture.path("ready")).strip());
            long executablePid = Long.parseLong(Files.readString(fixture.path("pid")).strip());
            assertThat(descendants).extracting(ProcessHandle::pid).contains(wrapperPid, executablePid);
            assertThat(descendants).allMatch(ProcessHandle::isAlive);
            ProcessHandle wrapper = ProcessHandle.of(wrapperPid).orElseThrow();
            assertThat(wrapper.parent()).contains(probe.toHandle());
            assertThat(wrapper.children().toList()).hasSize(2);
            Path directory = privateDirectory(fixture);
            assertThat(directory.getParent()).isEqualTo(scratch);

            // SIGKILL skips both shutdown hooks and try-with-resources: only pipe EOF can stop the child.
            probe.destroyForcibly();
            assertThat(probe.waitFor(10, TimeUnit.SECONDS)).isTrue();
            assertThat(probe.exitValue()).isNotZero();
            await().alias("captured wrapper, watcher and executable are reaped after JVM death")
                    .atMost(WAIT).until(() -> descendants.stream().noneMatch(ProcessHandle::isAlive));
            for (ProcessHandle child : descendants)
                assertThat(ProcessHandle.of(child.pid())).as("captured PID %s was reaped", child.pid()).isEmpty();
            assertThat(fixture.path("shutdown-hook")).doesNotExist();
            // JVM cleanup cannot run after SIGKILL. The fixture owns this exact private scratch path.
            assertThat(Files.readString(directory.resolve("tunnel.yaml"))).isEqualTo("tag:\n  - Hostai-Ingress=" + SECRET + "\n");
        } finally {
            probe.descendants().forEach(descendants::add);
            for (ProcessHandle child : descendants) {
                if (!handles.contains(child)) handles.add(child);
            }
            // Leave each parent alive to reap its children even when an assertion failed.
            long deadline = System.nanoTime() + WAIT.toNanos();
            while (descendants.stream().anyMatch(ProcessHandle::isAlive) && System.nanoTime() < deadline) {
                for (ProcessHandle child : descendants) {
                    if (child.isAlive() && child.children().noneMatch(ProcessHandle::isAlive)) child.destroyForcibly();
                }
                Thread.sleep(10);
            }
            if (probe.isAlive()) probe.destroyForcibly();
            assertThat(probe.waitFor(10, TimeUnit.SECONDS)).isTrue();
            probe.getInputStream().close();
            probe.getErrorStream().close();
            probe.getOutputStream().close();
            Files.walkFileTree(scratch, new SimpleFileVisitor<>() {
                @Override public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) throws IOException {
                    Files.delete(file);
                    return FileVisitResult.CONTINUE;
                }

                @Override public FileVisitResult postVisitDirectory(Path path, IOException failure) throws IOException {
                    if (failure != null) throw failure;
                    Files.delete(path);
                    return FileVisitResult.CONTINUE;
                }
            });
        }
    }

    @Test void controlledParentEnvironmentCannotInjectTunnelProxyCredentialsOrDisplaySettings() throws Exception {
        Fixture fixture = fixture("/usr/bin/env -0 > \"$fixture/environment\"\n" + announce() + HOLD);
        Path output = fixture.path("probe-output");
        var builder = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-XX:-UsePerfData", "-cp", System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")),
                EnvironmentProbe.class.getName(), fixture.executable().toString())
                .redirectErrorStream(true).redirectOutput(output.toFile());
        builder.environment().clear();
        builder.environment().put("PATH", fixture.directory().toString());
        for (String name : List.of("HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "TMPDIR", "TUNNEL_TOKEN",
                "TUNNEL_ORIGIN_CERT", "TUNNEL_CONFIG", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
                "http_proxy", "https_proxy", "CLOUDFLARE_API_TOKEN", "AWS_SECRET_ACCESS_KEY", "DISPLAY",
                "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK"))
            builder.environment().put(name, "synthetic-fixture-parent-value");
        Process probe = builder.start();
        handles.add(probe.toHandle());
        try {
            assertThat(probe.waitFor(15, TimeUnit.SECONDS)).as("environment probe terminates").isTrue();
            assertThat(probe.exitValue()).as("probe output: %s", Files.readString(output)).isZero();
            assertThat(Files.readString(output)).isEqualTo("OK");
            Map<String, String> environment = environment(fixture.path("environment"));
            assertThat(environment.values()).doesNotContain("synthetic-fixture-parent-value");
            assertThat(environment.keySet()).isSubsetOf("PATH", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "TMPDIR", "PWD", "SHLVL", "_");
            assertThat(environment.get("PATH")).isEqualTo(fixture.directory().toString());
            assertThat(Path.of(Files.readString(fixture.path("work")).strip())).doesNotExist();
            assertThat(ProcessHandle.of(Long.parseLong(Files.readString(fixture.path("pid")).strip())))
                    .isEmpty();
        } finally {
            if (probe.isAlive()) {
                probe.descendants().forEach(handles::add);
                for (ProcessHandle child : handles) if (child.pid() != probe.pid()) child.destroyForcibly();
                probe.destroyForcibly();
            }
            assertThat(probe.waitFor(10, TimeUnit.SECONDS)).isTrue();
            probe.getInputStream().close();
            probe.getErrorStream().close();
            probe.getOutputStream().close();
        }
    }

    @ParameterizedTest @ValueSource(ints = {0, 17})
    void naturalExitDrainsOutputAndDeliversEachCallbackOnce(int status) throws Exception {
        Fixture fixture = fixture(announce() + announce()
                + "IFS= read -r diagnostic < \"$fixture/diagnostic\"\n"
                + "printf '%s\\n' 'https://hostile.trycloudflare.com.evil' \"$diagnostic\" >&2\n"
                + "IFS= read -r status < \"$fixture/status\"\nexit \"$status\"\n");
        Files.writeString(fixture.path("diagnostic"), "raw fixture secret " + SECRET + "\n");
        Files.writeString(fixture.path("status"), status + "\n");
        var events = new Events();
        QuickTunnelProcess owner = start(fixture, events);
        Path directory = privateDirectory(fixture);
        events.awaitExit(status == 0 ? "Quick Tunnel exited." : "Quick Tunnel failed.");
        assertThat(events.origins).containsExactly(PUBLIC);
        owner.close();
        owner.close();
        assertThat(events.exits).hasSize(1);
        assertThat(events.order).containsExactly("announced", "exited");
        assertThat(owner.isAlive()).isFalse();
        assertThat(directory).doesNotExist();
    }

    @Test void stderrAndFinalUnterminatedLineAreParsed() throws Exception {
        Fixture fixture = fixture("printf '%s' \"$public_origin\" >&2\n");
        var events = new Events();
        start(fixture, events);
        events.awaitExit("Quick Tunnel exited.");
        assertThat(events.origins).containsExactly(PUBLIC);
    }

    @ParameterizedTest @ValueSource(strings = {"\n", " | "})
    void aChangedOriginFailsEvenOnTheSameLine(String separator) throws Exception {
        Fixture fixture = fixture("/bin/cat \"$fixture/payload\"\n" + HOLD);
        Files.writeString(fixture.path("payload"), PUBLIC + separator + "https://replacement.trycloudflare.com\n");
        var events = new Events();
        QuickTunnelProcess owner = start(fixture, events);
        events.awaitExit("Quick Tunnel origin changed.");
        assertThat(events.origins).containsExactly(PUBLIC);
        assertThat(owner.isAlive()).isFalse();
    }

    @Test void invalidOriginsAreNeverAnnounced() throws Exception {
        Fixture fixture = fixture("printf '%s\\n' 'http://fixture.trycloudflare.com' 'https://fixture.trycloudflare.com/secret' "
                + "'https://fixture.trycloudflare.com.evil' 'https://user@fixture.trycloudflare.com'\n");
        var events = new Events();
        start(fixture, events);
        events.awaitExit("Quick Tunnel exited.");
        assertThat(events.origins).isEmpty();
    }

    @ParameterizedTest @ValueSource(strings = {"line", "total", "stderr", "utf8"})
    void outputOverflowFailsClosedWithoutRetainingRawDiagnostics(String kind) throws Exception {
        Fixture fixture = fixture("/bin/cat \"$fixture/payload\"" + (kind.equals("stderr") ? " >&2" : "") + "\n" + HOLD);
        String payload = switch (kind) {
            case "line", "stderr" -> "x".repeat(16 * 1024 + 1);
            case "utf8" -> "é".repeat(8193);
            default -> ("x".repeat(1023) + "\n").repeat(4096) + "x";
        };
        Files.writeString(fixture.path("payload"), payload);
        var events = new Events();
        QuickTunnelProcess owner = start(fixture, events);
        events.awaitExit("Quick Tunnel output limit exceeded.");
        assertThat(events.origins).isEmpty();
        assertThat(owner.isAlive()).isFalse();
    }

    @ParameterizedTest @ValueSource(strings = {"line", "total"})
    void exactOutputLimitsAreAllowed(String kind) throws Exception {
        Fixture fixture = fixture("exec /bin/cat \"$fixture/payload\"\n");
        Files.writeString(fixture.path("payload"), kind.equals("line")
                ? " ".repeat(16 * 1024 - PUBLIC.toString().length()) + PUBLIC
                : ("x".repeat(1023) + "\n").repeat(4096));
        var events = new Events();
        start(fixture, events);
        events.awaitExit("Quick Tunnel exited.");
        assertThat(events.origins).hasSize(kind.equals("line") ? 1 : 0);
    }

    @Test void announcementAndExitCallbacksCanBothCloseReentrantly() throws Exception {
        Fixture fixture = fixture(announce() + HOLD);
        var ownerRef = new CompletableFuture<QuickTunnelProcess>();
        var announcementClosed = new CompletableFuture<Void>();
        var exitClosed = new CompletableFuture<Void>();
        var events = new Events();
        QuickTunnelProcess owner = start(fixture, origin -> {
            try {
                ownerRef.get(10, TimeUnit.SECONDS).close();
                events.announced(origin);
                announcementClosed.complete(null);
            } catch (Throwable failure) { announcementClosed.completeExceptionally(failure); }
        }, exit -> {
            try {
                ownerRef.get(10, TimeUnit.SECONDS).close();
                events.exited(exit);
                exitClosed.complete(null);
            } catch (Throwable failure) { exitClosed.completeExceptionally(failure); }
        });
        ownerRef.complete(owner);
        announcementClosed.get(10, TimeUnit.SECONDS);
        exitClosed.get(10, TimeUnit.SECONDS);
        events.awaitExit("Quick Tunnel stopped.");
        assertThat(events.origins).containsExactly(PUBLIC);
        assertThat(owner.isAlive()).isFalse();
    }

    @Test void concurrentCloseDoesNotWaitForABlockedAnnouncement() throws Exception {
        Fixture fixture = fixture(announce() + HOLD);
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var events = new Events();
        QuickTunnelProcess owner = start(fixture, origin -> {
            entered.countDown();
            try { release.await(); }
            catch (InterruptedException failure) { Thread.currentThread().interrupt(); }
            events.announced(origin);
        }, events::exited);
        var closed = new ArrayList<CompletableFuture<Void>>();
        try {
            assertThat(entered.await(10, TimeUnit.SECONDS)).isTrue();
            for (int i = 0; i < 4; i++) {
                var completion = new CompletableFuture<Void>();
                closed.add(completion);
                Thread.ofVirtual().start(() -> {
                    try { owner.close(); completion.complete(null); }
                    catch (Throwable failure) { completion.completeExceptionally(failure); }
                });
            }
            for (var completion : closed) completion.get(10, TimeUnit.SECONDS);
            assertThat(owner.isAlive()).isFalse();
            assertThat(events.exits).isEmpty();
        } finally { release.countDown(); }
        events.awaitExit("Quick Tunnel stopped.");
        assertThat(events.origins).containsExactly(PUBLIC);
    }

    @Test void callbackFailuresAreSanitizedAndStillStopTheProcess() throws Exception {
        Fixture fixture = fixture(announce() + HOLD);
        var exit = new CompletableFuture<QuickTunnelProcess.Exit>();
        QuickTunnelProcess owner = start(fixture,
                ignored -> { throw new IllegalStateException("raw fixture " + SECRET + temporary); },
                result -> { exit.complete(result); throw new AssertionError("raw fixture " + SECRET); });
        assertThat(exit.get(10, TimeUnit.SECONDS).reason()).isEqualTo("Quick Tunnel callback failed.");
        assertThat(owner.isAlive()).isFalse();
        owner.close();
    }

    @Test void anInterruptedCallbackStillReceivesExactlyOneExit() throws Exception {
        Fixture fixture = fixture(announce() + HOLD);
        var events = new Events();
        QuickTunnelProcess owner = start(fixture, origin -> {
            events.announced(origin);
            Thread.currentThread().interrupt();
        }, events::exited);
        events.awaitExit("Quick Tunnel callback failed.");
        owner.close();
        assertThat(events.origins).containsExactly(PUBLIC);
        assertThat(events.exits).hasSize(1);
        assertThat(owner.isAlive()).isFalse();
    }

    @Test void cleanupFailureIsFixedAndRepeatedCloseCannotPretendItSucceeded() throws Exception {
        Fixture fixture = fixture(announce() + HOLD);
        var events = new Events();
        QuickTunnelProcess owner = start(fixture, events);
        Path directory = privateDirectory(fixture);
        await().atMost(WAIT).until(() -> !events.origins.isEmpty());
        Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("r-x------"));
        try {
            org.junit.jupiter.api.Assumptions.assumeFalse(Files.isWritable(directory),
                    "Permission failure injection requires an unprivileged test process.");
            assertSanitized(assertThrows(IllegalStateException.class, owner::close), "Quick Tunnel cleanup failed.");
            assertThat(owner.isAlive()).isFalse();
            events.awaitExit("Quick Tunnel cleanup failed.");
            assertSanitized(assertThrows(IllegalStateException.class, owner::close), "Quick Tunnel cleanup failed.");
            assertThat(events.exits).hasSize(1);
        } finally {
            Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
            try { owner.close(); }
            catch (IllegalStateException expected) { /* This deliberately failed owner remembers its failure. */ }
            owners.remove(owner);
            if (Files.exists(directory)) {
                Files.walkFileTree(directory, new SimpleFileVisitor<>() {
                    @Override public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) throws IOException {
                        Files.delete(file);
                        return FileVisitResult.CONTINUE;
                    }

                    @Override public FileVisitResult postVisitDirectory(Path path, IOException failure) throws IOException {
                        if (failure != null) throw failure;
                        Files.delete(path);
                        return FileVisitResult.CONTINUE;
                    }
                });
            }
        }
    }

    @Test void interruptedCloserStillCleansUpAndPreservesInterruptStatus() throws Exception {
        Fixture fixture = fixture(announce() + HOLD);
        var events = new Events();
        QuickTunnelProcess owner = start(fixture, events);
        await().atMost(WAIT).until(() -> !events.origins.isEmpty());
        var closed = new CompletableFuture<Boolean>();
        Thread.ofVirtual().start(() -> {
            Thread.currentThread().interrupt();
            try { owner.close(); closed.complete(Thread.currentThread().isInterrupted()); }
            catch (Throwable failure) { closed.completeExceptionally(failure); }
        });
        assertThat(closed.get(10, TimeUnit.SECONDS)).isTrue();
        events.awaitExit("Quick Tunnel stopped.");
        assertThat(owner.isAlive()).isFalse();
    }

    @Test void closeForcesATermIgnoringProcessWithinItsBound() throws Exception {
        Fixture fixture = fixture("trap '' TERM\n" + announce() + HOLD);
        var events = new Events();
        QuickTunnelProcess owner = start(fixture, events);
        await().atMost(WAIT).until(() -> !events.origins.isEmpty());
        long before = System.nanoTime();
        owner.close();
        assertThat(Duration.ofNanos(System.nanoTime() - before)).isLessThan(Duration.ofSeconds(5));
        assertThat(owner.isAlive()).isFalse();
        events.awaitExit("Quick Tunnel stopped.");
    }

    @ParameterizedTest @ValueSource(booleans = {false, true})
    void closeCleansHeldStdoutAndItsExactDescendant(boolean ignoreTerm) throws Exception {
        Fixture fixture = fixture("trap 'wait; exit 0' TERM\n"
                + (ignoreTerm ? "(trap '' TERM; exec /bin/sleep 120)" : "/bin/sleep 120")
                + " &\nprintf '%s\\n' \"$!\" > \"$fixture/child-pid\"\n" + announce() + "wait\n");
        var events = new Events();
        QuickTunnelProcess owner = start(fixture, events);
        ProcessHandle child = child(fixture);
        await().atMost(WAIT).until(() -> !events.origins.isEmpty());
        assertThat(child.isAlive()).isTrue();
        long before = System.nanoTime();
        owner.close();
        assertThat(Duration.ofNanos(System.nanoTime() - before)).isLessThan(Duration.ofSeconds(5));
        assertThat(child.isAlive()).isFalse();
        assertThat(owner.isAlive()).isFalse();
        events.awaitExit("Quick Tunnel stopped.");
    }

    @Test void naturalParentExitCleansPreviouslyObservedChildHoldingStdout() throws Exception {
        Fixture fixture = fixture("/bin/sleep 120 &\nprintf '%s\\n' \"$!\" > \"$fixture/child-pid\"\n"
                + announce() + "/bin/sleep 0.2\nexit 0\n");
        var events = new Events();
        QuickTunnelProcess owner = start(fixture, events);
        ProcessHandle child = child(fixture);
        events.awaitExit("Quick Tunnel exited.");
        assertThat(owner.isAlive()).isFalse();
        assertThat(child.isAlive()).isFalse();
        assertThat(events.origins).containsExactly(PUBLIC);
    }

    private QuickTunnelProcess start(Fixture fixture, Events events) throws IOException {
        return start(fixture, events::announced, events::exited);
    }

    private QuickTunnelProcess start(Fixture fixture, Consumer<URI> announced,
                                     Consumer<QuickTunnelProcess.Exit> exited) throws IOException {
        QuickTunnelProcess owner = QuickTunnelProcess.start(fixture.executable(), LOOPBACK, SECRET, announced, exited);
        owners.add(owner);
        ProcessHandle.of(owner.pid()).ifPresent(handles::add);
        return owner;
    }

    private Fixture fixture(String body) throws IOException {
        Path directory = Files.createTempDirectory(temporary, "fixture ' $(exit 91) `exit 92` with spaces-",
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        Path executable = directory.resolve("cloudflared");
        Files.writeString(directory.resolve("origin"), PUBLIC + "\n");
        Files.writeString(executable, "#!/bin/sh\nfixture=${0%/*}\n"
                + "IFS= read -r public_origin < \"$fixture/origin\"\n"
                + "printf '%s\\n' \"$$\" > \"$fixture/pid\"\n"
                + "pwd -P > \"$fixture/work\"\n"
                + "printf '%s\\n' \"$@\" > \"$fixture/args\"\n" + body);
        Files.setPosixFilePermissions(executable, PosixFilePermissions.fromString("rwx------"));
        var fixture = new Fixture(directory, executable);
        fixtures.add(fixture);
        return fixture;
    }

    private ProcessHandle child(Fixture fixture) throws Exception {
        awaitFile(fixture.path("child-pid"));
        ProcessHandle child = ProcessHandle.of(Long.parseLong(Files.readString(fixture.path("child-pid")).strip())).orElseThrow();
        handles.add(child);
        return child;
    }

    private Path privateDirectory(Fixture fixture) throws Exception {
        awaitFile(fixture.path("work"));
        return Path.of(Files.readString(fixture.path("work")).strip());
    }

    private static void awaitFile(Path path) {
        await().pollInterval(Duration.ofMillis(10)).atMost(WAIT).until(() -> Files.exists(path) && Files.size(path) > 0);
    }

    private static String announce() { return "printf '%s\\n' \"$public_origin\"\n"; }

    private static Map<String, String> environment(Path file) throws IOException {
        var result = new HashMap<String, String>();
        for (String entry : Files.readString(file, StandardCharsets.UTF_8).split("\u0000")) {
            int separator = entry.indexOf('=');
            result.put(entry.substring(0, separator), entry.substring(separator + 1));
        }
        return result;
    }

    private static void assertMode(Path path, String mode) throws IOException {
        assertThat(Files.getPosixFilePermissions(path)).isEqualTo(PosixFilePermissions.fromString(mode));
    }

    private static void assertSanitized(Throwable failure, String message) {
        assertThat(failure.getMessage()).isEqualTo(message);
        assertThat(failure.getCause()).isNull();
        assertThat(failure.getSuppressed()).isEmpty();
    }

    private record Fixture(Path directory, Path executable) {
        Path path(String name) { return directory.resolve(name); }
    }

    private static final class Events {
        private final List<URI> origins = new CopyOnWriteArrayList<>();
        private final List<QuickTunnelProcess.Exit> exits = new CopyOnWriteArrayList<>();
        private final List<String> order = new CopyOnWriteArrayList<>();
        private final CountDownLatch ended = new CountDownLatch(1);

        private void announced(URI origin) { origins.add(origin); order.add("announced"); }

        private void exited(QuickTunnelProcess.Exit exit) {
            exits.add(exit);
            order.add("exited");
            ended.countDown();
        }

        private void awaitExit(String reason) throws InterruptedException {
            assertThat(ended.await(10, TimeUnit.SECONDS)).as("exit callback completes").isTrue();
            assertThat(exits).containsExactly(new QuickTunnelProcess.Exit(reason));
        }
    }

    /** A separate JVM supplies only synthetic parent environment values; it never contacts a service. */
    public static final class EnvironmentProbe {
        public static void main(String[] args) throws Exception {
            Path executable = Path.of(args[0]);
            if (!QuickTunnelProcess.findExecutable(null).equals(java.util.Optional.of(executable))
                    || !QuickTunnelProcess.findExecutable(" ").equals(java.util.Optional.of(executable))
                    || QuickTunnelProcess.findExecutable(executable.resolveSibling("missing").toString()).isPresent())
                throw new AssertionError("Executable discovery failed.");
            var announcement = new CountDownLatch(1);
            var exit = new CountDownLatch(1);
            try (var owner = QuickTunnelProcess.start(executable, LOOPBACK, SECRET,
                    ignored -> announcement.countDown(), ignored -> exit.countDown())) {
                if (!announcement.await(5, TimeUnit.SECONDS)) throw new AssertionError("Announcement missing.");
                owner.close();
                if (!exit.await(5, TimeUnit.SECONDS) || owner.isAlive()) throw new AssertionError("Cleanup failed.");
            }
            System.out.print("OK");
        }
    }

    /** Owns a fake tunnel until the test kills this JVM without executing any Java cleanup. */
    public static final class ParentDeathProbe {
        public static void main(String[] args) throws Exception {
            Path fixture = Path.of(args[1]);
            Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                try { Files.writeString(fixture.resolve("shutdown-hook"), "ran"); }
                catch (IOException failure) { throw new java.io.UncheckedIOException(failure); }
            }));
            var announcement = new CountDownLatch(1);
            try (var owner = QuickTunnelProcess.start(Path.of(args[0]), LOOPBACK, SECRET,
                    ignored -> announcement.countDown(), ignored -> {})) {
                if (!announcement.await(5, TimeUnit.SECONDS)) throw new AssertionError("Announcement missing.");
                Files.writeString(fixture.resolve("ready"), Long.toString(owner.pid()));
                new CountDownLatch(1).await();
            }
        }
    }
}
