package com.hostai.backend;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.reactive.function.client.ClientResponse;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

class ChatServiceTest {
    private final InferenceRegistry registry = new InferenceRegistry();
    private final Api.ChatRequest request = new Api.ChatRequest("test-model:small",
            List.of(new Api.Message("user", "Test only")), 0.7, 128);

    private ChatService service(String records) {
        WebClient client = WebClient.builder().exchangeFunction(ignored -> Mono.just(
                ClientResponse.create(HttpStatus.OK)
                        .header("Content-Type", "application/x-ndjson")
                        .body(records).build())).build();
        OllamaGateway gateway = new OllamaGateway(client, Schedulers.immediate(),
                Duration.ofSeconds(3), Duration.ofSeconds(3), Duration.ofSeconds(5));
        return new ChatService(registry, gateway);
    }

    @Test void stoppingAtTerminalRecordPreservesCompletionAndTokens() {
        Api.ChatChunk chunk = service("""
                {"message":{"content":"Done"},"done":true,"eval_count":7}
                """).chat(request).take(1).blockLast(Duration.ofSeconds(2));
        assertNotNull(chunk);
        assertEquals(true, chunk.done());
        assertEquals("completed", registry.requests().getFirst().status());
        assertEquals(7L, registry.requests().getFirst().outputTokens());
        assertEquals(new InferenceRegistry.Counters(0, 1, 0), registry.counters());
    }

    @Test void stoppingBeforeTerminalRecordRemainsCancelled() {
        service("""
                {"message":{"content":"Partial"},"done":false}
                {"message":{"content":"Done"},"done":true,"eval_count":7}
                """).chat(request).take(1).blockLast(Duration.ofSeconds(2));
        assertEquals("cancelled", registry.requests().getFirst().status());
        assertNull(registry.requests().getFirst().outputTokens());
        assertEquals(new InferenceRegistry.Counters(0, 1, 0), registry.counters());
    }

    @Test void stoppingAtTerminalRecordAfterPartialContentPreservesCompletion() {
        service("""
                {"message":{"content":"Partial"},"done":false}
                {"message":{"content":"Done"},"done":true,"eval_count":7}
                """).chat(request).take(2).blockLast(Duration.ofSeconds(2));
        assertEquals("completed", registry.requests().getFirst().status());
        assertEquals(7L, registry.requests().getFirst().outputTokens());
        assertEquals(new InferenceRegistry.Counters(0, 1, 0), registry.counters());
    }

    @Test void terminalRecordWithoutTokensStillCompletes() {
        service("""
                {"done":true}
                """).chat(request).take(1).blockLast(Duration.ofSeconds(2));
        assertEquals("completed", registry.requests().getFirst().status());
        assertNull(registry.requests().getFirst().outputTokens());
        assertEquals(new InferenceRegistry.Counters(0, 1, 0), registry.counters());
    }

    @Test void stoppingOnTerminalErrorPreservesFailure() {
        Api.ChatChunk chunk = service("""
                {"message":{"content":"Partial"},"done":false}
                {"error":"private upstream detail"}
                """).chat(request).take(2).blockLast(Duration.ofSeconds(2));
        assertNotNull(chunk);
        assertNotNull(chunk.error());
        assertEquals("failed", registry.requests().getFirst().status());
        assertNull(registry.requests().getFirst().outputTokens());
        assertEquals(new InferenceRegistry.Counters(0, 1, 1), registry.counters());
    }
}
