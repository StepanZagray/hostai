package com.hostai.backend;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.lang.reflect.Field;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import tools.jackson.databind.json.JsonMapper;

class AccessRequestInboxTest {
    private static final Instant START = Instant.parse("2026-09-01T12:00:00Z");
    private static final String ORIGIN = "https://host.example.test";
    private static final String MODEL = "qwen3:8b";
    private static final String HOST = "Test host";
    private static final String COMMITMENT = "a1".repeat(32);
    private static final String OTHER_COMMITMENT = "b2".repeat(32);
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private final TestTime time = new TestTime();
    private final AccessRequestInbox inbox = new AccessRequestInbox(time, () -> time.nanos);
    private final AccessRequestInbox.Context context = inbox.start(1, ORIGIN, MODEL, HOST);

    @Test
    void approvePollCancelAndLostResponsesKeepOneDurablePermission() {
        String bearer = bearer(1);
        var submitted = submit(1);
        var issued = new AtomicReference<AccessGrantStore.Grant>();
        var calls = new AtomicInteger();
        var approved = inbox.approve(submitted.id(), submitted.code(), 168, approval -> {
            calls.incrementAndGet();
            assertThat(approval.name()).isEqualTo(submitted.name());
            assertThat(approval.code()).isEqualTo(submitted.code());
            assertThat(approval.model()).isEqualTo(MODEL);
            assertThat(approval.channel()).isEqualTo("internet");
            assertThat(approval.hours()).isEqualTo(168);
            assertThat(approval.secretHash()).isEqualTo(HexFormat.of().parseHex(COMMITMENT));
            issued.set(grant(approval));
            return issued.get();
        });
        assertThat(approved.state()).isEqualTo("approved");
        assertThat(approved.grantId()).isEqualTo(issued.get().id());
        assertThat(approved.grantExpiresAt()).isEqualTo(START.plus(Duration.ofDays(7)));
        assertThat(approved.requestedAt()).isEqualTo(START);
        assertThat(approved.expiresInSeconds()).isEqualTo(900);
        assertThat(inbox.approve(submitted.id(), submitted.code(), 1, approval -> {
            calls.incrementAndGet();
            throw new AssertionError("Must not issue twice");
        })).isEqualTo(approved);
        assertThat(inbox.reject(submitted.id(), submitted.code())).isEqualTo(approved);
        var polled = inbox.poll(bearer);
        assertThat(polled.state()).isEqualTo("approved");
        assertThat(polled.grantId()).isEqualTo(issued.get().id());
        assertThat(polled.code()).isEqualTo(approved.code());
        assertThat(submit(1)).isEqualTo(polled);
        assertThat(inbox.ownerItems(List.of(issued.get()))).containsExactly(approved);
        var revoked = new ArrayList<UUID>();
        var cancelled = inbox.cancel(bearer, id -> {
            // The callback must finish before cancellation can be reported.
            assertThat(inbox.ownerItems(List.of(issued.get())).getFirst().state()).isEqualTo("failed");
            revoked.add(id);
        });
        assertThat(cancelled.state()).isEqualTo("cancelled");
        assertThat(cancelled.grantId()).isEqualTo(issued.get().id());
        assertThat(inbox.cancel(bearer, revoked::add)).isEqualTo(cancelled);
        assertThat(submit(1)).isEqualTo(cancelled);
        time.advance(Duration.ofSeconds(2));
        assertThat(inbox.poll(bearer).state()).isEqualTo("cancelled");
        assertThat(inbox.approve(submitted.id(), submitted.code(), 1, this::unexpectedIssue).state())
                .isEqualTo("cancelled");
        assertThat(revoked).containsExactly(issued.get().id());
        assertThat(calls).hasValue(1);
    }

    @Test
    void pendingCancellationAndRejectionAreTerminalWithoutCallbacks() {
        var cancelled = submit(1);
        var rejected = submit(2);
        assertThat(inbox.cancel(bearer(1), id -> { throw new AssertionError("No grant exists"); }).state())
                .isEqualTo("cancelled");
        assertThat(inbox.reject(rejected.id(), rejected.code()).state()).isEqualTo("rejected");
        assertThat(inbox.reject(cancelled.id(), cancelled.code()).state()).isEqualTo("cancelled");
        assertThat(inbox.cancel(bearer(2), id -> { throw new AssertionError("No grant exists"); }).state())
                .isEqualTo("rejected");
        for (var row : List.of(cancelled, rejected)) {
            assertThat(inbox.approve(row.id(), row.code(), 1, this::unexpectedIssue).grantId()).isNull();
        }
        assertThat(submit(1).state()).isEqualTo("cancelled");
        assertThat(inbox.poll(bearer(2)).state()).isEqualTo("rejected");
    }

    @Test
    void lostSubmitResponseDoesNotConsumeCreationBudgetOrResetDeadline() {
        var first = submit(1);
        for (int i = 0; i < 6; i++) assertThat(submit(1)).isEqualTo(first);
        for (int i = 2; i <= 6; i++) submit(i);
        assertBusy(10, () -> submit(7));
        time.advance(Duration.ofSeconds(10));
        assertThat(submit(1).id()).isEqualTo(first.id());
        assertThat(submit(1).expiresInSeconds()).isEqualTo(590);
        assertThat(submit(7).state()).isEqualTo("pending");
    }

