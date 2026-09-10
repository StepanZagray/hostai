import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_LISTINGS = 100;
export const FRESH_MS = 90_000;
export const RETAIN_MS = 15 * 60_000;
export const CHALLENGE_MS = 30_000;
// 256-call burst, then 40 calls/second (2,400/minute), shared by challenges
// and mutations. Enough for 100 hosts renewing together every 17 seconds.
export const DEFAULT_GLOBAL_ADMISSION = Object.freeze({ capacity: 256, refillMs: 25, maxKeys: 1 });

export class ProtocolError extends Error {
  constructor(status, code, retryAfter) {
    super(code);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const malformed = () => new ProtocolError(400, 'malformed_request');
const forbidden = () => new ProtocolError(403, 'invalid_proof');
export const unavailable = () => new ProtocolError(503, 'storage_unavailable');
export const limited = (seconds = 1) => new ProtocolError(429, 'admission_limited', seconds);

export function exactFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== fields.length
      || fields.some(field => !Object.hasOwn(value, field))) throw malformed();
}

// JSON.parse silently accepts duplicate keys. This bounded parser rejects them,
// including escaped aliases, before any signed data can affect registry state.
export function parseJson(bytes, maxBytes = MAX_BODY_BYTES) {
  if (!Buffer.isBuffer(bytes) || bytes.length > maxBytes) throw malformed();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw malformed(); }
  let offset = 0;
  const space = () => { while (/[\t\r\n ]/.test(text[offset] ?? 'x')) offset++; };
  const string = () => {
    const match = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(text.slice(offset));
    if (!match) throw malformed();
    offset += match[0].length;
    return JSON.parse(match[0]);
  };
  const value = depth => {
    if (depth > 5) throw malformed();
    space();
    const char = text[offset];
    if (char === '"') return string();
    if (char === '{' || char === '[') {
      const object = char === '{';
      const result = object ? Object.create(null) : [];
      const end = object ? '}' : ']';
      offset++;
      space();
      if (text[offset] === end) { offset++; return result; }
      for (;;) {
        space();
        let key;
        if (object) {
          key = string();
          if (Object.hasOwn(result, key)) throw malformed();
          space();
          if (text[offset++] !== ':') throw malformed();
        }
        const next = value(depth + 1);
        if (object) result[key] = next;
        else result.push(next);
        space();
        if (text[offset] === end) { offset++; return result; }
        if (text[offset++] !== ',') throw malformed();
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(offset));
    if (!token) throw malformed();
    offset += token[0].length;
    return JSON.parse(token[0]);
  };
  const result = value(0);
  space();
  if (offset !== text.length) throw malformed();
  return result;
}

function decodeBase64(value, length, maxBytes = MAX_BODY_BYTES) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)
      || value.length > Math.ceil(maxBytes * 4 / 3)) throw malformed();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value || (length !== undefined && bytes.length !== length)) throw malformed();
  return bytes;
}

export function identity(publicKey) {
  const der = decodeBase64(publicKey, 44, 44);
  // Ed25519's unique canonical DER SPKI representation: OID, no parameters,
  // exactly one 32-byte public key. Reject alternate encodings and key types.
  if (!der.subarray(0, 12).equals(Buffer.from('302a300506032b6570032100', 'hex'))) throw malformed();
  let key;
  try { key = createPublicKey({ key: der, format: 'der', type: 'spki' }); }
  catch { throw malformed(); }
  return { id: createHash('sha256').update(der).digest('hex'), key };
}

function printable(value, max) {
  return typeof value === 'string' && value.length >= 1 && value.length <= max
    && value === value.trim() && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value);
}

function isCanonicalOrigin(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && value === url.origin;
  } catch { return false; }
}

export function validateListing(value, version = Object.hasOwn(value ?? {}, 'requestsAccepted') ? 2 : 1) {
  exactFields(value, ['hostLabel', 'model', 'guestUrl', 'invitationRequired',
    ...(version === 2 ? ['requestsAccepted'] : [])]);
  if (version === 2 && typeof value.requestsAccepted !== 'boolean') throw malformed();
  if (!printable(value.hostLabel, 80) || !printable(value.model, 200)
      || !/^[A-Za-z0-9][A-Za-z0-9._/-]*:[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value.model)
      || value.model.endsWith(':cloud') || value.model.endsWith('-cloud')
      || value.invitationRequired !== true) throw malformed();
  // One DNS label owned by the quick-tunnel provider. Comparing the input to
  // the canonical href also rejects case, default ports and URL normalization.
  if (typeof value.guestUrl !== 'string'
      || !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com\/$/.test(value.guestUrl)) throw malformed();
  let url;
  try { url = new URL(value.guestUrl); } catch { throw malformed(); }
  if (url.href !== value.guestUrl || url.username || url.password || url.port
      || url.search || url.hash || url.pathname !== '/') throw malformed();
  return { hostLabel: value.hostLabel, model: value.model, guestUrl: value.guestUrl, invitationRequired: true,
    ...(version === 2 ? { requestsAccepted: value.requestsAccepted } : {}) };
}

export function epoch(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - RETAIN_MS) throw malformed();
  return value;
}

