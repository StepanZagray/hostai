import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';
import { createDirectoryServer, DEFAULT_IP_ADMISSION, DEFAULT_REQUEST_ADMISSION } from './server.mjs';
import { DirectoryStore } from './store.mjs';
import { Admission, CHALLENGE_MS, DirectoryProtocol, FRESH_MS, RETAIN_MS } from './protocol.mjs';

const listing = { hostLabel: 'HTTP host', model: 'llama3.2:3b',
  guestUrl: 'https://http-fixture.trycloudflare.com/', invitationRequired: true };
const generous = { globalAdmission: { capacity: 10_000, refillMs: 1, maxKeys: 1 },
  keyAdmission: { capacity: 10_000, refillMs: 1, maxKeys: 1024 },
  requestAdmission: { capacity: 10_000, refillMs: 1, maxKeys: 1 },
  ipAdmission: { capacity: 10_000, refillMs: 1, maxKeys: 256 } };
function owner() {
  const pair = generateKeyPairSync('ed25519');
  const der = pair.publicKey.export({ format: 'der', type: 'spki' });
  return { ...pair, publicKey: der.toString('base64url'), id: createHash('sha256').update(der).digest('hex') };
}
function proof(owner, nonce, audience, value = listing, operation = 'publish', version = 1) {
  const bytes = Buffer.from(JSON.stringify({ version, audience, nonce, operation, listing: value }));
  return { publicKey: owner.publicKey, payload: bytes.toString('base64url'), signature: sign(null, bytes, owner.privateKey).toString('base64url') };
}
async function fixture(t, options = generous) {
  const root = mkdtempSync('/tmp/hostai-directory-http-');
  const staticRoot = join(root, 'static');
  mkdirSync(join(staticRoot, 'assets'), { recursive: true, mode: 0o700 });
  writeFileSync(join(staticRoot, 'directory.html'), '<!doctype html><title>Directory fixture</title>');
  writeFileSync(join(staticRoot, 'assets', 'directory-a1.js'), 'export const directory = true;');
  writeFileSync(join(root, 'outside.js'), 'OUTSIDE_STATIC_ROOT');
  let now = 1_800_000_000_000;
  let store;
  let server;
  const clients = new Set();
  async function close() {
    const closedClients = [...clients].map(client => new Promise(resolveClose => {
      client.once('close', resolveClose);
      client.destroy();
    }));
    await Promise.all(closedClients);
    if (server?.listening) {
      const closed = new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
      server.closeAllConnections();
      await closed;
    }
    if (server) assert.equal(server.listening, false);
    store?.close();
  }
  async function start() {
    store = new DirectoryStore(join(root, 'data'));
    server = createDirectoryServer({ store, staticRoot, clock: () => now, ...options });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }
  t.after(async () => {
    try { await close(); }
    finally { rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false); }
    assert.equal(clients.size, 0);
  });
  await start();
  const f = { root, staticRoot, get port() { return server.address().port; }, get server() { return server; },
    get origin() { return options.publicOrigin ? new URL(options.publicOrigin).origin : `http://127.0.0.1:${f.port}`; },
    get now() { return now; }, advance(ms) { now += ms; }, async restart() { await close(); await start(); },
    async call(path, { method = 'GET', json, raw, headers = {} } = {}) {
      const bytes = raw ?? (json === undefined ? undefined : Buffer.from(JSON.stringify(json)));
      return await new Promise((resolveResponse, reject) => {
        const req = request({ host: '127.0.0.1', port: f.port, path, method, agent: false,
          headers: { ...(bytes === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': bytes.length }), ...headers } }, res => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('error', reject);
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString();
            let json;
            try { json = JSON.parse(text); } catch { /* Static and intentionally malformed fixtures. */ }
            resolveResponse({ status: res.statusCode, headers: res.headers, text, json });
          });
        });
        req.on('socket', socket => { clients.add(socket); socket.once('close', () => clients.delete(socket)); });
        req.setTimeout(2500, () => req.destroy(new Error('HTTP fixture deadline')));
        req.on('error', reject);
        req.end(bytes);
      });
    },
    async nonce(a, headers = {}) {
      const response = await f.call('/registry/v1/challenges', { method: 'POST', json: { publicKey: a.publicKey }, headers });
      assert.equal(response.status, 200, response.text);
      return response.json.nonce;
    },
    async mutate(json, headers = {}) { return f.call('/registry/v1/listings', { method: 'POST', json, headers }); },
    socket() {
      const socket = connect(f.port, '127.0.0.1');
      clients.add(socket);
      socket.once('close', () => clients.delete(socket));
      return socket;
    },
  };
  return f;
}

