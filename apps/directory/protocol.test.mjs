import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { DirectoryStore } from './store.mjs';
import { Admission, CHALLENGE_MS, DirectoryProtocol, FRESH_MS, identity, parseJson,
  ProtocolError, RETAIN_MS, validateListing } from './protocol.mjs';

const listing = { hostLabel: 'Private host', model: 'llama3.2:3b',
  guestUrl: 'https://quiet-silver-river.trycloudflare.com/', invitationRequired: true };
const audience = 'https://directory.example:8443';
const generous = { globalAdmission: { capacity: 10_000, refillMs: 1, maxKeys: 1 },
  keyAdmission: { capacity: 10_000, refillMs: 1, maxKeys: 1024 } };
function owner() {
  const pair = generateKeyPairSync('ed25519');
  const der = pair.publicKey.export({ format: 'der', type: 'spki' });
  return { ...pair, publicKey: der.toString('base64url'), id: createHash('sha256').update(der).digest('hex') };
}
function proof(owner, nonce, { operation = 'publish', value = listing, audience: targetAudience = audience, raw } = {}) {
  const bytes = Buffer.from(raw ?? JSON.stringify({ version: 1, audience: targetAudience, nonce,
    operation, listing: operation === 'withdraw' ? null : value }));
  return { publicKey: owner.publicKey, payload: bytes.toString('base64url'), signature: sign(null, bytes, owner.privateKey).toString('base64url') };
}
function status(code) {
  return error => error instanceof ProtocolError && error.status === code
    && (code !== 429 || Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0);
}
function fixture(t, options = generous) {
  const directory = mkdtempSync('/tmp/hostai-directory-protocol-');
  let store = new DirectoryStore(directory);
  let now = 1_800_000_000_000;
  let protocol = new DirectoryProtocol({ store, audience: () => audience, clock: () => now, ...options });
  t.after(() => {
    try { store.close(); }
    finally { rmSync(directory, { recursive: true, force: true }); assert.equal(existsSync(directory), false); }
  });
  return { get protocol() { return protocol; }, get store() { return store; },
    get now() { return now; }, advance(ms) { now += ms; },
    restart() { store.close(); store = new DirectoryStore(directory); protocol = new DirectoryProtocol({ store, audience: () => audience, clock: () => now, ...options }); },
    nonce(owner) { return protocol.challenge({ publicKey: owner.publicKey }).nonce; } };
}

test('exact-byte Ed25519 proof derives only its own id and cannot alter another listing', t => {
  const f = fixture(t);
  const a = owner();
  const b = owner();
  assert.equal(identity(a.publicKey).id, a.id);
  const nonce = f.nonce(a);
  const signed = proof(a, nonce, { raw: ` { "version":1, "audience":"${audience}", "nonce":"${nonce}", "operation":"publish", "listing":${JSON.stringify(listing)} }\n` });
  const tampered = { ...signed, payload: Buffer.from(Buffer.from(signed.payload, 'base64url').toString() + ' ').toString('base64url') };
  assert.throws(() => f.protocol.mutate(tampered), status(403));
  assert.throws(() => f.protocol.mutate({ ...signed, publicKey: b.publicKey }), status(403));
  assert.deepEqual(f.protocol.mutate(signed), { version: 1, id: a.id, state: 'listed', updatedAt: f.now, expiresAt: f.now + FRESH_MS });
  const bNonce = f.nonce(b);
  assert.throws(() => f.protocol.mutate(proof(b, bNonce, { value: { ...listing, id: a.id } })), status(400));
  f.protocol.mutate(proof(b, bNonce, { value: { ...listing, hostLabel: 'Second host' } }));
  f.protocol.mutate(proof(b, f.nonce(b), { operation: 'withdraw' }));
  assert.deepEqual(f.protocol.list().listings.map(row => row.id), [a.id]);
});

