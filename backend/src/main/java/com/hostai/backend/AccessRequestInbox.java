package com.hostai.backend;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.LongSupplier;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;

/**
 * Bounded, internet-only request state. The caller must serialize EVERY operation, including
 * issue/revoke callbacks, under its SharingService monitor. No lifecycle, I/O, or lock is owned here.
 * Callbacks must commit durably before returning. A callback failure is terminal and sanitized;
 * the caller must handle uncertain storage outcomes by stopping sharing.
 *
 * <p>Codes are six uppercase Crockford characters, for matching displays, not verified identity.
 * Approval immediately grants durable permission; dropping this inbox does not revoke that grant.
 * Request deadlines and admission use the monotonic ticker; committed grant expiry uses Clock,
 * just as AccessGrantStore does. Buckets survive intake replacement and stop/start.
 */
public final class AccessRequestInbox {
    private static final long SECOND = 1_000_000_000L;
    private static final long PENDING_TTL = 600 * SECOND;
    private static final long RECORD_TTL = 900 * SECOND;
    private static final long RECOVERY_TIME = 60 * SECOND;
    private static final long POLL_INTERVAL = 2 * SECOND;
    private static final int MAX_PENDING = 10;
    private static final int MAX_RECORDS = 100;
    private static final int GENERATION_ATTEMPTS = 8;
    private static final String CHANNEL = "internet";
    private static final String CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    private static final Pattern BEARER = Pattern.compile("hgq1\\.[A-Za-z0-9_-]{43}");
    private static final Pattern COMMITMENT = Pattern.compile("[0-9a-f]{64}");

    private final Clock clock;
    private final LongSupplier ticker;
    private final SecureRandom random = new SecureRandom();
    private final Map<UUID, Row> rows = new LinkedHashMap<>();
    private final Bucket creation;
    private final Bucket authentication;
    private final Bucket discovery;
    private Context context;

    public AccessRequestInbox() { this(Clock.systemUTC(), System::nanoTime); }

    AccessRequestInbox(Clock clock, LongSupplier ticker) {
        this.clock = Objects.requireNonNull(clock);
        this.ticker = Objects.requireNonNull(ticker);
        long now = ticker.getAsLong();
        creation = new Bucket(6, 10 * SECOND, now);
        authentication = new Bucket(30, SECOND / 4, now);
        discovery = new Bucket(12, SECOND / 2, now);
    }

    public record Context(UUID intakeId, long attempt, String origin, String model, String hostLabel) {}

    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record GuestView(int version, UUID id, String state, String code, String name,
                            String model, String channel, long expiresInSeconds,
                            UUID grantId, Instant grantExpiresAt) {}

    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record OwnerView(int version, UUID id, String state, String code, String name,
                            String model, String channel, long expiresInSeconds,
                            UUID grantId, Instant grantExpiresAt, Instant requestedAt) {}

    public record Approval(String name, String code, String model, String channel,
                           byte[] secretHash, int hours) {
        public Approval {
            if (!CHANNEL.equals(channel) || secretHash == null || secretHash.length != 32
                    || hours < 1 || hours > 168) throw invalid();
            secretHash = secretHash.clone();
        }
        @Override public byte[] secretHash() { return secretHash.clone(); }
        @Override public String toString() { return "Approval[credentials=<redacted>]"; }
    }

    public Context start(long attempt, String origin, String model, String hostLabel) {
        sweep();
        if (attempt < 0 || !canonicalOrigin(origin) || ModelAdmission.reason(model) != null
                || hostLabel == null || hostLabel.isBlank() || hostLabel.length() > 80
                || hostLabel.chars().anyMatch(Character::isISOControl)) throw invalid();
        if (context != null && context.attempt() == attempt && context.origin().equals(origin)
                && context.model().equals(model) && context.hostLabel().equals(hostLabel)) return context;
        UUID intakeId = newId();
        rows.clear();
        context = new Context(intakeId, attempt, origin, model, hostLabel);
        return context;
    }

    public void stop() {
        sweep();
        rows.clear();
        context = null;
    }

    public Context context() {
        sweep();
        return context;
    }

