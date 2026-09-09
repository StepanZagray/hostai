package com.hostai.backend;

import java.net.URI;
import java.util.List;
import java.util.Locale;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping(value = "/api/directory", produces = MediaType.APPLICATION_JSON_VALUE)
final class DirectoryController {
    private final DirectoryPublication directory;
    DirectoryController(DirectoryPublication directory) { this.directory = directory; }

    @GetMapping ResponseEntity<DirectoryPublication.Status> status(ServerHttpRequest request) {
        ownerRequest(request); return response(directory.status());
    }

    @PostMapping(value = "/start", consumes = MediaType.APPLICATION_JSON_VALUE)
    ResponseEntity<DirectoryPublication.Status> start(@RequestBody byte[] body, ServerHttpRequest request) {
        ownerMutation(request); empty(body); return response(directory.start());
    }

    @PostMapping(value = "/stop", consumes = MediaType.APPLICATION_JSON_VALUE)
    ResponseEntity<DirectoryPublication.Status> stop(@RequestBody byte[] body, ServerHttpRequest request) {
        ownerMutation(request); empty(body); return response(directory.stop());
    }

    @GetMapping("/listings") ResponseEntity<?> listings(ServerHttpRequest request) {
        ownerRequest(request);
        try { return response(directory.listings()); }
        catch (RuntimeException ignored) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).cacheControl(CacheControl.noStore())
                    .contentType(MediaType.APPLICATION_PROBLEM_JSON)
                    .body(ProblemDetail.forStatusAndDetail(HttpStatus.SERVICE_UNAVAILABLE, DirectoryClient.UNAVAILABLE));
        }
    }

    // The existing global filter checks loopback Host, but its mutation paths do not include this controller.
    private static void ownerMutation(ServerHttpRequest request) {
        ownerRequest(request);
        if (request.getHeaders().getOrEmpty("Content-Type").size() != 1)
            throw new GatewayException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "Directory actions require application/json.");
    }

    private static void ownerRequest(ServerHttpRequest request) {
        var headers = request.getHeaders();
        var sites = headers.get("Sec-Fetch-Site");
        var origins = headers.get("Origin");
        if (sites != null && (sites.size() != 1 || !List.of("same-origin", "none")
                    .contains(sites.getFirst().toLowerCase(Locale.ROOT)))
                || origins != null && (origins.size() != 1 || !sameOrigin(origins.getFirst(), request.getURI()))) {
            throw new GatewayException(HttpStatus.FORBIDDEN, "Directory actions must come from the owner gateway origin.");
        }
    }

    private static boolean sameOrigin(String value, URI target) {
        try {
            URI origin = URI.create(value);
            return List.of("http", "https").contains(origin.getScheme()) && origin.getHost() != null
                    && origin.getRawUserInfo() == null && origin.getRawPath().isEmpty()
                    && origin.getRawQuery() == null && origin.getRawFragment() == null
                    && origin.getPort() != 0 && origin.getPort() <= 65535
                    && origin.getScheme().equalsIgnoreCase(target.getScheme())
                    && origin.getHost().equalsIgnoreCase(target.getHost()) && port(origin) == port(target);
        } catch (RuntimeException ignored) { return false; }
    }

    private static int port(URI origin) {
        return origin.getPort() == -1 ? "https".equalsIgnoreCase(origin.getScheme()) ? 443 : 80 : origin.getPort();
    }

    private static void empty(byte[] body) {
        try {
            if (body.length > 256) throw new IllegalArgumentException();
            var root = DirectoryClient.JSON.readTree(body);
            if (root == null || !root.isObject() || !root.isEmpty()) throw new IllegalArgumentException();
        } catch (RuntimeException ignored) {
            throw new GatewayException(HttpStatus.BAD_REQUEST, "Directory actions require an empty JSON object {}.");
        }
    }

    private static <T> ResponseEntity<T> response(T body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
    }
}
