package com.hostai.backend;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.Valid;
import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.List;
import tools.jackson.databind.JsonNode;

public final class Api {
    private Api() {}

    public record ChatRequest(
            @NotBlank String model,
            @NotNull @Size(min = 1, max = 64) List<@NotNull @Valid Message> messages,
            @NotNull @DecimalMin("0.0") @DecimalMax("2.0") Double temperature,
            @NotNull @Min(1) @Max(8192) Integer maxTokens) {
        @AssertTrue(message = "Total message content must not exceed 65536 characters")
        @JsonIgnore
        public boolean isContentWithinLimit() {
            return messages == null || messages.stream().filter(m -> m != null && m.content() != null)
                    .mapToLong(m -> m.content().length()).sum() <= 65_536;
        }

        @AssertTrue(message = "Temperature must be finite")
        @JsonIgnore
        public boolean isTemperatureFinite() {
            return temperature == null || Double.isFinite(temperature);
        }

        @AssertTrue(message = "This model name is not supported by the local gateway")
        @JsonIgnore
        public boolean isModelSupported() {
            return ModelAdmission.reason(model) == null;
        }
    }

    public record Message(
            @NotNull @Pattern(regexp = "user|assistant|system") String role,
            @NotBlank @Size(max = 16_384) String content) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ChatChunk(String content, boolean done, Long outputTokens, String error) {
        public static ChatChunk error(String message) {
            return new ChatChunk("", true, null, message);
        }
    }

    public record Status(String status, boolean ollamaConnected, String ollamaUrl,
                         String version, String javaVersion, long uptimeSeconds,
                         int activeRequests, int maxConcurrentRequests,
                         long totalRequests, long failedRequests) {}

    /** Where a model's own user interface lives; null when the model uses the default chat panel. */
    public record ModelUi(String runtime, String entry) {}

    /** Supported wire contracts, independent of presentation or who implements an agent loop. */
    public record Capabilities(boolean chat, boolean infer) {
        public static final Capabilities CHAT = new Capabilities(true, false);
        public static final Capabilities INFER = new Capabilities(false, true);
        public static final Capabilities NONE = new Capabilities(false, false);
    }

    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Model(String name, long sizeBytes, String parameterSize,
                        String quantization, String modifiedAt, String chatUnavailableReason, ModelUi ui,
                        Capabilities capabilities, JsonNode interaction) {
        public Model(String name, long sizeBytes, String parameterSize, String quantization, String modifiedAt,
                     String chatUnavailableReason, ModelUi ui, Capabilities capabilities) {
            this(name, sizeBytes, parameterSize, quantization, modifiedAt, chatUnavailableReason, ui, capabilities, null);
        }
        public Model(String name, long sizeBytes, String parameterSize, String quantization, String modifiedAt,
                     String chatUnavailableReason, ModelUi ui) {
            this(name, sizeBytes, parameterSize, quantization, modifiedAt, chatUnavailableReason, ui,
                    ui == null ? Capabilities.CHAT : Capabilities.INFER);
        }
        public Model(String name, long sizeBytes, String parameterSize, String quantization, String modifiedAt,
                     String chatUnavailableReason) {
            this(name, sizeBytes, parameterSize, quantization, modifiedAt, chatUnavailableReason, null);
        }

        @JsonIgnore
        public boolean hasSupportedInterface() {
            return ModelAdmission.reason(name) == null && ((ui != null && capabilities.infer())
                    || (capabilities.chat() && chatUnavailableReason == null));
        }
    }

    /** Opaque inference input; the gateway never interprets it. */
    public record InferRequest(@NotBlank String model, @NotNull JsonNode input) {
        @AssertTrue(message = "This model name is not supported by the local gateway")
        @JsonIgnore
        public boolean isModelSupported() {
            return ModelAdmission.reason(model) == null;
        }
        @Override public String toString() { return "InferRequest[model=" + model + ", input=<redacted>]"; }
    }

    /** One streamed inference record. {@code done} is always present; {@code event} and {@code error} only when set. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record InferRecord(JsonNode event, boolean done, String error) {
        public static InferRecord error(String message) { return new InferRecord(null, true, message); }
        @Override public String toString() { return "InferRecord[done=" + done + ", event=<redacted>]"; }
    }

    public record Models(List<Model> models, boolean connected) {}

    public record Requests(List<InferenceRegistry.RequestView> requests) {}
}
