package com.hostai.backend;

import java.util.Set;
import tools.jackson.databind.JsonNode;

/** Required machine-readable guidance for opaque inference, independent of its visual UI. */
final class InteractionContract {
    private static final Set<String> TYPES = Set.of("object", "array", "string", "number", "integer", "boolean", "null");
    private InteractionContract() {}

    static JsonNode validate(JsonNode value) {
        if (value == null || value.isNull()) return null;
        if (!value.isObject() || !text(value.get("instructions"), 16_384)
                || !schema(value.get("inputSchema")) || !schema(value.get("outputSchema"))) throw HostAiRuntime.invalidResponse();
        JsonNode examples = value.get("examples");
        if (examples == null || !examples.isArray() || examples.isEmpty() || examples.size() > 8) throw HostAiRuntime.invalidResponse();
        for (JsonNode example : examples) {
            if (!example.isObject() || !text(example.get("description"), 1024)
                    || !example.has("input") || !example.has("output")) throw HostAiRuntime.invalidResponse();
        }
        return value;
    }

    private static boolean schema(JsonNode value) {
        return value != null && value.isObject() && value.has("type") && value.get("type").isString()
                && TYPES.contains(value.get("type").asString()) && text(value.get("description"), 4096);
    }

    private static boolean text(JsonNode value, int max) {
        if (value == null || !value.isString()) return false;
        String text = value.asString();
        return !text.isBlank() && text.codePointCount(0, text.length()) <= max;
    }
}
