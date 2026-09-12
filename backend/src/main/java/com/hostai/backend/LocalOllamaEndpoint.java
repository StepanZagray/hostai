package com.hostai.backend;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Set;

/** Validates an origin without DNS; localhost is pinned to IPv4 loopback. */
public record LocalOllamaEndpoint(String displayUrl, URI requestUrl) {
    public static LocalOllamaEndpoint parse(String value) { return parse(value, "HOSTAI_OLLAMA_URL"); }

    /** Same rules for every configured runtime origin; {@code setting} names the variable in errors. */
    public static LocalOllamaEndpoint parse(String value, String setting) {
        try {
            URI uri = new URI(value);
            String host = uri.getHost();
            if (!Set.of("http", "https").contains(uri.getScheme() == null ? "" : uri.getScheme())
                    || host == null || !Set.of("localhost", "127.0.0.1", "[::1]").contains(host)
                    || uri.getRawUserInfo() != null || uri.getRawQuery() != null
                    || uri.getRawFragment() != null
                    || !(uri.getRawPath().isEmpty() || uri.getRawPath().equals("/"))
                    || uri.getPort() == 0 || uri.getPort() > 65535) {
                throw new IllegalArgumentException(setting + " must be a loopback HTTP(S) origin without credentials, path, query, or fragment");
            }
            URI pinned = new URI(uri.getScheme(), null,
                    host.equals("localhost") ? "127.0.0.1" : host, uri.getPort(), null, null, null);
            String display = value.endsWith("/") ? value.substring(0, value.length() - 1) : value;
            return new LocalOllamaEndpoint(display, pinned);
        } catch (URISyntaxException | NullPointerException e) {
            throw new IllegalArgumentException(setting + " must be a valid loopback HTTP(S) origin");
        }
    }
}
