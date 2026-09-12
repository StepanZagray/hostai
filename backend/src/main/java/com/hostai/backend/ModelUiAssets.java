package com.hostai.backend;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;
import org.springframework.core.io.ClassPathResource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import reactor.core.publisher.Mono;

/** Path, type and header rules shared by the owner and guest model-UI asset routes. */
final class ModelUiAssets {
    static final int MAX_ASSET_BYTES = 8 * 1024 * 1024;
    static final int MAX_SEGMENTS = 8;
    static final String BRIDGE = "hostai-bridge.js";
    static final Pattern RUNTIME_ID = Pattern.compile("[a-z0-9][a-z0-9-]{0,31}");
    private static final Pattern SEGMENT = Pattern.compile("[A-Za-z0-9._-]+");
    private static final Map<String, MediaType> TYPES = Map.ofEntries(
            Map.entry("html", MediaType.parseMediaType("text/html;charset=utf-8")),
            Map.entry("js", MediaType.parseMediaType("text/javascript;charset=utf-8")),
            Map.entry("mjs", MediaType.parseMediaType("text/javascript;charset=utf-8")),
            Map.entry("css", MediaType.parseMediaType("text/css;charset=utf-8")),
            Map.entry("json", MediaType.APPLICATION_JSON),
            Map.entry("svg", MediaType.parseMediaType("image/svg+xml")),
            Map.entry("png", MediaType.IMAGE_PNG),
            Map.entry("jpg", MediaType.IMAGE_JPEG),
            Map.entry("jpeg", MediaType.IMAGE_JPEG),
            Map.entry("gif", MediaType.IMAGE_GIF),
            Map.entry("webp", MediaType.parseMediaType("image/webp")),
            Map.entry("ico", MediaType.parseMediaType("image/x-icon")),
            Map.entry("woff", MediaType.parseMediaType("font/woff")),
            Map.entry("woff2", MediaType.parseMediaType("font/woff2")),
            Map.entry("wasm", MediaType.parseMediaType("application/wasm")),
            Map.entry("txt", MediaType.parseMediaType("text/plain;charset=utf-8")),
            Map.entry("map", MediaType.APPLICATION_JSON));
    private static volatile byte[] bridge;

    private ModelUiAssets() {}

    record Asset(byte[] bytes, MediaType type) {}

    /** Splits a relative path (no leading slash) into 1..8 plain segments, or returns null. */
    static List<String> segments(String path) {
        if (path == null || path.isEmpty() || path.length() > 1024) return null;
        String[] parts = path.split("/", -1);
        if (parts.length > MAX_SEGMENTS) return null;
        for (String part : parts) {
            if (part.equals(".") || part.equals("..") || !SEGMENT.matcher(part).matches()) return null;
        }
        return List.of(parts);
    }

    /** A manifest entry is absolute; returns it relative to the runtime origin, or null when invalid. */
    static String entry(String value) {
        if (value == null || !value.startsWith("/") || value.contains("?") || value.contains("#")) return null;
        String relative = value.substring(1);
        return segments(relative) == null ? null : relative;
    }

    /** The directory prefix that contains {@code entry}: "ui/" for "ui/index.html", "" at the origin root. */
    static String root(String entry) {
        int slash = entry.lastIndexOf('/');
        return slash < 0 ? "" : entry.substring(0, slash + 1);
    }

    static MediaType contentType(String lastSegment) {
        int dot = lastSegment.lastIndexOf('.');
        if (dot <= 0 || dot == lastSegment.length() - 1) return null;
        return TYPES.get(lastSegment.substring(dot + 1).toLowerCase(Locale.ROOT));
    }

    static String csp(String origin) {
        return "default-src 'none'; script-src 'self' " + origin + "; style-src 'self' 'unsafe-inline' " + origin
                + "; img-src 'self' data: blob: " + origin + "; font-src 'self' " + origin
                + "; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self' " + origin;
    }

    /** Browser-facing headers for every model-UI response. Intentionally no X-Frame-Options. */
    static void headers(HttpHeaders headers, String origin) {
        headers.setCacheControl("no-store");
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("Referrer-Policy", "no-referrer");
        headers.set("Content-Security-Policy", csp(origin));
    }

    static byte[] bridge() {
        byte[] cached = bridge;
        if (cached == null) {
            try { cached = new ClassPathResource("hostai/hostai-bridge.js").getContentAsByteArray(); }
            catch (IOException error) { throw new UncheckedIOException(error); }
            bridge = cached;
        }
        return cached;
    }

    /**
     * Resolves one browser request against a runtime: validated path, allow-listed extension, the
     * gateway's own bridge script, and otherwise a proxied file under the runtime's UI root.
     */
    static Mono<Asset> serve(InferenceRuntime runtime, String path) {
        List<String> segments = segments(path);
        if (segments == null) return Mono.error(notFound());
        String last = segments.getLast();
        MediaType type = contentType(last);
        if (type == null) return Mono.error(notFound());
        if (last.equals(BRIDGE)) return Mono.just(new Asset(bridge(), type));
        Api.ModelUi ui = runtime.ui();
        if (ui == null || !path.startsWith(root(ui.entry()))) return Mono.error(notFound());
        return runtime.asset(path).map(bytes -> new Asset(bytes, type)).switchIfEmpty(Mono.error(ModelUiAssets::notFound));
    }

    static GatewayException notFound() {
        return new GatewayException(HttpStatus.NOT_FOUND, "The requested model-UI asset does not exist.");
    }
}