    public GuestView submit(String intakeId, String bearer, String name, String model,
                            String accessCommitment) {
        long now = sweep();
        byte[] bearerHash = authenticate(bearer, now);
        requireContext();
        if (!context.intakeId().toString().equals(intakeId)) throw conflict();
        Row existing = findBearer(bearerHash);
        // Compare canonical immutable fields even on terminal rows. Invalid replacements are 409.
        String trimmed = name == null ? null : name.strip();
        if (existing != null) {
            if (!validText(name, Integer.MAX_VALUE) || !existing.name.equals(trimmed)
                    || !existing.model.equals(model) || !canonicalCommitment(accessCommitment)
                    || !MessageDigest.isEqual(existing.secretHash, HexFormat.of().parseHex(accessCommitment)))
                throw conflict();
            return guest(existing, now);
        }
        if (!validText(name, Integer.MAX_VALUE) || !validText(trimmed, 40)
                || !context.model().equals(model) || !canonicalCommitment(accessCommitment)) throw invalid();
        requireCapacity(now);
        creation.take(now);
        Row row = new Row(newId(), newCode(), bearerHash, trimmed, model,
                HexFormat.of().parseHex(accessCommitment), now, clock.instant());
        rows.put(row.id, row);
        return guest(row, now);
    }

    /** Anonymous discovery has its own budget and never spends an existing guest's allowance. */
    public void discover() { discovery.take(sweep()); }

    public GuestView poll(String bearer) {
        long now = sweep();
        Row row = guestRow(authenticate(bearer, now));
        if (row.polled && now - row.lastPoll < POLL_INTERVAL)
            throw busy(POLL_INTERVAL - (now - row.lastPoll));
        row.polled = true;
        row.lastPoll = now;
        return guest(row, now);
    }

    public OwnerView approve(UUID ownerId, String code, int hours,
                             Function<Approval, AccessGrantStore.Grant> issue) {
        long now = sweep();
        Row row = ownerRow(ownerId, code);
        if (hours < 1 || hours > 168) throw invalid();
        if (!row.state.equals("pending")) return owner(row, now);
        // Set before invoking external code: even an uncertain commit must never be retried.
        row.state = "failed";
        try {
            Instant began = clock.instant();
            AccessGrantStore.Grant grant = issue.apply(new Approval(row.name, row.code, row.model,
                    CHANNEL, row.secretHash, hours));
            Instant finished = clock.instant();
            long completed = ticker.getAsLong();
            if (!validGrant(grant, row, hours, began, finished)
                    || completed - row.created > RECORD_TTL - RECOVERY_TIME) throw callbackFailure();
            row.grantId = grant.id();
            row.grantExpiresAt = grant.expiresAt();
            row.state = "approved";
            return owner(row, completed);
        } catch (RuntimeException failure) {
            throw callbackFailure();
        }
    }

    public OwnerView reject(UUID ownerId, String code) {
        long now = sweep();
        Row row = ownerRow(ownerId, code);
        if (row.state.equals("pending")) row.state = "rejected";
        return owner(row, now);
    }

    public GuestView cancel(String bearer, Consumer<UUID> revoke) {
        long now = sweep();
        Row row = guestRow(authenticate(bearer, now));
        if (row.state.equals("pending")) row.state = "cancelled";
        else if (row.state.equals("approved")) {
            row.state = "failed";
            try {
                revoke.accept(row.grantId);
                row.state = "cancelled";
            } catch (RuntimeException failure) {
                throw callbackFailure();
            }
        }
        return guest(row, ticker.getAsLong());
    }

    /** Requires the caller's current, committed grant snapshot under the same monitor. */
    public List<OwnerView> ownerItems(List<AccessGrantStore.Grant> currentGrants) {
        long now = sweep();
        Objects.requireNonNull(currentGrants);
        List<OwnerView> result = new ArrayList<>();
        Instant wall = clock.instant();
        for (Row row : rows.values()) {
            if (row.state.equals("approved")) {
                AccessGrantStore.Grant grant = currentGrants.stream()
                        .filter(item -> item != null && row.grantId.equals(item.id())).findFirst().orElse(null);
                if (grant == null || grant.revokedAt() != null || !row.model.equals(grant.model())
                        || !CHANNEL.equals(grant.channel()) || !row.grantExpiresAt.equals(grant.expiresAt()))
                    row.state = "revoked";
                else if (!wall.isBefore(grant.expiresAt())) row.state = "expired";
            }
            result.add(owner(row, now));
        }
        return List.copyOf(result);
    }