    @Test
    void bearerIdentityAndOwnerIdPlusCodeKeepRecordsIsolated() {
        var first = submit(1);
        var second = inbox.submit(intakeId(), bearer(2), "Guest 1", MODEL, OTHER_COMMITMENT);
        assertThat(first.id()).isNotEqualTo(second.id());
        assertThat(first.code()).isNotEqualTo(second.code());
        assertStatus(HttpStatus.NOT_FOUND, () -> inbox.reject(first.id(), second.code()));
        assertStatus(HttpStatus.NOT_FOUND, () -> inbox.approve(second.id(), first.code(), 1, this::unexpectedIssue));
        assertStatus(HttpStatus.NOT_FOUND, () -> inbox.reject(UUID.randomUUID(), first.code()));
        assertStatus(HttpStatus.NOT_FOUND, () -> inbox.reject(null, first.code()));
        assertStatus(HttpStatus.NOT_FOUND, () -> inbox.reject(first.id(), null));
        inbox.approve(first.id(), first.code(), 1, approval -> {
            assertThat(approval.secretHash()).isEqualTo(HexFormat.of().parseHex(COMMITMENT));
            return grant(approval);
        });
        assertThat(inbox.poll(bearer(2)).state()).isEqualTo("pending");
        inbox.approve(second.id(), second.code(), 1, approval -> {
            assertThat(approval.secretHash()).isEqualTo(HexFormat.of().parseHex(OTHER_COMMITMENT));
            return grant(approval);
        });
        assertThat(inbox.poll(bearer(1)).grantId()).isNotEqualTo(submit(2, "Guest 1", OTHER_COMMITMENT).grantId());
        assertStatus(HttpStatus.NOT_FOUND, () -> inbox.poll(bearer(99)));
    }

    @Test
    void immutableFieldChangesAreAlwaysFixedConflictsIncludingTerminalRows() {
        var row = submit(1);
        for (boolean terminal : List.of(false, true)) {
            if (terminal) inbox.reject(row.id(), row.code());
            List<Runnable> changes = List.of(
                    () -> submit(1, "Changed", COMMITMENT),
                    () -> submit(1, "Guest 1", OTHER_COMMITMENT),
                    () -> submit(1, null, COMMITMENT),
                    () -> submit(1, "Guest 1", "bad"),
                    () -> submit(1, "Guest 1", null),
                    () -> submit(1, "\nGuest 1", COMMITMENT),
                    () -> inbox.submit(intakeId(), bearer(1), "Guest 1", MODEL.toUpperCase(), COMMITMENT),
                    () -> inbox.submit(intakeId(), bearer(1), "Guest 1", null, COMMITMENT),
                    () -> inbox.submit(null, bearer(1), "Guest 1", MODEL, COMMITMENT));
            for (Runnable change : changes) {
                time.advance(Duration.ofMillis(500)); // Stay below the independent per-request authentication limit.
                GatewayException failure = assertStatus(HttpStatus.CONFLICT, change);
                assertThat(failure.getMessage()).isEqualTo("The access request context or fields have changed.");
            }
            assertThat(submit(1).id()).isEqualTo(row.id());
            assertThat(inbox.ownerItems(List.of())).hasSize(1);
        }
    }

    @Test
    void bearerEncodingIsCanonicalAndAllMalformedCredentialsAreUniform401() {
        String canonical = bearer(1);
        String alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        int last = alphabet.indexOf(canonical.charAt(47));
        String alternate = canonical.substring(0, 47) + alphabet.charAt(last + 1);
        assertThat(Base64.getUrlDecoder().decode(alternate.substring(5)))
                .isEqualTo(Base64.getUrlDecoder().decode(canonical.substring(5)));
        List<String> malformed = Arrays.asList(null, "", "Bearer " + canonical, " " + canonical,
                canonical + " ", canonical + "=", canonical.substring(1), "hga1." + canonical.substring(5),
                "hgq1." + "A".repeat(42), "hgq1." + "A".repeat(44),
                "hgq1." + "/".repeat(43), "hgq1." + "+".repeat(43),
                "hgq1." + "é".repeat(43), alternate);
        for (String value : malformed) {
            for (Runnable action : List.<Runnable>of(
                    () -> inbox.submit(intakeId(), value, "Guest", MODEL, COMMITMENT),
                    () -> inbox.poll(value), () -> inbox.cancel(value, id -> {}))) {
                time.advance(Duration.ofMillis(250));
                var error = assertStatus(HttpStatus.UNAUTHORIZED, action);
                assertThat(error.getMessage()).isEqualTo("The request credential is invalid.");
            }
        }
        assertThat(inbox.ownerItems(List.of())).isEmpty();
        assertThat(submit(1).state()).isEqualTo("pending");
    }

