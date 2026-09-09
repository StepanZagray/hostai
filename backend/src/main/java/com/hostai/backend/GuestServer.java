package com.hostai.backend;

import java.time.Duration;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeoutException;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;
import org.springframework.core.io.buffer.DataBufferLimitException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.MediaTypeFactory;
import org.springframework.http.ProblemDetail;
import org.springframework.http.codec.json.JacksonJsonDecoder;
import org.springframework.http.codec.json.JacksonJsonEncoder;
import org.springframework.http.server.reactive.ReactorHttpHandlerAdapter;
import org.springframework.web.ErrorResponse;
import org.springframework.web.reactive.function.server.HandlerStrategies;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.reactive.function.server.ServerResponse;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Scheduler;
import reactor.netty.Connection;
import reactor.netty.DisposableServer;
import reactor.netty.http.server.HttpServer;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.json.JsonMapper;

import static org.springframework.web.reactive.function.server.RequestPredicates.GET;
import static org.springframework.web.reactive.function.server.RequestPredicates.POST;

/** A separate HTTP handler graph: owner controllers and their proxy cannot be routed here. */
final class GuestServer implements AutoCloseable {
    private final DisposableServer listener;
    private final Set<Connection> connections;

    private GuestServer(DisposableServer listener, Set<Connection> connections) {
        this.listener = listener; this.connections = connections;
    }

