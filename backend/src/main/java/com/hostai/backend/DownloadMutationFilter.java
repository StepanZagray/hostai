package com.hostai.backend;

import java.net.URI;
import java.util.List;
import java.util.Locale;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import org.springframework.web.util.pattern.PathPattern;
import org.springframework.web.util.pattern.PathPatternParser;
import reactor.core.publisher.Mono;

/** Loopback Host validation and browser download mutation checks; grants no CORS origins. */
@Component
@Order(-100)
public final class DownloadMutationFilter implements WebFilter {
    private static final PathPattern DOWNLOADS = PathPatternParser.defaultInstance.parse("/api/model-downloads/**");

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        var request = exchange.getRequest();
        // The socket bind alone does not reject a DNS-rebound browser origin.
        if (!List.of("127.0.0.1", "localhost", "[::1]").contains(request.getURI().getHost())) return denied();
        if (request.getMethod() != HttpMethod.POST
                || !DOWNLOADS.matches(request.getPath().pathWithinApplication())) {
            return chain.filter(exchange);
        }
        List<String> sites = request.getHeaders().get("Sec-Fetch-Site");
        if (sites != null && (sites.size() != 1 || !List.of("same-origin", "same-site", "none")
                .contains(sites.getFirst().toLowerCase(Locale.ROOT)))) return denied();
        List<String> origins = request.getHeaders().get("Origin");
        if (origins != null && (origins.size() != 1 || !sameOrigin(origins.getFirst(), request.getURI()))) return denied();
        try {
            List<String> types = request.getHeaders().get("Content-Type");
            MediaType type = request.getHeaders().getContentType();
            if (types == null || types.size() != 1 || type == null
                    || !type.getType().equalsIgnoreCase("application") || !type.getSubtype().equalsIgnoreCase("json")) {
                return Mono.error(new ResponseStatusException(HttpStatus.UNSUPPORTED_MEDIA_TYPE));
            }
        } catch (IllegalArgumentException error) {
            return Mono.error(new ResponseStatusException(HttpStatus.UNSUPPORTED_MEDIA_TYPE));
        }
        return chain.filter(exchange);
    }

    private static boolean sameOrigin(String value, URI target) {
        try {
            URI origin = URI.create(value);
            return ("http".equalsIgnoreCase(origin.getScheme()) || "https".equalsIgnoreCase(origin.getScheme()))
                    && origin.getHost() != null && origin.getRawUserInfo() == null
                    && origin.getRawPath().isEmpty() && origin.getRawQuery() == null && origin.getRawFragment() == null
                    && origin.getPort() != 0 && origin.getPort() <= 65535
                    && origin.getScheme().equalsIgnoreCase(target.getScheme())
                    && origin.getHost().equalsIgnoreCase(target.getHost()) && port(origin) == port(target);
        } catch (IllegalArgumentException error) { return false; }
    }

    private static int port(URI uri) {
        return uri.getPort() != -1 ? uri.getPort() : "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }

    private static Mono<Void> denied() { return Mono.error(new ResponseStatusException(HttpStatus.FORBIDDEN)); }
}