    @Test
    void malformedBodiesCreateNothingAndNamesAreTrimmedPrintableUtf16() {
        List<String> invalidNames = Arrays.asList(null, "", " ", "a".repeat(41), "a\nb", "\tGuest",
                "Guest\r", "a\u0000b", "a\u0085b", "a\u200db", "a\u202eb", "a\u2028b", "a\u2029b",
                "\ud800", "\udc00", "Guest \ud83d\ude00", "a\uffffb");
        for (String name : invalidNames) {
            time.advance(Duration.ofMillis(250));
            assertStatus(HttpStatus.BAD_REQUEST, () -> submit(1, name, COMMITMENT));
            assertThat(inbox.ownerItems(List.of())).isEmpty();
        }
        for (String commitment : Arrays.asList(null, "", "a".repeat(63), "a".repeat(65),
                COMMITMENT.toUpperCase(), "g".repeat(64), " " + COMMITMENT, "hga1.secret")) {
            time.advance(Duration.ofMillis(250));
            assertStatus(HttpStatus.BAD_REQUEST, () -> submit(1, "Guest", commitment));
        }
        for (String model : Arrays.asList(null, "", " " + MODEL, MODEL + " ", MODEL.toUpperCase(), "another")) {
            time.advance(Duration.ofMillis(250));
            assertStatus(HttpStatus.BAD_REQUEST, () -> inbox.submit(intakeId(), bearer(1), "Guest", model, COMMITMENT));
        }
        assertStatus(HttpStatus.CONFLICT, () -> inbox.submit("unknown", bearer(1), "Guest", MODEL, COMMITMENT));
        assertThat(inbox.ownerItems(List.of())).isEmpty();
        var row = submit(1, "  Élodie  ", COMMITMENT);
        assertThat(row.name()).isEqualTo("Élodie");
        assertThat(submit(1, "Élodie", COMMITMENT)).isEqualTo(row);
        assertThat(submit(2, "x".repeat(40), OTHER_COMMITMENT).name()).hasSize(40);
        for (int i = 3; i <= 6; i++) submit(i);
        assertBusy(10, () -> submit(7));
    }

    @Test
    void identicalContextIsIdempotentAndEveryChangedBindingInvalidatesOldRows() {
        var first = submit(1);
        assertThat(inbox.start(1, ORIGIN, MODEL, HOST)).isSameAs(context);
        assertThat(submit(1).id()).isEqualTo(first.id());
        Object[][] bindings = {
                {2L, ORIGIN, MODEL, HOST},
                {2L, "https://other.example.test", MODEL, HOST},
                {2L, "https://other.example.test", "another:model", HOST},
                {2L, "https://other.example.test", "another:model", "New host"}
        };
        var previous = context;
        var previousRow = first;
        for (Object[] binding : bindings) {
            var next = inbox.start((Long) binding[0], (String) binding[1], (String) binding[2], (String) binding[3]);
            assertThat(next.intakeId()).isNotEqualTo(previous.intakeId());
            assertThat(inbox.context()).isEqualTo(next);
            assertThat(inbox.ownerItems(List.of())).isEmpty();
            assertStatus(HttpStatus.NOT_FOUND, () -> inbox.poll(bearer(1)));
            String staleId = previous.intakeId().toString();
            assertStatus(HttpStatus.CONFLICT,
                    () -> inbox.submit(staleId, bearer(1), "Guest 1", next.model(), COMMITMENT));
            var staleRow = previousRow;
            assertStatus(HttpStatus.NOT_FOUND, () -> inbox.approve(staleRow.id(), staleRow.code(), 1, this::unexpectedIssue));
            previousRow = inbox.submit(next.intakeId().toString(), bearer(1), "Guest 1", next.model(), COMMITMENT);
            assertThat(previousRow.id()).isNotEqualTo(staleRow.id());
            previous = next;
        }
    }

    @Test
    void contextRejectsNoncanonicalOriginsAndInvalidBindingsWithoutReplacingGoodIntake() {
        for (String origin : Arrays.asList(null, "", "http://host.example.test", ORIGIN + "/", ORIGIN + ":443",
                ORIGIN + ":0444", ORIGIN + ":0", ORIGIN + ":65536", ORIGIN + "/path", ORIGIN + "?query",
                ORIGIN + "#fragment", "https://user@host.example.test", "https://HOST.example.test",
                "https://host.example.test.", " " + ORIGIN)) {
            assertStatus(HttpStatus.BAD_REQUEST, () -> inbox.start(2, origin, MODEL, HOST));
            assertThat(inbox.context()).isEqualTo(context);
        }
        assertStatus(HttpStatus.BAD_REQUEST, () -> inbox.start(-1, ORIGIN, MODEL, HOST));
        assertStatus(HttpStatus.BAD_REQUEST, () -> inbox.start(2, ORIGIN, "a:cloud", HOST));
        assertStatus(HttpStatus.BAD_REQUEST, () -> inbox.start(2, ORIGIN, MODEL, null));
        assertStatus(HttpStatus.BAD_REQUEST, () -> inbox.start(2, ORIGIN, MODEL, "\nHost"));
        assertThat(inbox.start(2, ORIGIN + ":8443", MODEL, HOST).origin()).isEqualTo(ORIGIN + ":8443");
    }

    @Test
    void stopAndNewInstancesNeverAutorunOrRevokeCommittedGrants() {
        var row = submit(1);
        var committed = new AtomicReference<AccessGrantStore.Grant>();
        inbox.approve(row.id(), row.code(), 1, approval -> {
            committed.set(grant(approval));
            return committed.get();
        });
        inbox.stop();
        assertThat(inbox.context()).isNull();
        assertThat(inbox.ownerItems(List.of(committed.get()))).isEmpty();
        assertThat(committed.get().revokedAt()).isNull();
        assertStatus(HttpStatus.NOT_FOUND, () -> inbox.poll(bearer(1)));
        assertStatus(HttpStatus.NOT_FOUND, () -> submit(1));
        assertStatus(HttpStatus.NOT_FOUND, () -> inbox.cancel(bearer(1), id -> { throw new AssertionError(); }));
        assertStatus(HttpStatus.UNAUTHORIZED, () -> inbox.poll(null));
        inbox.stop();
        var restarted = inbox.start(1, ORIGIN, MODEL, HOST);
        assertThat(restarted.intakeId()).isNotEqualTo(context.intakeId());
        assertStatus(HttpStatus.CONFLICT, () -> submit(1));
        assertStatus(HttpStatus.NOT_FOUND, () -> inbox.poll(bearer(1)));
        var fresh = new AccessRequestInbox();
        assertThat(fresh.context()).isNull();
        assertThat(fresh.ownerItems(List.of(committed.get()))).isEmpty();
        assertStatus(HttpStatus.NOT_FOUND, () -> fresh.poll(bearer(1)));
    }