test('actual HTTP signed publication, signature/id isolation, replay, nonce expiry, restart and withdraw', async t => {
  const f = await fixture(t);
  const a = owner();
  const b = owner();
  const nonce = await f.nonce(a);
  const signed = proof(a, nonce, f.origin);
  assert.equal((await f.mutate({ ...signed, publicKey: b.publicKey })).status, 403);
  assert.equal((await f.mutate(proof(b, nonce, f.origin))).status, 403);
  const success = await f.mutate(signed);
  assert.deepEqual(success.json, { version: 1, id: a.id, state: 'listed', updatedAt: f.now, expiresAt: f.now + FRESH_MS });
  assert.equal((await f.mutate(signed)).status, 403);
  const rows = await f.call('/registry/v1/listings');
  assert.deepEqual(rows.json, { version: 1, servedAt: f.now,
    listings: [{ id: a.id, ...listing, updatedAt: f.now, expiresAt: f.now + FRESH_MS }] });
  assert.equal(rows.headers['cache-control'], 'no-store');
  assert.equal(rows.headers['access-control-allow-origin'], undefined);
  assert.equal(rows.headers['set-cookie'], undefined);
  assert.equal((await f.mutate(proof(b, await f.nonce(b), f.origin, null, 'withdraw'))).status, 200);
  assert.equal((await f.call('/registry/v1/listings')).json.listings.length, 1);
  const expired = proof(a, await f.nonce(a), f.origin);
  f.advance(CHALLENGE_MS);
  assert.equal((await f.mutate(expired)).status, 403);
  const capturedNonce = await f.nonce(a);
  const captured = proof(a, capturedNonce, f.origin);
  assert.equal(await f.nonce(a), capturedNonce);
  await f.restart();
  // Re-sign for the new ephemeral port to isolate loss of the pending nonce.
  assert.equal((await f.mutate(proof(a, capturedNonce, f.origin))).status, 403);
  assert.equal((await f.mutate(captured)).status, 403);
  assert.equal((await f.mutate(signed)).status, 403);
  f.advance(FRESH_MS);
  assert.equal((await f.call('/registry/v1/listings')).json.listings[0].expiresAt, success.json.expiresAt);
  for (let i = 0; i < 2; i++) assert.deepEqual((await f.mutate(proof(a, await f.nonce(a), f.origin, null, 'withdraw'))).json,
    { version: 1, id: a.id, state: 'off', updatedAt: null, expiresAt: null });
  await f.restart();
  assert.deepEqual((await f.call('/registry/v1/listings')).json.listings, []);
});

test('actual v2 HTTP publication replaces capability while v1 reads remain exact through restart', async t => {
  const f = await fixture(t);
  const a = owner();
  const config = await f.call('/registry/v2/config');
  assert.equal(config.status, 200);
  assert.deepEqual(config.json, { version: 2, registration: 'open', invitationRequired: true });
  for (const requestsAccepted of [true, false, null]) {
    const version = requestsAccepted === null ? 1 : 2;
    const challenge = await f.call(`/registry/v${version}/challenges`,
      { method: 'POST', json: { publicKey: a.publicKey } });
    assert.equal(challenge.status, 200);
    assert.deepEqual(challenge.json,
      { version, nonce: challenge.json.nonce, expiresAt: f.now + CHALLENGE_MS });
    const value = { ...listing, ...(version === 2 ? { requestsAccepted } : {}) };
    const response = await f.call(`/registry/v${version}/listings`,
      { method: 'POST', json: proof(a, challenge.json.nonce, f.origin, value, 'publish', version) });
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.json,
      { version, id: a.id, state: 'listed', updatedAt: f.now, expiresAt: f.now + FRESH_MS });
    await f.restart();
    const row = { id: a.id, ...listing, updatedAt: f.now, expiresAt: f.now + FRESH_MS };
    const current = await f.call('/registry/v2/listings');
    assert.equal(current.status, 200);
    assert.deepEqual(current.json, { version: 2, servedAt: f.now,
      listings: [{ ...row, requestsAccepted }] });
    const legacy = await f.call('/registry/v1/listings');
    assert.equal(legacy.status, 200);
    assert.deepEqual(legacy.json, { version: 1, servedAt: f.now, listings: [row] });
    f.advance(1000);
  }
});