test('unsigned challenges preserve pending updates and original expiry; nonces are one shot and lost on restart', t => {
  let randomCalls = 0;
  const f = fixture(t, { ...generous, random: size => Buffer.alloc(size, ++randomCalls) });
  const a = owner();
  const b = owner();
  f.protocol.mutate(proof(a, f.nonce(a)));
  const first = f.protocol.challenge({ publicKey: a.publicKey });
  const signed = proof(a, first.nonce, { value: { ...listing, hostLabel: 'Pending update' } });
  assert.equal(first.expiresAt, f.now + CHALLENGE_MS);
  assert.equal(Buffer.from(first.nonce, 'base64url').length, 32);
  f.advance(CHALLENGE_MS - 1);
  assert.deepEqual(f.protocol.challenge({ publicKey: a.publicKey }), first);
  assert.equal(randomCalls, 2);
  f.nonce(b);
  assert.throws(() => f.protocol.mutate(proof(b, first.nonce)), status(403));
  f.protocol.mutate(signed);
  assert.equal(f.protocol.list().listings[0].hostLabel, 'Pending update');
  assert.throws(() => f.protocol.mutate(signed), status(403));
  const second = f.protocol.challenge({ publicKey: a.publicKey });
  assert.notEqual(second.nonce, first.nonce);
  const expiring = proof(a, second.nonce);
  f.advance(CHALLENGE_MS - 1);
  assert.deepEqual(f.protocol.challenge({ publicKey: a.publicKey }), second);
  f.advance(1);
  assert.throws(() => f.protocol.mutate(expiring), status(403));
  const third = f.protocol.challenge({ publicKey: a.publicKey });
  assert.notEqual(third.nonce, second.nonce);
  assert.equal(third.expiresAt, f.now + CHALLENGE_MS);
  const captured = proof(a, third.nonce);
  f.restart();
  assert.throws(() => f.protocol.mutate(captured), status(403));
  assert.throws(() => f.protocol.mutate(signed), status(403));
});

test('audience is required, exact and canonical, including scheme, case, port and slash', t => {
  const f = fixture(t, { ...generous, keyAdmission: { capacity: 1, refillMs: 10_000, maxKeys: 1 } });
  const a = owner();
  const nonce = f.nonce(a);
  assert.throws(() => f.protocol.mutate(proof(a, nonce, {
    raw: JSON.stringify({ version: 1, nonce, operation: 'publish', listing }),
  })), status(400));
  for (const targetAudience of [null, 1, {}, `${audience}/`, `${audience}/path`, `${audience}?`, `${audience}#`,
    'https://DIRECTORY.example:8443', 'HTTPS://directory.example:8443', 'https://directory.example:08443',
    'https://user@directory.example:8443', 'https://directory.example:443', 'null']) {
    assert.throws(() => f.protocol.mutate(proof(a, nonce, { audience: targetAudience })), status(400));
  }
  for (const targetAudience of ['https://directory.example:8444', 'http://directory.example:8443',
    'https://directory.example', 'https://attacker.example:8443']) {
    assert.throws(() => f.protocol.mutate(proof(a, nonce, { audience: targetAudience })), status(403));
  }
  const duplicate = `{"version":1,"audience":"${audience}","audience":"${audience}","nonce":"${nonce}","operation":"publish","listing":${JSON.stringify(listing)}}`;
  assert.throws(() => f.protocol.mutate(proof(a, nonce, { raw: duplicate })), status(400));
  assert.equal(f.protocol.mutate(proof(a, nonce)).state, 'listed');
});

test('a malicious registry cannot relay a proof even with an attacker-controlled matching nonce', t => {
  const target = fixture(t);
  const a = owner();
  const targetChallenge = target.protocol.challenge({ publicKey: a.publicKey });
  const attackerAudience = 'https://attacker.example';
  const attacker = fixture(t, { ...generous, audience: () => attackerAudience,
    random: () => Buffer.from(targetChallenge.nonce, 'base64url') });
  assert.equal(attacker.nonce(a), targetChallenge.nonce);
  const relayed = proof(a, attacker.nonce(a), { audience: attackerAudience });
  assert.throws(() => target.protocol.mutate(relayed), status(403));
  const rewritten = { ...relayed, payload: Buffer.from(JSON.stringify({ version: 1, audience,
    nonce: targetChallenge.nonce, operation: 'publish', listing })).toString('base64url') };
  assert.throws(() => target.protocol.mutate(rewritten), status(403));
  assert.deepEqual(target.protocol.list().listings, []);
  assert.equal(attacker.protocol.mutate(relayed).state, 'listed');
  const legitimate = proof(a, targetChallenge.nonce);
  assert.throws(() => attacker.protocol.mutate(legitimate), status(403));
  assert.equal(target.protocol.mutate(legitimate).state, 'listed');
});