    @Test
    void tenPendingRequestsAreNeverEvictedToAdmitAnother() {
        List<AccessRequestInbox.GuestView> pending = new ArrayList<>();
        for (int i = 1; i <= 10; i++) {
            if (i > 6) time.advance(Duration.ofSeconds(10));
            pending.add(submit(i));
        }
        time.advance(Duration.ofSeconds(10));
        assertBusy(550, () -> submit(11));
        assertThat(inbox.ownerItems(List.of())).extracting(AccessRequestInbox.OwnerView::id)
                .containsExactlyElementsOf(pending.stream().map(AccessRequestInbox.GuestView::id).toList());
        assertThat(submit(1).id()).isEqualTo(pending.getFirst().id());
        inbox.reject(pending.getFirst().id(), pending.getFirst().code());
        time.advance(Duration.ofSeconds(10));
        assertThat(submit(11).state()).isEqualTo("pending");
        assertThat(inbox.ownerItems(List.of())).hasSize(11);
    }

    @Test
    void hundredRecordCapNeverEvictsTerminalRecordsAndSweepReleasesCapacity() throws Exception {
        // The normal creation rate permits at most 96 live records. Replenish this fixture's
        // creation bucket to test the independent 100-row defense, keeping auth/TTL unchanged.
        List<UUID> ids = new ArrayList<>();
        List<String> codes = new ArrayList<>();
        for (int i = 1; i <= 100; i++) {
            refillCreationFixture();
            time.advance(Duration.ofMillis(250));
            var row = submit(i);
            inbox.reject(row.id(), row.code());
            ids.add(row.id());
            codes.add(row.code());
        }
        assertThat(ids).doesNotHaveDuplicates();
        assertThat(codes).doesNotHaveDuplicates().allMatch(code -> code.matches("[0-9A-HJKMNP-TV-Z]{6}"));
        refillCreationFixture();
        assertBusy(876, () -> submit(101));
        assertThat(inbox.ownerItems(List.of())).extracting(AccessRequestInbox.OwnerView::id)
                .containsExactlyElementsOf(ids);
        assertThat(submit(1).state()).isEqualTo("rejected");
        time.advance(Duration.ofMillis(875_250));
        assertStatus(HttpStatus.NOT_FOUND, () -> inbox.poll(bearer(1)));
        assertThat(submit(101).state()).isEqualTo("pending");
        assertThat(inbox.ownerItems(List.of())).hasSize(100);
    }

    @Test
    void creationBucketRefillsFractionallyAndDoesNotResetOnContextChanges() {
        for (int i = 1; i <= 6; i++) submit(i);
        assertBusy(10, () -> submit(7));
        time.advance(Duration.ofMillis(9_999));
        assertBusy(1, () -> submit(7));
        time.advance(Duration.ofMillis(1));
        assertThat(submit(7).state()).isEqualTo("pending");
        inbox.stop();
        var restarted = inbox.start(2, ORIGIN, MODEL, HOST);
        assertBusy(10, () -> inbox.submit(restarted.intakeId().toString(), bearer(8), "Guest 8", MODEL, COMMITMENT));
        time.advance(Duration.ofSeconds(60));
        for (int i = 1; i <= 6; i++)
            inbox.submit(restarted.intakeId().toString(), bearer(i), "Guest " + i, MODEL, COMMITMENT);
        assertBusy(10, () -> inbox.submit(restarted.intakeId().toString(), bearer(8), "Guest 8", MODEL, COMMITMENT));
    }

    @Test
    void globalAuthenticationBucketChargesInvalidUnknownPollSubmitAndCancelAttempts() {
        for (int i = 0; i < 30; i++) {
            int attempt = i;
            if (i % 3 == 0) assertStatus(HttpStatus.UNAUTHORIZED, () -> inbox.poll(null));
            else if (i % 3 == 1) assertStatus(HttpStatus.NOT_FOUND, () -> inbox.poll(bearer(attempt)));
            else assertStatus(HttpStatus.NOT_FOUND, () -> inbox.cancel(bearer(attempt), id -> {}));
        }
        assertBusy(1, () -> inbox.poll(null));
        assertBusy(1, () -> submit(1));
        time.advance(Duration.ofMillis(249));
        assertBusy(1, () -> inbox.poll(null));
        time.advance(Duration.ofMillis(1));
        assertStatus(HttpStatus.UNAUTHORIZED, () -> inbox.poll(null));
        assertBusy(1, () -> inbox.poll(null));
        inbox.stop();
        inbox.start(2, ORIGIN, MODEL, HOST);
        assertBusy(1, () -> inbox.poll(null));
        time.advance(Duration.ofSeconds(100));
        for (int i = 0; i < 30; i++) assertStatus(HttpStatus.UNAUTHORIZED, () -> inbox.poll(null));
        assertBusy(1, () -> inbox.poll(null));
        assertThat(inbox.ownerItems(List.of())).isEmpty();
    }

    @Test
    void anonymousFloodCannotPreventKnownGuestsFromRecoveringOrCancelling() {
        var first = submit(1);
        for (int i = 0; i < 29; i++) assertStatus(HttpStatus.UNAUTHORIZED, () -> inbox.poll(null));
        assertBusy(1, () -> inbox.poll(null));
        assertThat(submit(1).id()).isEqualTo(first.id());
        assertThat(inbox.poll(bearer(1)).state()).isEqualTo("pending");
        assertThat(inbox.cancel(bearer(1), ignored -> {}).state()).isEqualTo("cancelled");
    }