test('HTTP rejects signed version/path mismatches, malformed capability and capability tampering', async t => {
  const f = await fixture(t);
  const a = owner();
  const nonce = await f.nonce(a);
  const current = proof(a, nonce, f.origin, { ...listing, requestsAccepted: true }, 'publish', 2);
  for (const [version, json] of [[1, current], [2, proof(a, nonce, f.origin)],
    [1, proof(a, nonce, f.origin, { ...listing, requestsAccepted: true })],
    [2, proof(a, nonce, f.origin, listing, 'publish', 2)],
    [2, proof(a, nonce, f.origin, { ...listing, requestsAccepted: 'false' }, 'publish', 2)]]) {
    const response = await f.call(`/registry/v${version}/listings`, { method: 'POST', json });
    assert.equal(response.status, 400, response.text);
    assert.deepEqual(response.json, { version, error: 'malformed_request' });
  }
  const payload = JSON.parse(Buffer.from(current.payload, 'base64url').toString());
  payload.listing.requestsAccepted = false;
  const tampered = await f.call('/registry/v2/listings', { method: 'POST',
    json: { ...current, payload: Buffer.from(JSON.stringify(payload)).toString('base64url') } });
  assert.equal(tampered.status, 403);
  assert.deepEqual(tampered.json, { version: 2, error: 'invalid_proof' });
  assert.deepEqual((await f.call('/registry/v2/listings')).json.listings, []);
  const published = await f.call('/registry/v2/listings', { method: 'POST', json: current });
  assert.equal(published.status, 200, published.text);
  assert.equal((await f.call('/registry/v2/listings')).json.listings[0].requestsAccepted, true);
});

test('HTTP unsigned challenges cannot replace a pending signed update or extend its expiry', async t => {
  const f = await fixture(t);
  const a = owner();
  assert.equal((await f.mutate(proof(a, await f.nonce(a), f.origin))).status, 200);
  const challenge = async () => {
    const response = await f.call('/registry/v1/challenges', { method: 'POST', json: { publicKey: a.publicKey } });
    assert.equal(response.status, 200);
    return response.json;
  };
  const first = await challenge();
  const signed = proof(a, first.nonce, f.origin, { ...listing, hostLabel: 'Pending HTTP update' });
  f.advance(CHALLENGE_MS - 1);
  assert.deepEqual(await challenge(), first);
  assert.equal((await f.mutate(signed)).status, 200);
  assert.equal((await f.call('/registry/v1/listings')).json.listings[0].hostLabel, 'Pending HTTP update');
  assert.equal((await f.mutate(signed)).status, 403);
  const second = await challenge();
  assert.notEqual(second.nonce, first.nonce);
  f.advance(CHALLENGE_MS - 1);
  assert.deepEqual(await challenge(), second);
  f.advance(1);
  assert.equal((await f.mutate(proof(a, second.nonce, f.origin))).status, 403);
  const third = await challenge();
  assert.notEqual(third.nonce, second.nonce);
  assert.equal(third.expiresAt, f.now + CHALLENGE_MS);
});