test('the audience callback is required and its canonical result is checked at mutation', t => {
  const f = fixture(t);
  for (const invalid of [undefined, null, audience]) {
    assert.throws(() => new DirectoryProtocol({ store: f.store, audience: invalid }), TypeError);
  }
  let current;
  let calls = 0;
  const protocol = new DirectoryProtocol({ store: f.store, clock: () => f.now, audience: () => { calls++; return current; } });
  const a = owner();
  const nonce = protocol.challenge({ publicKey: a.publicKey }).nonce;
  assert.equal(calls, 0);
  const signed = proof(a, nonce);
  for (current of [undefined, `${audience}/`, 'https://DIRECTORY.example:8443', 'file:///tmp/registry']) {
    assert.throws(() => protocol.mutate(signed), status(503));
  }
  current = 'https://other.example';
  assert.throws(() => protocol.mutate(signed), status(403));
  current = audience;
  assert.equal(protocol.mutate(signed).state, 'listed');
});

test('17-second heartbeats for over 15 minutes survive unsigned, invalid, expired and replayed traffic', t => {
  const f = fixture(t, {}); // Exercise the real default global and per-key limits.
  const a = owner();
  const b = owner();
  const expired = proof(a, f.nonce(a));
  f.advance(CHALLENGE_MS);
  const start = f.now;
  let replay;
  for (let heartbeat = 0; heartbeat <= 60; heartbeat++) {
    if (heartbeat) f.advance(17_000);
    const nonce = f.nonce(a);
    const signed = proof(a, nonce);
    const invalid = { ...signed, signature: proof(b, nonce).signature };
    const unmatched = proof(a, Buffer.alloc(32, 255).toString('base64url'));
    for (let attempt = 0; attempt < 8; attempt++) {
      assert.equal(f.nonce(a), nonce);
      assert.throws(() => f.protocol.mutate(invalid), status(403));
      assert.throws(() => f.protocol.mutate(unmatched), status(403));
      assert.throws(() => f.protocol.mutate(expired), status(403));
      if (replay) assert.throws(() => f.protocol.mutate(replay), status(403));
    }
    assert.equal(f.protocol.mutate(signed).state, 'listed');
    replay = signed;
  }
  assert.ok(f.now - start > RETAIN_MS);
  assert.equal(f.protocol.list().listings[0].updatedAt, f.now);
  // The last heartbeat used one of six tokens. All five others remain despite
  // the invalid traffic; the seventh authenticated mutation must be limited.
  for (let i = 0; i < 5; i++) f.protocol.mutate(proof(a, f.nonce(a)));
  const pending = proof(a, f.nonce(a));
  assert.throws(() => f.protocol.mutate(pending), status(429));
  assert.throws(() => f.protocol.mutate(replay), status(403));
  f.advance(9999);
  assert.throws(() => f.protocol.mutate(pending), status(429));
  f.advance(1);
  assert.equal(f.protocol.mutate(pending).state, 'listed');
});

test('withdraw is signed, durable and idempotent; freshness and retention do not move on restart', t => {
  const f = fixture(t);
  const a = owner();
  const initial = f.protocol.mutate(proof(a, f.nonce(a)));
  f.advance(FRESH_MS + 1);
  f.restart();
  const stale = f.protocol.list().listings[0];
  assert.equal(stale.updatedAt, initial.updatedAt);
  assert.equal(stale.expiresAt, initial.expiresAt);
  assert.ok(stale.expiresAt < f.now);
  f.advance(RETAIN_MS - FRESH_MS - 1);
  assert.deepEqual(f.protocol.list().listings, []);
  f.restart();
  assert.deepEqual(f.protocol.list().listings, []);
  f.protocol.mutate(proof(a, f.nonce(a)));
  for (let i = 0; i < 2; i++) assert.deepEqual(f.protocol.mutate(proof(a, f.nonce(a), { operation: 'withdraw' })),
    { version: 1, id: a.id, state: 'off', updatedAt: null, expiresAt: null });
  f.restart();
  assert.deepEqual(f.protocol.list().listings, []);
});

