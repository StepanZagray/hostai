package com.hostai.backend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The Java publisher must interoperate with the actual Node registry, not only a Java fixture. */
class DirectoryIntegrationTest {
    @TempDir Path temporary;

    @Test void actualRegistryAcceptsJavaIdentityHeartbeatWithdrawalAndExplicitRepublishing() throws Exception {
        Path module = Path.of(System.getProperty("user.dir")).resolve("../apps/directory/server.mjs").normalize();
        Path storeModule = module.resolveSibling("store.mjs");
        Path output = temporary.resolve("registry-port");
        Path errors = temporary.resolve("registry-errors");
        String source = "const {createDirectoryServer}=await import(process.argv[1]);"
                + "const {DirectoryStore}=await import(process.argv[2]);"
                + "const store=new DirectoryStore(process.argv[3]);"
                + "const server=createDirectoryServer({store,keyAdmission:{capacity:12,refillMs:10000,maxKeys:1024}});"
                + "process.on('SIGTERM',()=>{server.close(()=>store.close());server.closeAllConnections();});"
                + "server.listen(0,'127.0.0.1',()=>process.stdout.write(String(server.address().port)));";
        var builder = new ProcessBuilder("node", "--input-type=module", "-e", source,
                module.toUri().toString(), storeModule.toUri().toString(), temporary.resolve("registry").toString());
        builder.environment().clear();
        builder.environment().put("PATH", System.getenv("PATH"));
        builder.redirectOutput(output.toFile()).redirectError(errors.toFile());
        Process registry = builder.start();
        try {
            await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> {
                assertThat(registry.isAlive()).isTrue();
                assertThat(Files.readString(output)).matches("[1-9][0-9]{0,4}");
            });
            String origin = "http://127.0.0.1:" + Files.readString(output);
            var configuration = DirectoryClient.Configuration.parse(origin, "true");
            var client = new DirectoryClient(configuration);
            var transport = new DirectoryPublicationTest.Transport();
            transport.emit("live", 1, DirectoryClientTest.GUEST);
            String access = temporary.resolve("access").toString();
            String identity;
            try (var directory = new DirectoryPublication(configuration,
                    () -> new DirectoryPublication.Shared(true, "Cross-stack fixture", "fixture:small"),
                    transport.internet, () -> DirectoryPublication.openIdentity(access))) {
                assertThat(client.listings().listings()).isEmpty();
                directory.start();
                listed(directory);
                identity = directory.status().identityId();
                assertThat(client.listings().listings()).singleElement().satisfies(row -> {
                    assertThat(row.id()).isEqualTo(identity);
                    assertThat(row.hostLabel()).isEqualTo("Cross-stack fixture");
                    assertThat(row.guestUrl()).isEqualTo(DirectoryClientTest.GUEST);
                    assertThat(row.invitationRequired()).isTrue();
                });
                long first = directory.status().updatedAt();
                transport.emit("live", 1, DirectoryClientTest.GUEST);
                await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(directory.status().updatedAt()).isGreaterThan(first));
                directory.stop();
                off(directory);
                assertThat(client.listings().listings()).isEmpty();
                assertThat(transport.internet.observation().status().state()).isEqualTo("live");
                directory.start(); listed(directory);
                transport.emit("live", 2, "https://changed-fixture.trycloudflare.com/");
                off(directory);
                assertThat(client.listings().listings()).isEmpty();
                assertThat(directory.status().enabled()).isFalse();
            }
            // Reopening retains the signing identity and begins with no publication intent.
            try (var directory = new DirectoryPublication(configuration,
                    () -> new DirectoryPublication.Shared(true, "Cross-stack fixture", "fixture:small"),
                    transport.internet, () -> DirectoryPublication.openIdentity(access))) {
                assertThat(directory.status().enabled()).isFalse();
                assertThat(client.listings().listings()).isEmpty();
                directory.start(); listed(directory);
                assertThat(directory.status().identityId()).isEqualTo(identity);
            }
            assertThat(client.listings().listings()).isEmpty();
        } finally {
            registry.destroy();
            if (!registry.waitFor(5, TimeUnit.SECONDS)) {
                registry.destroyForcibly();
                assertThat(registry.waitFor(5, TimeUnit.SECONDS)).isTrue();
            }
            assertThat(registry.isAlive()).isFalse();
        }
    }

    private static void listed(DirectoryPublication directory) {
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(directory.status().state()).isEqualTo("listed"));
    }
    private static void off(DirectoryPublication directory) {
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(directory.status().state()).isEqualTo("off"));
    }
}