    @Test
    void knownGuestsHaveIndependentBoundedMutationBudgetsAndDiscoveryCannotSpendThem() {
        submit(1); submit(2);
        for (int i = 0; i < 12; i++) { inbox.discover(); submit(1); }
        assertBusy(1, inbox::discover);
        assertBusy(1, () -> submit(1));
        assertThat(inbox.cancel(bearer(2), ignored -> {}).state()).isEqualTo("cancelled");
        time.advance(Duration.ofMillis(500));
        assertThat(inbox.cancel(bearer(1), ignored -> {}).state()).isEqualTo("cancelled");
        inbox.discover();
    }

    @Test
    void tenGuestsCanUseTheMinimumPollIntervalWithoutStarvingEachOther() {
        for (int i = 1; i <= 10; i++) {
            if (i > 6) time.advance(Duration.ofSeconds(10));
            submit(i);
        }
        for (int round = 0; round < 100; round++) {
            for (int i = 1; i <= 10; i++) assertThat(inbox.poll(bearer(i)).state()).isEqualTo("pending");
            time.advance(Duration.ofSeconds(2));
        }
    }

    @Test
    void perRecordPollMinimumIsTwoSecondsWithPositiveRoundedRetryAndIndependentGuests() {
        submit(1);
        submit(2);
        assertThat(inbox.poll(bearer(1)).state()).isEqualTo("pending");
        assertBusy(2, () -> inbox.poll(bearer(1)));
        assertThat(inbox.poll(bearer(2)).state()).isEqualTo("pending");
        time.advance(Duration.ofMillis(1_001));
        assertBusy(1, () -> inbox.poll(bearer(1)));
        time.advance(Duration.ofMillis(998));
        assertBusy(1, () -> inbox.poll(bearer(1)));
        time.advance(Duration.ofMillis(1));
        assertThat(inbox.poll(bearer(1)).state()).isEqualTo("pending");
        assertThat(inbox.poll(bearer(2)).state()).isEqualTo("pending");
        // Submission recovery and cancellation are not blocked by the poll interval.
        assertThat(submit(1).state()).isEqualTo("pending");
        assertThat(inbox.cancel(bearer(1), id -> {}).state()).isEqualTo("cancelled");
    }

    @Test
    void tenClientsCanPollEveryFiveSecondsForFifteenMinutes() {
        List<Long> created = new ArrayList<>();
        for (int i = 1; i <= 10; i++) {
            if (i > 6) time.advance(Duration.ofSeconds(10));
            submit(i);
            created.add(time.nanos);
        }
        int polls = 0;
        for (int tick = 0; tick < 180; tick++) {
            for (int i = 1; i <= 10; i++) {
                long age = time.nanos - created.get(i - 1);
                String credential = bearer(i);
                if (age >= Duration.ofMinutes(15).toNanos())
                    assertStatus(HttpStatus.NOT_FOUND, () -> inbox.poll(credential));
                else {
                    var view = inbox.poll(credential);
                    assertThat(view.state()).isEqualTo(age < Duration.ofMinutes(10).toNanos() ? "pending" : "expired");
                    assertThat(view.expiresInSeconds()).isBetween(0L, 900L);
                }
                polls++;
            }
            time.advance(Duration.ofSeconds(5));
        }
        assertThat(polls).isEqualTo(1800);
        assertThat(inbox.ownerItems(List.of())).isEmpty();
    }

    @Test
    void requestExpiryAndAdmissionIgnoreWallClockSkewAndNanoTimeWraparound() {
        time.nanos = Long.MAX_VALUE - Duration.ofSeconds(30).toNanos();
        var wrapped = new AccessRequestInbox(time, () -> time.nanos);
        var intake = wrapped.start(1, ORIGIN, MODEL, HOST);
        var row = wrapped.submit(intake.intakeId().toString(), bearer(1), "Guest", MODEL, COMMITMENT);
        time.now = START.plus(Duration.ofDays(100));
        assertThat(wrapped.poll(bearer(1)).expiresInSeconds()).isEqualTo(600);
        time.advance(Duration.ofSeconds(599));
        time.now = START.minus(Duration.ofDays(100));
        assertThat(wrapped.submit(intake.intakeId().toString(), bearer(1), "Guest", MODEL, COMMITMENT)
                .expiresInSeconds()).isEqualTo(1);
        assertThat(wrapped.ownerItems(List.of()).getFirst().requestedAt()).isEqualTo(START);
        time.advance(Duration.ofSeconds(1));
        assertThat(wrapped.approve(row.id(), row.code(), 1, this::unexpectedIssue).state()).isEqualTo("expired");
        assertThat(wrapped.poll(bearer(1)).expiresInSeconds()).isEqualTo(300);
        time.advance(Duration.ofSeconds(299));
        assertThat(wrapped.poll(bearer(1)).expiresInSeconds()).isEqualTo(1);
        time.advance(Duration.ofSeconds(1));
        assertStatus(HttpStatus.NOT_FOUND, () -> wrapped.poll(bearer(1)));
        assertThat(wrapped.ownerItems(List.of())).isEmpty();
    }