test('actual HTTP proofs bind the configured canonical origin and ignore forwarding claims', async t => {
  // A configured trailing slash is accepted, but the signed audience has none.
  const f = await fixture(t, { ...generous, publicOrigin: 'https://directory.example:8443/' });
  const a = owner();
  const headers = { Host: 'directory.example:8443', Origin: f.origin,
    Forwarded: 'host=attacker.example;proto=https', 'X-Forwarded-Host': 'attacker.example',
    'X-Forwarded-Proto': 'http' };
  const nonce = await f.nonce(a, headers);
  for (const [targetAudience, expectedStatus] of [
    [undefined, 400], [`${f.origin}/`, 400], ['https://DIRECTORY.example:8443', 400],
    ['HTTPS://directory.example:8443', 400], ['https://directory.example:8444', 403],
    ['http://directory.example:8443', 403], ['https://directory.example', 403],
    [`http://127.0.0.1:${f.port}`, 403], ['https://attacker.example', 403],
  ]) {
    const response = await f.mutate(proof(a, nonce, targetAudience), headers);
    assert.equal(response.status, expectedStatus, String(targetAudience));
  }
  const signed = proof(a, nonce, f.origin);
  assert.deepEqual(Object.keys(JSON.parse(Buffer.from(signed.payload, 'base64url'))),
    ['version', 'audience', 'nonce', 'operation', 'listing']);
  assert.deepEqual(Object.keys(signed), ['publicKey', 'payload', 'signature']);
  assert.equal((await f.mutate(signed, headers)).status, 200);
  const withdrawal = proof(a, await f.nonce(a, headers), f.origin, null, 'withdraw');
  assert.equal((await f.mutate(withdrawal, headers)).json.state, 'off');
});

test('actual loopback audiences isolate registries even when a malicious registry copies the nonce', async t => {
  const target = await fixture(t);
  const a = owner();
  const nonce = await target.nonce(a);
  const attacker = await fixture(t, { ...generous, random: () => Buffer.from(nonce, 'base64url') });
  assert.notEqual(target.origin, attacker.origin);
  assert.equal(await attacker.nonce(a), nonce);
  const relayed = proof(a, nonce, attacker.origin);
  assert.equal((await target.mutate(relayed, { 'X-Forwarded-Host': `127.0.0.1:${attacker.port}` })).status, 403);
  assert.deepEqual((await target.call('/registry/v1/listings')).json.listings, []);
  assert.equal((await attacker.mutate(relayed)).status, 200);
  assert.equal((await target.mutate(proof(a, nonce, target.origin))).status, 200);
});

test('HTTP malformed URLs, bodies and schemas fail; nothing can select an arbitrary id', async t => {
  const f = await fixture(t);
  const a = owner();
  for (const path of ['/registry/v1/listings?x=1', '//registry/v1/listings', '/registry/v1/%6cistings',
    '/registry/v1/../listings', '/registry/v1/listings#fragment', '/registry\\v1\\listings', 'http://evil.test/registry/v1/listings']) {
    assert.equal((await f.call(path)).status, 400, path);
  }
  for (const raw of [Buffer.from('{'), Buffer.from('{}{}'), Buffer.from('{"publicKey":"x","publicKey":"y"}'),
    Buffer.from([0xff]), Buffer.from('[]'), Buffer.alloc(16 * 1024 + 1, 32)]) {
    assert.equal((await f.call('/registry/v1/challenges', { method: 'POST', raw })).status, 400);
  }
  for (const headers of [{ 'Content-Type': 'text/plain' }, { 'Content-Type': 'application/json; charset=latin1' },
    { 'Content-Encoding': 'gzip' }, { Expect: '100-continue' }]) {
    assert.equal((await f.call('/registry/v1/challenges', { method: 'POST', json: { publicKey: a.publicKey }, headers })).status, 400);
  }
  const nonce = await f.nonce(a);
  for (const value of [{ ...listing, id: a.id }, { ...listing, invitationRequired: false },
    { ...listing, guestUrl: 'https://http-fixture.trycloudflare.com:443/' }, { ...listing, guestUrl: 'https://user@http-fixture.trycloudflare.com/' },
    { ...listing, guestUrl: 'https://http-fixture.trycloudflare.com/?key=secret' }, { ...listing, hostLabel: '\nunsafe' }]) {
    assert.equal((await f.mutate(proof(a, nonce, f.origin, value))).status, 400);
  }
  assert.equal((await f.mutate(proof(a, nonce, f.origin))).status, 200);
  assert.equal((await f.call('/registry/v1/listings', { raw: Buffer.from('{}') })).status, 400);
});