    private long sweep() {
        long now = ticker.getAsLong();
        Instant wall = clock.instant();
        rows.values().removeIf(row -> now - row.created >= RECORD_TTL);
        for (Row row : rows.values()) {
            if (row.state.equals("pending") && now - row.created >= PENDING_TTL
                    || row.state.equals("approved") && !wall.isBefore(row.grantExpiresAt)) row.state = "expired";
        }
        return now;
    }

    private byte[] authenticate(String bearer, long now) {
        byte[] hash = null;
        if (bearer != null && BEARER.matcher(bearer).matches()) {
            byte[] decoded = Base64.getUrlDecoder().decode(bearer.substring(5));
            try {
                if (decoded.length == 32 && Base64.getUrlEncoder().withoutPadding()
                        .encodeToString(decoded).equals(bearer.substring(5)))
                    hash = MessageDigest.getInstance("SHA-256").digest(bearer.getBytes(StandardCharsets.US_ASCII));
            } catch (NoSuchAlgorithmException unavailable) {
                throw new GatewayException(HttpStatus.INTERNAL_SERVER_ERROR, "Access request hashing is unavailable.");
            } finally { java.util.Arrays.fill(decoded, (byte) 0); }
        }
        Row known = hash == null ? null : findBearer(hash);
        // Unknown traffic must not consume a real guest's ability to poll or cancel. Every
        // known row has its own bounded allowance, including idempotent POSTs and cancellation.
        if (known == null) authentication.take(now);
        else known.authentication.take(now);
        if (hash == null) throw unauthorized();
        return hash;
    }

    private Row findBearer(byte[] hash) {
        for (Row row : rows.values()) if (MessageDigest.isEqual(row.bearerHash, hash)) return row;
        return null;
    }

    private void requireContext() { if (context == null) throw missing(); }

    private Row guestRow(byte[] hash) {
        requireContext();
        Row row = findBearer(hash);
        if (row == null) throw missing();
        return row;
    }

    private Row ownerRow(UUID id, String code) {
        requireContext();
        Row row = rows.get(id);
        if (row == null || !row.code.equals(code)) throw missing();
        return row;
    }

    private void requireCapacity(long now) {
        boolean totalFull = rows.size() >= MAX_RECORDS;
        boolean pendingFull = rows.values().stream().filter(row -> row.state.equals("pending")).count() >= MAX_PENDING;
        if (!totalFull && !pendingFull) return;
        long wait = RECORD_TTL;
        for (Row row : rows.values()) {
            if (totalFull) wait = Math.min(wait, RECORD_TTL - (now - row.created));
            else if (row.state.equals("pending")) wait = Math.min(wait, PENDING_TTL - (now - row.created));
        }
        throw busy(wait);
    }

    private boolean validGrant(AccessGrantStore.Grant grant, Row row, int hours, Instant began, Instant finished) {
        if (grant == null || grant.id() == null
                || !row.model.equals(grant.model()) || !CHANNEL.equals(grant.channel())
                || grant.createdAt() == null || grant.expiresAt() == null || grant.revokedAt() != null) return false;
        Instant earliest = began.isBefore(finished) ? began : finished;
        Instant latest = began.isAfter(finished) ? began : finished;
        return !grant.createdAt().isBefore(earliest) && !grant.createdAt().isAfter(latest)
                && grant.expiresAt().equals(grant.createdAt().plus(Duration.ofHours(hours)))
                && grant.expiresAt().isAfter(finished)
                && rows.values().stream().noneMatch(other -> grant.id().equals(other.grantId));
    }

    private UUID newId() {
        for (int attempt = 0; attempt < GENERATION_ATTEMPTS; attempt++) {
            UUID id = UUID.randomUUID();
            if (!rows.containsKey(id) && (context == null || !context.intakeId().equals(id))) return id;
        }
        throw busy(SECOND);
    }

    private String newCode() {
        for (int attempt = 0; attempt < GENERATION_ATTEMPTS; attempt++) {
            StringBuilder value = new StringBuilder(6);
            for (int digit = 0; digit < 6; digit++) value.append(CROCKFORD.charAt(random.nextInt(32)));
            String code = value.toString();
            if (rows.values().stream().noneMatch(row -> row.code.equals(code))) return code;
        }
        throw busy(SECOND);
    }