    static GuestServer start(SharingService sharing, JsonMapper mapper, Scheduler scheduler, int port) {
        if (!new ClassPathResource("guest/guest.html").isReadable())
            throw new GatewayException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Build the client page with pnpm build, then rebuild or restart the Java gateway.");
        JsonMapper json = mapper.rebuild().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT).build();
        var routes = RouterFunctions.route(GET("/"), request -> asset(new ClassPathResource("guest/guest.html"), false))
                .andRoute(GET("/assets/{file}"), request -> {
                    String file = request.pathVariable("file");
                    if (!file.matches("[a-zA-Z0-9][a-zA-Z0-9._-]*") || file.contains(".."))
                        return ServerResponse.notFound().build();
                    return asset(new ClassPathResource("guest/assets/" + file), true);
                })
                .andRoute(GET("/guest/v1/session"), request -> {
                    String token = bearer(request);
                    return sharing.session(token).flatMap(session -> ServerResponse.ok().contentType(MediaType.APPLICATION_JSON).bodyValue(session));
                })
                .andRoute(POST("/guest/v1/chat"), request -> {
                    String token = bearer(request);
                    sharing.authenticate(token); // Reject credentials before accepting a potentially large upload.
                    if (request.headers().header(HttpHeaders.CONTENT_TYPE).size() != 1
                            || !request.headers().contentType().map(type -> type.getType().equalsIgnoreCase("application")
                                    && type.getSubtype().equalsIgnoreCase("json")).orElse(false))
                        return Mono.error(new GatewayException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "JSON is required."));
                    return request.bodyToMono(Api.ChatRequest.class).timeout(Duration.ofSeconds(10))
                            .switchIfEmpty(Mono.error(new GatewayException(HttpStatus.BAD_REQUEST, "A chat request is required.")))
                            .flatMap(body -> {
                                return ServerResponse.ok().contentType(MediaType.APPLICATION_NDJSON)
                                        .body(sharing.chat(token, body), Api.ChatChunk.class);
                            });
                });
        HandlerStrategies strategies = HandlerStrategies.builder()
                .codecs(codecs -> {
                    codecs.defaultCodecs().maxInMemorySize(BackendConfiguration.MAX_BODY_BYTES);
                    codecs.defaultCodecs().enableLoggingRequestDetails(false);
                    codecs.defaultCodecs().jacksonJsonDecoder(new JacksonJsonDecoder(json));
                    codecs.defaultCodecs().jacksonJsonEncoder(new JacksonJsonEncoder(json));
                })
                .webFilter((exchange, chain) -> {
                    var headers = exchange.getResponse().getHeaders();
                    headers.setCacheControl("no-store");
                    headers.set("X-Content-Type-Options", "nosniff");
                    headers.set("Referrer-Policy", "no-referrer");
                    headers.set("X-Frame-Options", "DENY");
                    headers.set("Cross-Origin-Resource-Policy", "same-origin");
                    headers.set("X-Accel-Buffering", "no");
                    headers.set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; "
                            + "font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; "
                            + "frame-ancestors 'none'; form-action 'self'");
                    String host = exchange.getRequest().getURI().getHost();
                    if (host == null || !List.of("127.0.0.1", "localhost", "[::1]").contains(host))
                        return problem(exchange, new GatewayException(HttpStatus.FORBIDDEN, "Local preview access only."), json);
                    return Mono.defer(() -> chain.filter(exchange)).subscribeOn(scheduler);
                })
                .exceptionHandler((exchange, error) -> problem(exchange, error, json))
                .build();
        Set<Connection> connections = ConcurrentHashMap.newKeySet();
        try {
            DisposableServer listener = HttpServer.create().host("127.0.0.1").port(port)
                    .httpRequestDecoder(decoder -> decoder.maxInitialLineLength(4096).maxHeaderSize(8192))
                    .idleTimeout(Duration.ofMinutes(11))
                    .doOnConnection(connection -> {
                        connections.add(connection);
                        connection.onDispose().doFinally(ignored -> connections.remove(connection)).subscribe();
                        if (connections.size() > 64) connection.dispose();
                    })
                    .handle(new ReactorHttpHandlerAdapter(RouterFunctions.toHttpHandler(routes, strategies)))
                    .bindNow(Duration.ofSeconds(5));
            return new GuestServer(listener, connections);
        } catch (RuntimeException error) {
            connections.forEach(Connection::dispose);
            throw new GatewayException(HttpStatus.SERVICE_UNAVAILABLE, "The local client port could not be opened. Check whether another workspace is using it.");
        }
    }

    private static String bearer(ServerRequest request) {
        List<String> values = request.headers().header(HttpHeaders.AUTHORIZATION);
        if (values.size() != 1) throw SharingService.unauthorized();
        String header = values.getFirst();
        if (!header.regionMatches(true, 0, "Bearer ", 0, 7) || header.length() > 263)
            throw SharingService.unauthorized();
        return header.substring(7);
    }

    private static Mono<ServerResponse> asset(Resource resource, boolean immutable) {
        if (!resource.isReadable()) return ServerResponse.notFound().build();
        return ServerResponse.ok()
                .header(HttpHeaders.CACHE_CONTROL, immutable ? "public, max-age=31536000, immutable" : "no-store")
                .contentType(MediaTypeFactory.getMediaType(resource).orElse(MediaType.APPLICATION_OCTET_STREAM))
                .bodyValue(resource);
    }

    private static Mono<Void> problem(ServerWebExchange exchange, Throwable error, JsonMapper json) {
        if (exchange.getResponse().isCommitted()) return Mono.error(error);
        HttpStatusCode status = HttpStatus.INTERNAL_SERVER_ERROR;
        String detail = "The client request could not be completed.";
        int retryAfter = 0;
        if (error instanceof GatewayException gateway) { status = gateway.status(); detail = gateway.getMessage(); }
        else if (error instanceof SharingService.GuestBusyException busy) {
            status = HttpStatus.TOO_MANY_REQUESTS; detail = busy.getMessage(); retryAfter = busy.retryAfter;
        } else if (error instanceof InferenceRegistry.OverloadedException) {
            status = HttpStatus.TOO_MANY_REQUESTS; detail = "The host is busy. Try again after a request finishes."; retryAfter = 1;
        } else if (error instanceof ChatService.AccessEndedException) {
            status = HttpStatus.UNAUTHORIZED; detail = SharingService.unauthorized().getMessage();
        } else if (error instanceof TimeoutException) {
            status = HttpStatus.REQUEST_TIMEOUT; detail = "The request upload timed out.";
        } else if (error instanceof ErrorResponse response) {
            status = response.getStatusCode();
            detail = switch (status.value()) {
                case 400 -> "Invalid client request.";
                case 404 -> "The requested endpoint does not exist.";
                case 405 -> "This method is not supported.";
                case 415 -> "JSON is required.";
                default -> "The client request could not be completed.";
            };
        }
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            if (cause instanceof DataBufferLimitException) {
                status = HttpStatus.PAYLOAD_TOO_LARGE; detail = "The request exceeds 262144 bytes."; break;
            }
        }
        var response = exchange.getResponse();
        response.setStatusCode(status);
        response.getHeaders().setContentType(MediaType.APPLICATION_PROBLEM_JSON);
        response.getHeaders().setCacheControl("no-store");
        if (retryAfter > 0) response.getHeaders().set(HttpHeaders.RETRY_AFTER, Integer.toString(retryAfter));
        if (status.value() == 401) response.getHeaders().set(HttpHeaders.WWW_AUTHENTICATE, "Bearer");
        if (exchange.getRequest().getMethod().name().equals("POST") && status.is4xxClientError())
            response.getHeaders().set(HttpHeaders.CONNECTION, "close");
        return response.writeWith(Mono.just(response.bufferFactory().wrap(
                json.writeValueAsBytes(ProblemDetail.forStatusAndDetail(status, detail)))));
    }

    String origin() { return "http://127.0.0.1:" + listener.port(); }

    @Override public void close() {
        connections.forEach(Connection::dispose);
        listener.disposeNow(Duration.ofSeconds(5));
    }
}