test('HTTP host/origin checks are exact and ignore forwarded headers', async t => {
  const f = await fixture(t);
  for (const headers of [{ Host: 'evil.test' }, { Host: `localhost:${f.port}` }, { Host: `127.0.0.1:${f.port + 1}` },
    { Origin: 'null' }, { Origin: 'https://evil.test' }, { Origin: `http://127.0.0.1:${f.port}/` },
    { Host: 'evil.test', Forwarded: `host=127.0.0.1:${f.port}`, 'X-Forwarded-Host': `127.0.0.1:${f.port}` }]) {
    assert.equal((await f.call('/registry/v1/listings', { headers })).status, 403);
  }
  assert.equal((await f.call('/registry/v1/listings', { headers: { Origin: `http://127.0.0.1:${f.port}`, 'X-Forwarded-Host': 'evil.test' } })).status, 200);
  const publicFixture = await fixture(t, { ...generous, publicOrigin: 'https://directory.example:8443' });
  assert.equal((await publicFixture.call('/registry/v1/listings')).status, 403);
  assert.equal((await publicFixture.call('/registry/v1/listings', { headers: { Host: 'directory.example:8443', Origin: 'https://directory.example:8443' } })).status, 200);
  assert.equal((await publicFixture.call('/registry/v1/listings', { headers: { Host: 'directory.example:8443', Origin: 'http://directory.example:8443' } })).status, 403);
  for (const publicOrigin of ['http://directory.example', 'https://user@directory.example', 'https://directory.example/path',
    'https://directory.example/?', 'https://directory.example/#', 'https://DIRECTORY.example', 'http://127.0.0.1:8090']) {
    assert.throws(() => createDirectoryServer({ store: {}, publicOrigin }), TypeError);
  }
  assert.doesNotThrow(() => createDirectoryServer({ store: {}, publicOrigin: 'http://127.0.0.1:8090', allowLoopbackDevelopment: true }));
});

test('static responses stay inside the directory bundle and have restrictive headers', async t => {
  const f = await fixture(t);
  for (const path of ['/', '/directory.html', '/assets/directory-a1.js']) {
    const res = await f.call(path);
    assert.equal(res.status, 200);
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.match(res.headers['content-security-policy'], /connect-src 'self'/);
    assert.ok(!res.headers['content-security-policy'].includes('unsafe-inline'));
  }
  symlinkSync(join(f.root, 'outside.js'), join(f.staticRoot, 'assets', 'leak.js'));
  for (const path of ['/assets/leak.js', '/outside.js', '/server.mjs', '/registry.sqlite', '/assets/.env', '/assets/directory-a1.js.map',
    '/assets/sub/directory-a1.js', '/api/status', '/api/access-grants', '/directory/anything', '/assets/../directory.html',
    '/assets/%2e%2e/outside.js', '/assets/%2Foutside.js']) {
    const response = await f.call(path);
    assert.ok([400, 404].includes(response.status), path);
    assert.ok(!response.text.includes('OUTSIDE_STATIC_ROOT'));
  }
  renameSync(join(f.staticRoot, 'assets'), join(f.root, 'old-assets'));
  symlinkSync(f.root, join(f.staticRoot, 'assets'));
  assert.equal((await f.call('/assets/outside.js')).status, 404);
  renameSync(f.staticRoot, join(f.root, 'old-static'));
  symlinkSync(join(f.root, 'old-static'), f.staticRoot);
  assert.equal((await f.call('/')).status, 404);
});