    @Test
    void lateApprovalRetainsRecoveryTimeButNeverExtendsRecordPastFifteenMinutes() {
        var row = submit(1);
        time.advance(Duration.ofSeconds(599));
        var grant = new AtomicReference<AccessGrantStore.Grant>();
        var approved = inbox.approve(row.id(), row.code(), 1, approval -> {
            grant.set(grant(approval));
            return grant.get();
        });
        assertThat(approved.expiresInSeconds()).isEqualTo(301);
        time.advance(Duration.ofSeconds(60));
        assertThat(submit(1).state()).isEqualTo("approved");
        time.advance(Duration.ofSeconds(240));
        assertThat(inbox.poll(bearer(1)).state()).isEqualTo("approved");
        time.advance(Duration.ofSeconds(1));
        assertStatus(HttpStatus.NOT_FOUND, () -> inbox.poll(bearer(1)));
        assertThat(inbox.ownerItems(List.of(grant.get()))).isEmpty();
        assertThat(grant.get().revokedAt()).isNull();
    }

    @Test
    void callbacksThatExhaustRecoveryWindowFailSafely() {
        var row = submit(1);
        assertStatus(HttpStatus.INTERNAL_SERVER_ERROR, () -> inbox.approve(row.id(), row.code(), 1, approval -> {
            time.advance(Duration.ofSeconds(841));
            return grant(approval);
        }));
        assertThat(inbox.poll(bearer(1)).state()).isEqualTo("failed");
        assertThat(inbox.approve(row.id(), row.code(), 1, this::unexpectedIssue).state()).isEqualTo("failed");
    }

    @Test
    void callbackCompletionWithExactlySixtySecondsRemainingCanRecover() {
        var row = submit(1);
        var approved = inbox.approve(row.id(), row.code(), 1, approval -> {
            time.advance(Duration.ofSeconds(840));
            return grant(approval);
        });
        assertThat(approved.state()).isEqualTo("approved");
        assertThat(approved.expiresInSeconds()).isEqualTo(60);
        time.advance(Duration.ofSeconds(59));
        assertThat(inbox.poll(bearer(1)).state()).isEqualTo("approved");
        time.advance(Duration.ofSeconds(1));
        assertStatus(HttpStatus.NOT_FOUND, () -> inbox.poll(bearer(1)));
    }

    @Test
    void ownerSnapshotReconcilesMissingRevokedExpiredAndChangedPermissions() {
        List<AccessGrantStore.Grant> grants = new ArrayList<>();
        List<AccessRequestInbox.GuestView> requests = new ArrayList<>();
        for (int i = 1; i <= 6; i++) {
            var row = submit(i);
            requests.add(row);
            inbox.approve(row.id(), row.code(), 1, approval -> {
                var grant = grant(approval);
                grants.add(grant);
                return grant;
            });
        }
        var revoked = grants.get(1);
        var otherModel = grants.get(2);
        var otherChannel = grants.get(3);
        var otherExpiry = grants.get(4);
        var current = List.of(
                new AccessGrantStore.Grant(revoked.id(), revoked.label(), MODEL, START, revoked.expiresAt(), START, "internet"),
                new AccessGrantStore.Grant(otherModel.id(), otherModel.label(), "other:model", START, otherModel.expiresAt(), null, "internet"),
                new AccessGrantStore.Grant(otherChannel.id(), otherChannel.label(), MODEL, START, otherChannel.expiresAt(), null, "local"),
                new AccessGrantStore.Grant(otherExpiry.id(), otherExpiry.label(), MODEL, START, otherExpiry.expiresAt().plusSeconds(1), null, "internet"),
                grants.get(5));
        assertThat(inbox.ownerItems(current)).extracting(AccessRequestInbox.OwnerView::state)
                .containsExactly("revoked", "revoked", "revoked", "revoked", "revoked", "approved");
        for (int i = 1; i <= 5; i++) assertThat(inbox.poll(bearer(i)).state()).isEqualTo("revoked");
        // A later snapshot cannot resurrect terminal records.
        assertThat(inbox.ownerItems(grants).getFirst().state()).isEqualTo("revoked");
        time.now = START.plus(Duration.ofHours(1));
        assertThat(inbox.ownerItems(current).get(5).state()).isEqualTo("expired");
        assertThat(inbox.poll(bearer(6)).state()).isEqualTo("expired");
        assertThat(inbox.approve(requests.get(5).id(), requests.get(5).code(), 1, this::unexpectedIssue).state())
                .isEqualTo("expired");
    }

    @Test
    void hoursAreValidatedBeforeIssuingAndFailureDoesNotConsumePendingRequest() {
        var row = submit(1);
        for (int hours : List.of(Integer.MIN_VALUE, -1, 0, 169, Integer.MAX_VALUE))
            assertStatus(HttpStatus.BAD_REQUEST, () -> inbox.approve(row.id(), row.code(), hours, this::unexpectedIssue));
        assertThat(inbox.poll(bearer(1)).state()).isEqualTo("pending");
        assertThat(inbox.approve(row.id(), row.code(), 1, this::grant).state()).isEqualTo("approved");
    }

