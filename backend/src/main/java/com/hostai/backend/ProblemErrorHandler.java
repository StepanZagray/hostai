package com.hostai.backend;

import java.net.URI;
import org.springframework.core.annotation.Order;
import org.springframework.core.io.buffer.DataBufferLimitException;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.stereotype.Component;
import org.springframework.web.ErrorResponse;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebExceptionHandler;
import reactor.core.publisher.Mono;
import tools.jackson.databind.json.JsonMapper;

/** Covers routing/filter failures outside controller advice, without leaking exception text. */
@Component
@Order(-2)
public class ProblemErrorHandler implements WebExceptionHandler {
    private final JsonMapper json;

    public ProblemErrorHandler(JsonMapper json) { this.json = json; }

    @Override
    public Mono<Void> handle(ServerWebExchange exchange, Throwable error) {
        if (exchange.getResponse().isCommitted()) return Mono.error(error);
        HttpStatusCode status = error instanceof ErrorResponse response
                ? response.getStatusCode() : HttpStatus.INTERNAL_SERVER_ERROR;
        if (error instanceof DataBufferLimitException) status = HttpStatus.PAYLOAD_TOO_LARGE;
        String detail = switch (status.value()) {
            case 400 -> "Invalid request. Check the documented API contract.";
            case 404 -> "The requested endpoint does not exist.";
            case 405 -> "This HTTP method is not supported for the endpoint.";
            case 406 -> "The requested response media type is not supported.";
            case 413 -> "Request body must not exceed 262144 bytes.";
            case 415 -> "The request must use a supported Content-Type.";
            default -> "The request could not be completed.";
        };
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(status, detail);
        problem.setInstance(URI.create(exchange.getRequest().getPath().value()));
        exchange.getResponse().setStatusCode(status);
        exchange.getResponse().getHeaders().setContentType(MediaType.APPLICATION_PROBLEM_JSON);
        return exchange.getResponse().writeWith(Mono.just(exchange.getResponse().bufferFactory()
                .wrap(json.writeValueAsBytes(problem))));
    }
}