test('HTTP per-key, per-peer, global and challenge-capacity limits include Retry-After', async t => {
  const a = owner();
  const b = owner();
  const key = await fixture(t, { ...generous, keyAdmission: { capacity: 1, refillMs: 1000, maxKeys: 2 } });
  const first = await key.nonce(a);
  for (let i = 0; i < 8; i++) assert.equal(await key.nonce(a), first);
  assert.equal((await key.mutate(proof(a, first, key.origin))).status, 200);
  const pendingNonce = await key.nonce(a);
  const pending = proof(a, pendingNonce, key.origin);
  const invalid = { ...pending, signature: proof(b, pendingNonce, key.origin).signature };
  assert.equal((await key.mutate(invalid)).status, 403);
  let response = await key.mutate(pending);
  assert.equal(response.status, 429);
  assert.match(response.headers['retry-after'], /^[1-9][0-9]*$/);
  assert.equal(await key.nonce(a), pendingNonce);
  key.advance(1000);
  assert.equal((await key.mutate(pending)).status, 200);
  assert.equal((await key.mutate(pending)).status, 403);
  const ip = await fixture(t, { ...generous, ipAdmission: { capacity: 1, refillMs: 1000, maxKeys: 1 } });
  assert.equal((await ip.call('/registry/v1/listings', { headers: { 'X-Forwarded-For': '1.2.3.4' } })).status, 200);
  response = await ip.call('/registry/v1/listings', { headers: { 'X-Forwarded-For': '4.3.2.1', Forwarded: 'for=4.3.2.1' } });
  assert.equal(response.status, 429);
  assert.equal(response.headers['retry-after'], '1');
  ip.advance(1000);
  assert.equal((await ip.call('/registry/v1/listings')).status, 200);
  const global = await fixture(t, { ...generous, requestAdmission: { capacity: 1, refillMs: 1000, maxKeys: 1 } });
  assert.equal((await global.call('/registry/v1/config')).status, 200);
  assert.equal((await global.call('/registry/v1/config')).status, 429);
  const nonces = await fixture(t, { ...generous, maxChallenges: 1 });
  await nonces.nonce(a);
  assert.equal((await nonces.call('/registry/v1/challenges', { method: 'POST', json: { publicKey: b.publicKey } })).status, 429);
  nonces.advance(CHALLENGE_MS);
  await nonces.nonce(b);
});

test('default shared-proxy budgets sustain 100 hosts every 17 seconds plus readers for 17 minutes', () => {
  let now = 1_800_000_000_000;
  let mutations = 0;
  let calls = 0;
  // This is an admission simulation with real proofs, not a SQLite throughput
  // benchmark. The HTTP/store integration tests exercise persistence separately.
  const store = { assertAvailable() {}, list() { return []; }, publish(_id, _value, at) {
    mutations++;
    return { updatedAt: at, expiresAt: at + FRESH_MS };
  } };
  const audience = 'https://directory.example';
  const protocol = new DirectoryProtocol({ store, clock: () => now, audience: () => audience });
  const requests = new Admission(DEFAULT_REQUEST_ADMISSION);
  const peers = new Admission(DEFAULT_IP_ADMISSION);
  const hosts = Array.from({ length: 100 }, owner);
  const sharedPeer = action => {
    requests.take('global', now);
    peers.take('127.0.0.1', now);
    calls++;
    return action();
  };
  for (let heartbeat = 0; heartbeat <= 60; heartbeat++) {
    if (heartbeat) now += 17_000;
    const nonces = hosts.map(a => sharedPeer(() => protocol.challenge({ publicKey: a.publicKey })).nonce);
    for (const [index, a] of hosts.entries()) {
      assert.equal(sharedPeer(() => protocol.mutate(proof(a, nonces[index], audience))).state, 'listed');
    }
    for (let reader = 0; reader < 50; reader++) sharedPeer(() => protocol.list());
  }
  assert.equal(mutations, 6100);
  assert.equal(calls, 15_250);
  // Check the actual default protocol limiter as well as the HTTP defaults:
  // increasing throughput must not remove their burst ceilings.
  now += 17_000;
  const limited = error => error.status === 429 && error.retryAfter === 1;
  for (let i = 0; i < 256; i++) protocol.challenge({ publicKey: hosts[0].publicKey });
  assert.throws(() => protocol.challenge({ publicKey: hosts[0].publicKey }), limited);
  for (let i = 0; i < 256; i++) peers.take('127.0.0.1', now);
  assert.throws(() => peers.take('127.0.0.1', now), limited);
  for (let i = 0; i < 512; i++) requests.take('global', now);
  assert.throws(() => requests.take('global', now), limited);
});

