package com.hostai.backend;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.validation.Validation;
import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.Test;

class ModelAdmissionTest {
    @Test
    void discoveryPolicyAgreesWithRequestValidationAtNameBoundaries() {
        try (var factory = Validation.buildDefaultValidatorFactory()) {
            var validator = factory.getValidator();
            for (String name : List.of("a", "org/model:tag", "a._:/-9", "x".repeat(128), "cloud-local")) {
                assertThat(ModelAdmission.reason(name)).isNull();
                assertThat(validator.validate(request(name))).isEmpty();
            }
            for (String name : Arrays.asList(null, "", " ", "a b", "/leading", "🙂", "x".repeat(129), "a:cloud", "a-cloud")) {
                assertThat(ModelAdmission.reason(name)).isNotBlank();
                assertThat(validator.validate(request(name))).isNotEmpty();
            }
        }
    }

    private static Api.ChatRequest request(String name) {
        return new Api.ChatRequest(name, List.of(new Api.Message("user", "Hello")), 0.7, 128);
    }
}