test('strict JSON rejects duplicate keys, invalid UTF-8, excessive nesting and trailing data', () => {
  for (const value of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"x":1,}', '[1,]',
    '{"x":NaN}', '{"x":01}', '[] true', '\ufeff{}', '[[[[[[[0]]]]]]]']) {
    assert.throws(() => parseJson(Buffer.from(value)), status(400), value);
  }
  assert.throws(() => parseJson(Buffer.from([0xc0, 0xaf])), status(400));
  assert.throws(() => parseJson(Buffer.alloc(16 * 1024 + 1, 32)), status(400));
  assert.equal(parseJson(Buffer.from('{"escaped":"line\\nquote\\\"","n":-1.25e2}')).n, -125);
});

test('fixed schemas and canonical keys/signatures reject alternate encodings without consuming nonce', t => {
  const f = fixture(t);
  const a = owner();
  const nonce = f.nonce(a);
  const signed = proof(a, nonce);
  for (const request of [{ ...signed, id: a.id }, { ...signed, publicKey: a.publicKey + '=' },
    { ...signed, payload: signed.payload + '=' }, { ...signed, signature: signed.signature + '=' },
    { ...signed, signature: Buffer.alloc(63).toString('base64url') }, { ...signed, publicKey: Buffer.alloc(44).toString('base64url') }]) {
    assert.throws(() => f.protocol.mutate(request), status(400));
  }
  const payload = { version: 1, audience, nonce, operation: 'publish', listing };
  for (const value of [{ ...payload, id: a.id }, { ...payload, updatedAt: f.now }, { ...payload, version: '1' },
    { ...payload, nonce: nonce + '=' }, { ...payload, operation: 'remove' }, { ...payload, listing: null },
    { ...payload, operation: 'withdraw' }, { ...payload, listing: { ...listing, contact: 'no' } }]) {
    assert.throws(() => f.protocol.mutate(proof(a, nonce, { raw: JSON.stringify(value) })), status(400));
  }
  assert.throws(() => f.protocol.mutate(proof(a, nonce, { raw: `{"version":1,"version":1,"nonce":"${nonce}","operation":"publish","listing":${JSON.stringify(listing)}}` })), status(400));
  assert.throws(() => f.protocol.challenge({ publicKey: a.publicKey, extra: 1 }), status(400));
  assert.equal(f.protocol.mutate(signed).state, 'listed');
});

test('provider URLs are exact canonical credential-free quick-tunnel origins and public strings are bounded', () => {
  for (const guestUrl of ['http://a.trycloudflare.com/', 'https://a.trycloudflare.com', 'https://A.trycloudflare.com/',
    'https://a.trycloudflare.com:443/', 'https://a.trycloudflare.com:8443/', 'https://user@a.trycloudflare.com/',
    'https://a.trycloudflare.com/?', 'https://a.trycloudflare.com/#', 'https://a.trycloudflare.com/path',
    'https://a.trycloudflare.com/../', 'https://a.trycloudflare.com/%2e', 'https://a.trycloudflare.com./',
    'https://a.trycloudflare.com.evil.test/', 'https://evil.test/', 'https://a.b.trycloudflare.com/',
    'https://-a.trycloudflare.com/', 'https://a-.trycloudflare.com/', 'https://a_trycloudflare.com/',
    'https://trycloudflare.com/', 'https://127.0.0.1/', 'https://a.trycloudflare.com/\n',
    `https://${'a'.repeat(64)}.trycloudflare.com/`, 'https:\\a.trycloudflare.com\\']) {
    assert.throws(() => validateListing({ ...listing, guestUrl }), status(400), guestUrl);
  }
  for (const hostLabel of ['', ' ', ' untrimmed', 'untrimmed ', 'x'.repeat(81), 'line\nbreak', 'a\u007fb', 'a\u0085b', 'a\ud800b', 'a\u202eb']) {
    assert.throws(() => validateListing({ ...listing, hostLabel }), status(400));
  }
  for (const model of ['', 'untagged', 'model:', ':tag', 'model:tag\n', 'a:tag secret', 'a:cloud', 'a:1b-cloud', 'a:' + 'b'.repeat(199)]) {
    assert.throws(() => validateListing({ ...listing, model }), status(400));
  }
  for (const invitationRequired of [false, 'true', null]) assert.throws(() => validateListing({ ...listing, invitationRequired }), status(400));
  assert.equal(validateListing({ ...listing, hostLabel: 'Private 🦙', model: 'library/llama3.2:3b-q4_K_M' }).invitationRequired, true);
});

