package com.hostai.backend;

import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.core.io.buffer.DataBufferLimitException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.reactive.result.method.annotation.ResponseEntityExceptionHandler;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.ServerWebInputException;
import org.springframework.web.server.ResponseStatusException;
import reactor.core.publisher.Mono;

@RestControllerAdvice
@Order(Ordered.HIGHEST_PRECEDENCE)
public class ApiErrors extends ResponseEntityExceptionHandler {
    @ExceptionHandler(GatewayException.class)
    public ResponseEntity<ProblemDetail> gateway(GatewayException error) {
        return problem(error.status(), error.getMessage());
    }

    @ExceptionHandler(InferenceRegistry.OverloadedException.class)
    public ResponseEntity<ProblemDetail> overload(InferenceRegistry.OverloadedException error) {
        return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
                .contentType(MediaType.APPLICATION_PROBLEM_JSON)
                .header(HttpHeaders.RETRY_AFTER, "1")
                .body(ProblemDetail.forStatusAndDetail(HttpStatus.TOO_MANY_REQUESTS, error.getMessage()));
    }

    @ExceptionHandler(DataBufferLimitException.class)
    public ResponseEntity<ProblemDetail> tooLarge() {
        return problem(HttpStatus.PAYLOAD_TOO_LARGE, "Request body must not exceed 262144 bytes.");
    }

    @Override
    protected Mono<ResponseEntity<Object>> handleResponseStatusException(
            ResponseStatusException error, HttpHeaders headers, HttpStatusCode status,
            ServerWebExchange exchange) {
        if (status.value() == 413) {
            return createResponseEntity(ProblemDetail.forStatusAndDetail(status,
                    "Request body must not exceed 262144 bytes."), headers, status, exchange);
        }
        return super.handleResponseStatusException(error, headers, status, exchange);
    }

    @Override
    protected Mono<ResponseEntity<Object>> handleServerWebInputException(
            ServerWebInputException error, HttpHeaders headers, HttpStatusCode status,
            ServerWebExchange exchange) {
        Throwable cause = error;
        while (cause != null) {
            if (cause instanceof DataBufferLimitException) {
                return createResponseEntity(ProblemDetail.forStatusAndDetail(HttpStatus.PAYLOAD_TOO_LARGE,
                        "Request body must not exceed 262144 bytes."), headers,
                        HttpStatus.PAYLOAD_TOO_LARGE, exchange);
            }
            cause = cause.getCause();
        }
        String kind = exchange.getRequest().getPath().value().startsWith("/api/model-downloads")
                ? "model download" : "chat";
        return createResponseEntity(ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST,
                "Invalid " + kind + " request. Check the required fields and documented input limits."),
                headers, HttpStatus.BAD_REQUEST, exchange);
    }

    private ResponseEntity<ProblemDetail> problem(HttpStatus status, String detail) {
        return ResponseEntity.status(status).contentType(MediaType.APPLICATION_PROBLEM_JSON)
                .body(ProblemDetail.forStatusAndDetail(status, detail));
    }
}
