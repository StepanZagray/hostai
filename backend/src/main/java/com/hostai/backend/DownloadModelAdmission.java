package com.hostai.backend;

import java.util.Locale;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;

/** Pulls accept only explicitly tagged names in the default Ollama library. */
final class DownloadModelAdmission {
    private static final Pattern NAME = Pattern.compile(
            "(?:[a-z0-9]+(?:[-_][a-z0-9]+)*/)?[a-z0-9][a-z0-9._-]*:[a-zA-Z0-9][a-zA-Z0-9._-]*");

    private DownloadModelAdmission() {}

    static void validate(String model) {
        String reason = ModelAdmission.reason(model);
        if (reason != null) throw new GatewayException(HttpStatus.BAD_REQUEST, reason);
        String lower = model.toLowerCase(Locale.ROOT);
        String repository = lower.substring(0, lower.lastIndexOf(':') < 0 ? lower.length() : lower.lastIndexOf(':'));
        if (!NAME.matcher(model).matches() || model.contains("..") || lower.startsWith("localhost/")
                || lower.endsWith(":cloud") || lower.endsWith("-cloud") || repository.endsWith("-cloud")) {
            throw new GatewayException(HttpStatus.BAD_REQUEST,
                    "Use an explicit local library model:tag or namespace/model:tag (maximum 128 characters).");
        }
    }
}