test('authenticated per-key limits preserve pending proofs; challenge and admission maps remain bounded', t => {
  const a = owner();
  const b = owner();
  const f = fixture(t, { ...generous, keyAdmission: { capacity: 2, refillMs: 1000, maxKeys: 2 }, maxChallenges: 1 });
  for (let i = 0; i < 2; i++) f.protocol.mutate(proof(a, f.nonce(a)));
  const nonce = f.nonce(a);
  const pending = proof(a, nonce);
  assert.throws(() => f.protocol.mutate(pending), status(429));
  assert.equal(f.nonce(a), nonce);
  assert.throws(() => f.nonce(b), status(429));
  f.advance(1000);
  assert.equal(f.protocol.mutate(pending).state, 'listed');
  assert.throws(() => f.protocol.mutate(pending), status(403));
  f.nonce(a);
  f.advance(CHALLENGE_MS);
  assert.equal(typeof f.nonce(b), 'string');
  const global = new DirectoryProtocol({ store: f.store, audience: () => audience, clock: () => f.now,
    globalAdmission: { capacity: 1, refillMs: 1000, maxKeys: 1 } });
  global.challenge({ publicKey: a.publicKey });
  assert.throws(() => global.challenge({ publicKey: b.publicKey }), status(429));
  // Admission precedes even public-key parsing, and therefore verification.
  assert.throws(() => global.mutate({ publicKey: 'invalid', payload: 'invalid', signature: 'invalid' }), status(429));
  const bounds = new Admission({ capacity: 1, refillMs: 1000, maxKeys: 2 });
  bounds.take('a', f.now);
  bounds.take('b', f.now);
  assert.throws(() => bounds.take('c', f.now), status(429));
  assert.throws(() => bounds.take('a', f.now - 1), status(429));
  bounds.take('c', f.now + 1000);
});

test('100 listings maximum; update existing id, consume full-store proof, evict on mutation', t => {
  const f = fixture(t);
  const owners = Array.from({ length: 101 }, owner);
  for (const a of owners.slice(0, 100)) f.protocol.mutate(proof(a, f.nonce(a)));
  assert.equal(f.protocol.list().listings.length, 100);
  const blocked = proof(owners[100], f.nonce(owners[100]));
  assert.throws(() => f.protocol.mutate(blocked), status(429));
  assert.throws(() => f.protocol.mutate(blocked), status(403));
  f.protocol.mutate(proof(owners[0], f.nonce(owners[0]), { value: { ...listing, hostLabel: 'Updated' } }));
  f.advance(RETAIN_MS);
  f.protocol.mutate(proof(owners[100], f.nonce(owners[100])));
  assert.deepEqual(f.protocol.list().listings.map(row => row.id), [owners[100].id]);
});

test('storage failures disable reads, challenges and mutations permanently', t => {
  const f = fixture(t);
  const a = owner();
  const signed = proof(a, f.nonce(a));
  const original = f.store.publish;
  f.store.publish = () => { throw new Error('simulated storage failure'); };
  assert.throws(() => f.protocol.mutate(signed), status(503));
  f.store.publish = original;
  assert.throws(() => f.protocol.mutate(signed), status(503));
  assert.throws(() => f.protocol.list(), status(503));
  assert.throws(() => f.nonce(a), status(503));
});

test('a fresh host replaces only the oldest expired listing when capacity is full', t => {
  const f = fixture(t);
  const owners = Array.from({ length: 102 }, owner);
  for (const a of owners.slice(0, 100)) {
    f.protocol.mutate(proof(a, f.nonce(a)));
    f.advance(1);
  }
  f.advance(FRESH_MS - 100); // Only the oldest row has expired, exactly at its boundary.
  f.protocol.mutate(proof(owners[100], f.nonce(owners[100])));
  let ids = f.protocol.list().listings.map(row => row.id);
  assert.equal(ids.length, 100);
  assert.equal(ids.includes(owners[0].id), false);
  assert.equal(ids.includes(owners[1].id), true);
  assert.equal(ids.includes(owners[100].id), true);
  assert.throws(() => f.protocol.mutate(proof(owners[101], f.nonce(owners[101]))), status(429));
  f.advance(1);
  f.protocol.mutate(proof(owners[101], f.nonce(owners[101])));
  f.restart();
  ids = f.protocol.list().listings.map(row => row.id);
  assert.equal(ids.length, 100);
  assert.equal(ids.includes(owners[1].id), false);
  assert.equal(ids.includes(owners[101].id), true);
});