    private static boolean canonicalCommitment(String value) {
        return value != null && COMMITMENT.matcher(value).matches();
    }

    private static boolean validText(String value, int maximum) {
        if (value == null || value.isBlank() || value.length() > maximum) return false;
        for (int i = 0; i < value.length(); i++) {
            int type = Character.getType(value.charAt(i));
            if (type == Character.CONTROL || type == Character.FORMAT || type == Character.SURROGATE
                    || type == Character.LINE_SEPARATOR || type == Character.PARAGRAPH_SEPARATOR
                    || type == Character.UNASSIGNED) return false;
        }
        return true;
    }

    private static boolean canonicalOrigin(String value) {
        if (value == null || value.length() > 2048) return false;
        try {
            URI uri = URI.create(value);
            String host = uri.getHost();
            int port = uri.getPort();
            return "https".equals(uri.getScheme()) && host != null && host.equals(host.toLowerCase(Locale.ROOT))
                    && !host.endsWith(".") && (port == -1 || port > 0 && port <= 65535 && port != 443)
                    && value.equals("https://" + host + (port == -1 ? "" : ":" + port));
        } catch (IllegalArgumentException invalid) { return false; }
    }

    private static long remaining(Row row, long now) {
        long ttl = row.state.equals("pending") ? PENDING_TTL : RECORD_TTL;
        return Math.min(900, seconds(Math.max(0, ttl - (now - row.created))));
    }

    private static GuestView guest(Row row, long now) {
        return new GuestView(1, row.id, row.state, row.code, row.name, row.model, CHANNEL,
                remaining(row, now), row.grantId, row.grantExpiresAt);
    }

    private static OwnerView owner(Row row, long now) {
        return new OwnerView(1, row.id, row.state, row.code, row.name, row.model, CHANNEL,
                remaining(row, now), row.grantId, row.grantExpiresAt, row.requestedAt);
    }

    private static long seconds(long nanos) { return nanos / SECOND + (nanos % SECOND == 0 ? 0 : 1); }
    private static SharingService.GuestBusyException busy(long nanos) {
        return new SharingService.GuestBusyException((int) Math.max(1, seconds(nanos)));
    }
    private static GatewayException invalid() {
        return new GatewayException(HttpStatus.BAD_REQUEST, "The access request fields are invalid.");
    }
    private static GatewayException unauthorized() {
        return new GatewayException(HttpStatus.UNAUTHORIZED, "The request credential is invalid.");
    }
    private static GatewayException missing() {
        return new GatewayException(HttpStatus.NOT_FOUND, "The access request is unavailable.");
    }
    private static GatewayException conflict() {
        return new GatewayException(HttpStatus.CONFLICT, "The access request context or fields have changed.");
    }
    private static GatewayException callbackFailure() {
        return new GatewayException(HttpStatus.INTERNAL_SERVER_ERROR, "The access permission could not be committed safely.");
    }

    private static final class Row {
        final UUID id;
        final String code;
        final byte[] bearerHash;
        final String name;
        final String model;
        final byte[] secretHash;
        final long created;
        final Instant requestedAt;
        final Bucket authentication;
        String state = "pending";
        UUID grantId;
        Instant grantExpiresAt;
        boolean polled;
        long lastPoll;

        Row(UUID id, String code, byte[] bearerHash, String name, String model, byte[] secretHash,
            long created, Instant requestedAt) {
            this.id = id;
            this.code = code;
            this.bearerHash = bearerHash;
            this.name = name;
            this.model = model;
            this.secretHash = secretHash;
            this.created = created;
            this.requestedAt = requestedAt;
            this.authentication = new Bucket(12, SECOND / 2, created);
        }
    }

    /** Integer token bucket, retaining fractional refill and safe across nanoTime wraparound. */
    private static final class Bucket {
        final long period;
        final long capacity;
        long credit;
        long last;

        Bucket(int burst, long period, long now) {
            this.period = period;
            this.capacity = burst * period;
            this.credit = capacity;
            this.last = now;
        }

        void take(long now) {
            long elapsed = now - last;
            if (elapsed > 0) {
                credit += Math.min(elapsed, capacity - credit);
                last = now;
            }
            if (credit < period) throw busy(period - credit);
            credit -= period;
        }
    }
}