test('HTTP full listing capacity rejects, then admits after retention eviction without a read', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 100; i++) {
    const a = owner();
    assert.equal((await f.mutate(proof(a, await f.nonce(a), f.origin))).status, 200);
  }
  const a = owner();
  const signed = proof(a, await f.nonce(a), f.origin);
  const full = await f.mutate(signed);
  assert.equal(full.status, 429);
  assert.equal(full.headers['retry-after'], '90');
  assert.equal((await f.mutate(signed)).status, 403);
  await f.restart();
  assert.equal((await f.call('/registry/v1/listings')).json.listings.length, 100);
  f.advance(RETAIN_MS);
  assert.equal((await f.mutate(proof(a, await f.nonce(a), f.origin))).status, 200);
  assert.deepEqual((await f.call('/registry/v1/listings')).json.listings.map(row => row.id), [a.id]);
});

test('actual storage failure returns 503 for all registry operations, including after path repair', async t => {
  const f = await fixture(t);
  const a = owner();
  const signed = proof(a, await f.nonce(a), f.origin);
  const db = join(f.root, 'data', 'registry.sqlite');
  chmodSync(db, 0o644);
  assert.equal((await f.mutate(signed)).status, 503);
  chmodSync(db, 0o600);
  assert.equal((await f.call('/registry/v1/listings')).status, 503);
  assert.equal((await f.call('/registry/v1/config')).status, 503);
  assert.equal((await f.call('/registry/v1/challenges', { method: 'POST', json: { publicKey: a.publicKey } })).status, 503);
  assert.equal((await f.mutate(signed)).status, 503);
});

test('chunked bodies are capped; partial headers/uploads close within the five-second deadline', { timeout: 9000 }, async t => {
  const f = await fixture(t);
  const chunked = f.socket();
  await once(chunked, 'connect');
  const response = [];
  chunked.on('data', bytes => response.push(bytes));
  const chunkClosed = once(chunked, 'close');
  chunked.write(`POST /registry/v1/challenges HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n4001\r\n${'x'.repeat(16 * 1024 + 1)}\r\n0\r\n\r\n`);
  await chunkClosed;
  assert.match(Buffer.concat(response).toString(), /^HTTP\/1.1 400/);
  const start = performance.now();
  const partialHeaders = f.socket();
  const partialBody = f.socket();
  await Promise.all([once(partialHeaders, 'connect'), once(partialBody, 'connect')]);
  const closed = [once(partialHeaders, 'close'), once(partialBody, 'close')];
  partialHeaders.write('GET /registry/v1/listings HTTP/1.1\r\nHost:');
  partialBody.write(`POST /registry/v1/challenges HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
  await Promise.all(closed);
  assert.ok(performance.now() - start < 5700);
});

test('the 65th live connection is dropped while the first 64 remain bounded', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 64; index++) {
    const accepted = once(f.server, 'connection');
    const socket = f.socket();
    await Promise.all([once(socket, 'connect'), accepted]);
  }
  const excess = f.socket();
  excess.on('error', () => {});
  await new Promise(resolveClose => excess.once('close', resolveClose));
  const count = await new Promise((resolveCount, reject) => f.server.getConnections((error, count) => error ? reject(error) : resolveCount(count)));
  assert.equal(count, 64);
});

test('duplicate/missing Host and duplicate Origin never reach an API operation', async t => {
  const f = await fixture(t);
  for (const headers of ['', `Host: 127.0.0.1:${f.port}\r\nHost: evil.test\r\n`,
    `Host: 127.0.0.1:${f.port}\r\nOrigin: http://127.0.0.1:${f.port}\r\nOrigin: https://evil.test\r\n`]) {
    const socket = f.socket();
    const bytes = [];
    socket.on('data', chunk => bytes.push(chunk));
    const closed = once(socket, 'close');
    socket.write(`GET /registry/v1/listings HTTP/1.1\r\n${headers}\r\n`);
    await closed;
    assert.ok(!Buffer.concat(bytes).toString().includes('200 OK'));
  }
});
