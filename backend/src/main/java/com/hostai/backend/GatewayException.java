package com.hostai.backend;

import org.springframework.http.HttpStatus;

/** Messages are fixed and safe to return; upstream bodies and prompts are never included. */
public final class GatewayException extends RuntimeException {
    private final HttpStatus status;

    public GatewayException(HttpStatus status, String message) {
        super(message);
        this.status = status;
    }

    public HttpStatus status() { return status; }

    public static GatewayException unavailable() {
        return new GatewayException(HttpStatus.SERVICE_UNAVAILABLE, "Ollama is unavailable. Check the local Ollama service.");
    }

    public static GatewayException invalidResponse() {
        return new GatewayException(HttpStatus.BAD_GATEWAY, "Ollama returned an invalid or incomplete response.");
    }
}
