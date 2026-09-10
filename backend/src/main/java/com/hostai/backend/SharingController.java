package com.hostai.backend;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.UUID;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;

@RestController
@RequestMapping(value = "/api/sharing", produces = MediaType.APPLICATION_JSON_VALUE)
final class SharingController {
    private final SharingService sharing;
    SharingController(SharingService sharing) { this.sharing = sharing; }
    @GetMapping SharingService.Status status() { return sharing.status(); }
    @PostMapping(value = "/start", consumes = MediaType.APPLICATION_JSON_VALUE)
    Mono<SharingService.Status> start(@Valid @RequestBody Start request) { return sharing.start(request.model(), request.hostLabel()); }
    @PostMapping(value = "/stop", consumes = MediaType.APPLICATION_JSON_VALUE)
    SharingService.Status stop(@RequestBody Empty request) { return sharing.stop(); }
    @PostMapping(value = "/grants", consumes = MediaType.APPLICATION_JSON_VALUE)
    SharingService.Invite create(@Valid @RequestBody Create request) { return sharing.create(request.label(), request.expiresInHours(), request.channel() == null ? "local" : request.channel()); }
    @PostMapping(value = "/grants/cleanup", consumes = MediaType.APPLICATION_JSON_VALUE)
    SharingService.Cleanup cleanup(@RequestBody Empty request) { return sharing.cleanup(); }
    @PostMapping(value = "/grants/{id}/revoke", consumes = MediaType.APPLICATION_JSON_VALUE)
    SharingService.Status revoke(@PathVariable String id, @RequestBody Empty request) {
        if (!id.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))
            throw new GatewayException(org.springframework.http.HttpStatus.BAD_REQUEST, "A grant UUID is required.");
        return sharing.revoke(UUID.fromString(id));
    }
    @PostMapping(value = "/internet/start", consumes = MediaType.APPLICATION_JSON_VALUE)
    SharingService.Status startInternet(@RequestBody Empty request) { return sharing.startInternet(); }
    @PostMapping(value = "/internet/stop", consumes = MediaType.APPLICATION_JSON_VALUE)
    SharingService.Status stopInternet(@RequestBody Empty request) { return sharing.stopInternet(); }
    @PostMapping(value = "/requests/start", consumes = MediaType.APPLICATION_JSON_VALUE)
    SharingService.Status startRequests(@RequestBody Empty request) { return sharing.startRequests(); }
    @PostMapping(value = "/requests/stop", consumes = MediaType.APPLICATION_JSON_VALUE)
    SharingService.Status stopRequests(@RequestBody Empty request) { return sharing.stopRequests(); }
    @PostMapping(value = "/requests/{id}/approve", consumes = MediaType.APPLICATION_JSON_VALUE)
    SharingService.Status approveRequest(@PathVariable String id, @Valid @RequestBody Approve request) {
        return sharing.approveRequest(requestId(id), request.code(), request.expiresInHours());
    }
    @PostMapping(value = "/requests/{id}/reject", consumes = MediaType.APPLICATION_JSON_VALUE)
    SharingService.Status rejectRequest(@PathVariable String id, @Valid @RequestBody Reject request) {
        return sharing.rejectRequest(requestId(id), request.code());
    }
    private static UUID requestId(String id) {
        if (!id.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))
            throw new GatewayException(org.springframework.http.HttpStatus.BAD_REQUEST, "An access request UUID is required.");
        return UUID.fromString(id);
    }
    record Approve(@NotBlank @Size(max = 8) String code, @NotNull @Min(1) @Max(168) Integer expiresInHours) {}
    record Reject(@NotBlank @Size(max = 8) String code) {}
    record Start(@NotBlank String model, @NotBlank @Size(max = 80) String hostLabel) {}
    record Create(@NotBlank @Size(max = 80) String label, @NotNull @Min(1) @Max(168) Integer expiresInHours, @jakarta.validation.constraints.Pattern(regexp = "local|internet") String channel) {}
    record Empty() {}
}