    @Test
    void issuanceFailureIsSanitizedTerminalAndCannotBeRetried() {
        var row = submit(1);
        var calls = new AtomicInteger();
        var error = assertStatus(HttpStatus.INTERNAL_SERVER_ERROR, () -> inbox.approve(row.id(), row.code(), 1, approval -> {
            calls.incrementAndGet();
            assertThat(inbox.approve(row.id(), row.code(), 1, this::unexpectedIssue).state()).isEqualTo("failed");
            throw new IllegalStateException(bearer(1) + COMMITMENT);
        }));
        assertThat(error.getMessage()).isEqualTo("The access permission could not be committed safely.");
        assertThat(error.getCause()).isNull();
        assertThat(error.toString()).doesNotContain(bearer(1), COMMITMENT);
        assertThat(inbox.poll(bearer(1)).state()).isEqualTo("failed");
        assertThat(submit(1).grantId()).isNull();
        assertThat(inbox.approve(row.id(), row.code(), 1, this::unexpectedIssue).state()).isEqualTo("failed");
        assertThat(inbox.reject(row.id(), row.code()).state()).isEqualTo("failed");
        assertThat(inbox.cancel(bearer(1), id -> { throw new AssertionError(); }).state()).isEqualTo("failed");
        assertThat(calls).hasValue(1);
    }

    @Test
    void revokeFailureIsNeverCancellationSuccessAndKeepsGrantReferenceForPrimary() {
        var row = submit(1);
        var approved = inbox.approve(row.id(), row.code(), 1, this::grant);
        var calls = new AtomicInteger();
        var error = assertStatus(HttpStatus.INTERNAL_SERVER_ERROR, () -> inbox.cancel(bearer(1), id -> {
            calls.incrementAndGet();
            assertThat(id).isEqualTo(approved.grantId());
            throw new IllegalStateException(bearer(1) + COMMITMENT);
        }));
        assertThat(error.getCause()).isNull();
        assertThat(error.toString()).doesNotContain(bearer(1), COMMITMENT);
        var failed = inbox.poll(bearer(1));
        assertThat(failed.state()).isEqualTo("failed");
        assertThat(failed.grantId()).isEqualTo(approved.grantId());
        assertThat(failed.grantExpiresAt()).isEqualTo(approved.grantExpiresAt());
        assertThat(inbox.cancel(bearer(1), id -> calls.incrementAndGet())).isEqualTo(failed);
        assertThat(inbox.ownerItems(List.of()).getFirst().state()).isEqualTo("failed");
        assertThat(inbox.approve(row.id(), row.code(), 1, this::unexpectedIssue).state()).isEqualTo("failed");
        assertThat(calls).hasValue(1);
    }

    @Test
    void invalidIssuedGrantCannotBeReportedAsApprovedOrRetried() {
        List<Function<AccessRequestInbox.Approval, AccessGrantStore.Grant>> invalid = List.of(
                approval -> null,
                approval -> new AccessGrantStore.Grant(null, approval.name(), MODEL, time.now, time.now.plusSeconds(3600), null, "internet"),
                approval -> new AccessGrantStore.Grant(UUID.randomUUID(), approval.name(), "other", time.now, time.now.plusSeconds(3600), null, "internet"),
                approval -> new AccessGrantStore.Grant(UUID.randomUUID(), approval.name(), MODEL, time.now, time.now.plusSeconds(3600), null, "local"),
                approval -> new AccessGrantStore.Grant(UUID.randomUUID(), approval.name(), MODEL, null, time.now.plusSeconds(3600), null, "internet"),
                approval -> new AccessGrantStore.Grant(UUID.randomUUID(), approval.name(), MODEL, time.now, null, null, "internet"),
                approval -> new AccessGrantStore.Grant(UUID.randomUUID(), approval.name(), MODEL, time.now, time.now.plusSeconds(3600), time.now, "internet"),
                approval -> new AccessGrantStore.Grant(UUID.randomUUID(), approval.name(), MODEL, time.now, time.now.plusSeconds(3599), null, "internet"),
                approval -> new AccessGrantStore.Grant(UUID.randomUUID(), approval.name(), MODEL, time.now, time.now.plusSeconds(3601), null, "internet"),
                approval -> new AccessGrantStore.Grant(UUID.randomUUID(), approval.name(), MODEL, time.now.minusSeconds(1), time.now.plusSeconds(3599), null, "internet"),
                approval -> new AccessGrantStore.Grant(UUID.randomUUID(), approval.name(), MODEL, time.now.plusSeconds(1), time.now.plusSeconds(3601), null, "internet"));
        for (int i = 0; i < invalid.size(); i++) {
            time.advance(Duration.ofSeconds(10));
            var row = submit(i + 1);
            var issue = invalid.get(i);
            assertStatus(HttpStatus.INTERNAL_SERVER_ERROR, () -> inbox.approve(row.id(), row.code(), 1, issue));
            assertThat(inbox.approve(row.id(), row.code(), 1, this::unexpectedIssue).state()).isEqualTo("failed");
            assertThat(inbox.poll(bearer(i + 1)).grantId()).isNull();
        }
    }

    @Test
    void oneGrantCannotBeAttachedToTwoDifferentRequests() {
        var first = submit(1, "Same guest", COMMITMENT);
        var second = submit(2, "Same guest", OTHER_COMMITMENT);
        var committed = new AtomicReference<AccessGrantStore.Grant>();
        inbox.approve(first.id(), first.code(), 1, approval -> {
            committed.set(grant(approval));
            return committed.get();
        });
        assertStatus(HttpStatus.INTERNAL_SERVER_ERROR,
                () -> inbox.approve(second.id(), second.code(), 1, approval -> committed.get()));
        assertThat(inbox.poll(bearer(1)).state()).isEqualTo("approved");
        assertThat(inbox.poll(bearer(2)).state()).isEqualTo("failed");
    }

