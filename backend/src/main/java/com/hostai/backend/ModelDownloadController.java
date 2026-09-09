package com.hostai.backend;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping(value = "/api/model-downloads", produces = MediaType.APPLICATION_JSON_VALUE)
public class ModelDownloadController {
    private static final String UUID_PATTERN = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
    private final ModelDownloadService downloads;

    public ModelDownloadController(ModelDownloadService downloads) { this.downloads = downloads; }

    @GetMapping
    public ResponseEntity<Downloads> list() {
        return ResponseEntity.ok().cacheControl(org.springframework.http.CacheControl.noStore())
                .body(new Downloads(downloads.downloads()));
    }

    @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<ModelDownloadService.Job> start(@Valid @RequestBody StartRequest request) {
        var started = downloads.start(UUID.fromString(request.requestId()), request.model());
        return ResponseEntity.status(started.created() ? HttpStatus.ACCEPTED : HttpStatus.OK)
                .cacheControl(org.springframework.http.CacheControl.noStore()).body(started.job());
    }

    @PostMapping(value = "/{id}/cancel", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<ModelDownloadService.Job> cancel(@PathVariable String id, @RequestBody CancelRequest request) {
        if (!id.matches(UUID_PATTERN)) throw new GatewayException(HttpStatus.BAD_REQUEST, "A download UUID is required.");
        return ResponseEntity.ok().cacheControl(org.springframework.http.CacheControl.noStore())
                .body(downloads.cancel(UUID.fromString(id)));
    }

    public record StartRequest(@NotNull @Pattern(regexp = UUID_PATTERN) String requestId, @NotBlank String model) {}
    public record CancelRequest() {}
    public record Downloads(List<ModelDownloadService.Job> downloads) {}
}
