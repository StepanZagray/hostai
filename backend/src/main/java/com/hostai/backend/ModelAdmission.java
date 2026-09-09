package com.hostai.backend;

import java.util.regex.Pattern;

/** Known gateway restrictions only; accepting a name does not prove model capabilities. */
final class ModelAdmission {
    private static final Pattern NAME = Pattern.compile("[a-zA-Z0-9][a-zA-Z0-9._:/-]*");

    private ModelAdmission() {}

    static String reason(String name) {
        if (name == null || name.isBlank()) return "A model name is required.";
        if (name.length() > 128) return "This model name exceeds the gateway's 128-character limit.";
        if (!NAME.matcher(name).matches()) return "This model name is not supported by the gateway.";
        if (name.endsWith(":cloud") || name.endsWith("-cloud"))
            return "Cloud models are not supported by this local gateway.";
        return null;
    }
}