// Full buckets can be forgotten without granting additional admission. Depleted
// buckets are never evicted to make room for an attacker-controlled new key.
export class Admission {
  #entries = new Map();
  constructor({ capacity, refillMs, maxKeys }) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isSafeInteger(refillMs)
        || refillMs < 1 || !Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new TypeError('Invalid admission limits');
    this.capacity = capacity;
    this.refillMs = refillMs;
    this.maxKeys = maxKeys;
  }
  take(key, now) {
    for (const [id, entry] of this.#entries) {
      if (now - entry.at >= this.capacity * this.refillMs) this.#entries.delete(id);
    }
    let entry = this.#entries.get(key);
    if (!entry) {
      if (this.#entries.size >= this.maxKeys) throw limited(Math.ceil(this.capacity * this.refillMs / 1000));
      entry = { tokens: this.capacity, at: now };
      this.#entries.set(key, entry);
    }
    const elapsed = Math.max(0, now - entry.at);
    entry.tokens = Math.min(this.capacity, entry.tokens + elapsed / this.refillMs);
    entry.at = Math.max(now, entry.at);
    if (entry.tokens < 1) throw limited(Math.max(1, Math.ceil((1 - entry.tokens) * this.refillMs / 1000)));
    entry.tokens--;
  }
}

export class DirectoryProtocol {
  #nonces = new Map();
  #failed = false;
  constructor({ store, audience, clock = Date.now, random = randomBytes,
    maxChallenges = 256,
    globalAdmission = DEFAULT_GLOBAL_ADMISSION,
    keyAdmission = { capacity: 6, refillMs: 10_000, maxKeys: 1024 },
  }) {
    if (!store || typeof audience !== 'function' || !Number.isSafeInteger(maxChallenges)
        || maxChallenges < 1 || maxChallenges > 256) throw new TypeError('Invalid directory configuration');
    this.store = store;
    // Resolve only at mutation: a development listener may not yet have a port
    // during construction. This callback must come from trusted configuration.
    this.audience = audience;
    this.clock = clock;
    this.random = random;
    this.maxChallenges = maxChallenges;
    this.global = new Admission(globalAdmission);
    this.keys = new Admission(keyAdmission);
  }
  #storage(action) {
    if (this.#failed) throw unavailable();
    try { return action(); }
    catch (error) {
      if (error instanceof ProtocolError && error.status === 429) throw error;
      this.#failed = true;
      this.#nonces.clear();
      throw unavailable();
    }
  }
  assertAvailable() { this.#storage(() => this.store.assertAvailable()); }
  #admit(publicKey, now) {
    this.global.take('global', now);
    const owner = identity(publicKey);
    for (const [id, challenge] of this.#nonces) {
      if (challenge.expiresAt <= now) this.#nonces.delete(id);
    }
    return owner;
  }
  challenge(body, version = 1) {
    this.assertAvailable();
    exactFields(body, ['publicKey']);
    const now = epoch(this.clock());
    const { id } = this.#admit(body.publicKey, now);
    // Unsigned callers can retrieve a pending challenge, but cannot invalidate
    // an in-flight proof or prolong the original authentication window.
    const pending = this.#nonces.get(id);
    if (pending) return { version, ...pending };
    if (this.#nonces.size >= this.maxChallenges) throw limited(30);
    const bytes = this.random(32);
    if (!Buffer.isBuffer(bytes) || bytes.length !== 32) throw unavailable();
    const nonce = bytes.toString('base64url');
    const expiresAt = now + CHALLENGE_MS;
    this.#nonces.set(id, { nonce, expiresAt });
    return { version, nonce, expiresAt };
  }
  mutate(body, version = 1) {
    this.assertAvailable();
    exactFields(body, ['publicKey', 'payload', 'signature']);
    const now = epoch(this.clock());
    const { id, key } = this.#admit(body.publicKey, now);
    const bytes = decodeBase64(body.payload);
    const signature = decodeBase64(body.signature, 64, 64);
    const payload = parseJson(bytes);
    exactFields(payload, ['version', 'audience', 'nonce', 'operation', 'listing']);
    if (payload.version !== version || !['publish', 'withdraw'].includes(payload.operation)) throw malformed();
    if (!isCanonicalOrigin(payload.audience)) throw malformed();
    let audience;
    try { audience = this.audience(); } catch { throw unavailable(); }
    if (!isCanonicalOrigin(audience)) throw unavailable();
    if (payload.audience !== audience) throw forbidden();
    decodeBase64(payload.nonce, 32, 32);
    const listing = payload.operation === 'publish' ? validateListing(payload.listing, version) : null;
    if (payload.operation === 'withdraw' && payload.listing !== null) throw malformed();
    if (!verify(null, bytes, key, signature)) throw forbidden();
    const challenge = this.#nonces.get(id);
    if (!challenge || challenge.nonce !== payload.nonce || challenge.expiresAt <= now) throw forbidden();
    // Only a valid, fresh proof can charge its owner's budget. A rate rejection
    // leaves the nonce available until its original expiry for a later retry.
    this.keys.take(id, now);
    // Consume before the store runs, including capacity rejection or a failed
    // commit. A proof can never be retried after an uncertain storage result.
    this.#nonces.delete(id);
    const row = this.#storage(() => payload.operation === 'publish'
      ? this.store.publish(id, listing, now) : this.store.withdraw(id, now));
    return { version, id, state: row ? 'listed' : 'off',
      updatedAt: row?.updatedAt ?? null, expiresAt: row?.expiresAt ?? null };
  }
  list(version = 1) {
    this.assertAvailable();
    const servedAt = epoch(this.clock());
    const rows = this.#storage(() => this.store.list(servedAt));
    return { version, servedAt, listings: rows.map(({ requestsAccepted, ...row }) =>
      version === 2 ? { ...row, requestsAccepted: requestsAccepted ?? null } : row) };
  }
}