    @Test
    void commitmentIsCopiedOnConstructionAndEveryReadAndNeverAppearsInViews() throws Exception {
        byte[] hash = HexFormat.of().parseHex(COMMITMENT);
        var approval = new AccessRequestInbox.Approval("Guest", "012ABC", MODEL, "internet", hash, 1);
        hash[0] ^= 1;
        byte[] read = approval.secretHash();
        read[1] ^= 1;
        assertThat(approval.secretHash()).isEqualTo(HexFormat.of().parseHex(COMMITMENT));
        assertThat(approval.toString()).doesNotContain(COMMITMENT, Arrays.toString(approval.secretHash()));
        var row = submit(1);
        inbox.approve(row.id(), row.code(), 1, candidate -> {
            byte[] copy = candidate.secretHash();
            Arrays.fill(copy, (byte) 0);
            assertThat(candidate.secretHash()).isEqualTo(HexFormat.of().parseHex(COMMITMENT));
            return grant(candidate);
        });
        assertThat(submit(1).state()).isEqualTo("approved");
        assertStatus(HttpStatus.CONFLICT, () -> submit(1, "Guest 1", "00".repeat(32)));
        String bearerHash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(bearer(1).getBytes(StandardCharsets.US_ASCII)));
        for (Object value : List.of(inbox, context, row, inbox.poll(bearer(1)), inbox.ownerItems(List.of()))) {
            assertThat(value.toString()).doesNotContain(bearer(1), COMMITMENT, bearerHash);
        }
        assertThat(JSON.writeValueAsString(row)).doesNotContain(bearer(1), COMMITMENT, bearerHash);
        assertThat(JSON.writeValueAsString(inbox.ownerItems(List.of()))).doesNotContain(bearer(1), COMMITMENT, bearerHash);
    }

    @Test
    void jsonViewsHaveExactlyDocumentedFieldsAndExplicitNullsEvenWhenMapperOmitsNulls() throws Exception {
        var row = submit(1);
        var owner = inbox.ownerItems(List.of()).getFirst();
        var json = JsonMapper.builder().changeDefaultPropertyInclusion(
                ignored -> JsonInclude.Value.construct(JsonInclude.Include.NON_NULL, JsonInclude.Include.NON_NULL)).build();
        var guestJson = json.readTree(json.writeValueAsString(row));
        var ownerJson = json.readTree(json.writeValueAsString(owner));
        assertThat(guestJson.propertyNames()).containsExactlyInAnyOrder("version", "id", "state", "code", "name",
                "model", "channel", "expiresInSeconds", "grantId", "grantExpiresAt");
        assertThat(ownerJson.propertyNames()).containsExactlyInAnyOrder("version", "id", "state", "code", "name",
                "model", "channel", "expiresInSeconds", "grantId", "grantExpiresAt", "requestedAt");
        assertThat(guestJson.get("version").intValue()).isEqualTo(1);
        assertThat(guestJson.get("channel").stringValue()).isEqualTo("internet");
        assertThat(guestJson.get("grantId").isNull()).isTrue();
        assertThat(guestJson.get("grantExpiresAt").isNull()).isTrue();
        assertThat(ownerJson.get("grantId").isNull()).isTrue();
        assertThat(ownerJson.get("grantExpiresAt").isNull()).isTrue();
        assertThat(guestJson.get("code")).isEqualTo(ownerJson.get("code"));
        assertThat(row.code()).matches("[0-9A-HJKMNP-TV-Z]{6}");
        assertThatThrownBy(() -> inbox.ownerItems(List.of()).clear()).isInstanceOf(UnsupportedOperationException.class);
    }

    private String intakeId() { return context.intakeId().toString(); }
    private AccessRequestInbox.GuestView submit(int guest) { return submit(guest, "Guest " + guest, COMMITMENT); }
    private AccessRequestInbox.GuestView submit(int guest, String name, String commitment) {
        return inbox.submit(intakeId(), bearer(guest), name, MODEL, commitment);
    }
    private AccessGrantStore.Grant grant(AccessRequestInbox.Approval approval) {
        return new AccessGrantStore.Grant(UUID.randomUUID(), approval.name(), approval.model(), time.now,
                time.now.plus(Duration.ofHours(approval.hours())), null, approval.channel());
    }
    private AccessGrantStore.Grant unexpectedIssue(AccessRequestInbox.Approval ignored) {
        throw new AssertionError("A terminal request must not issue a grant");
    }
    private static String bearer(int guest) {
        byte[] bytes = new byte[32];
        ByteBuffer.wrap(bytes).putInt(guest);
        return "hgq1." + Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }
    private static GatewayException assertStatus(HttpStatus status, Runnable operation) {
        GatewayException error = assertThrows(GatewayException.class, operation::run);
        assertThat(error.status()).isEqualTo(status);
        assertThat(error.getCause()).isNull();
        return error;
    }
    private static void assertBusy(int retryAfter, Runnable operation) {
        var error = assertThrows(SharingService.GuestBusyException.class, operation::run);
        assertThat(error.retryAfter).isPositive().isEqualTo(retryAfter);
    }
    private void refillCreationFixture() throws Exception {
        Field field = AccessRequestInbox.class.getDeclaredField("creation");
        field.setAccessible(true);
        Object bucket = field.get(inbox);
        Field credit = bucket.getClass().getDeclaredField("credit");
        Field capacity = bucket.getClass().getDeclaredField("capacity");
        credit.setAccessible(true);
        capacity.setAccessible(true);
        credit.setLong(bucket, capacity.getLong(bucket));
    }

    private static final class TestTime extends Clock {
        Instant now = START;
        long nanos;
        void advance(Duration duration) {
            nanos += duration.toNanos();
            now = now.plus(duration);
        }
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return Clock.fixed(now, zone); }
        @Override public Instant instant() { return now; }
    }
}
