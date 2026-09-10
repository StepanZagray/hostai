import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync,
  rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DirectoryStore, StorageError } from './store.mjs';
import { FRESH_MS, RETAIN_MS } from './protocol.mjs';

const storeUrl = new URL('./store.mjs', import.meta.url).href;
const listing = { hostLabel: 'Disk fixture', model: 'llama3.2:3b',
  guestUrl: 'https://disk-fixture.trycloudflare.com/', invitationRequired: true };
const id = 'a'.repeat(64);
const now = 1_800_000_000_000;
function fixture(t) {
  const root = mkdtempSync('/tmp/hostai-directory-store-');
  const cleanups = [];
  t.after(async () => {
    try { for (const cleanup of cleanups.reverse()) await cleanup(); }
    finally { rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false); }
  });
  return { root, directory: join(root, 'data'), onCleanup(cleanup) { cleanups.push(cleanup); } };
}
function editDocument(directory, edit) {
  const db = new DatabaseSync(join(directory, 'registry.sqlite'));
  try {
    const old = db.prepare('SELECT document FROM registry').get().document;
    db.prepare('UPDATE registry SET document = ?').run(edit(old));
  } finally { db.close(); }
}
function readDocument(directory) {
  const db = new DatabaseSync(join(directory, 'registry.sqlite'), { readOnly: true });
  try { return JSON.parse(db.prepare('SELECT document FROM registry').get().document); }
  finally { db.close(); }
}
function childAttempt(directory) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { DirectoryStore } from ${JSON.stringify(storeUrl)};
     try { const store = new DirectoryStore(process.argv[1]); store.close(); process.stdout.write('OPEN'); }
     catch { process.stdout.write('LOCKED'); }`, directory],
  { encoding: 'utf8', timeout: 3000, env: {} });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.throws(() => process.kill(result.pid, 0), { code: 'ESRCH' });
  return result.stdout;
}

test('private durable store, same-process rejection and OS exclusive lock survive multiple commits', t => {
  const { directory, onCleanup } = fixture(t);
  let store = new DirectoryStore(directory);
  onCleanup(() => store.close());
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(join(directory, 'registry.sqlite')).mode & 0o777, 0o600);
  assert.equal(childAttempt(directory), 'LOCKED');
  assert.throws(() => new DirectoryStore(directory), StorageError);
  assert.equal(childAttempt(directory), 'LOCKED');
  const first = store.publish(id, listing, now);
  assert.equal(childAttempt(directory), 'LOCKED');
  store.publish(id, { ...listing, hostLabel: 'Updated' }, now + 1000);
  assert.equal(childAttempt(directory), 'LOCKED');
  store.close();
  assert.equal(childAttempt(directory), 'OPEN');
  store = new DirectoryStore(directory);
  assert.equal(store.list(now + 2000)[0].updatedAt, first.updatedAt + 1000);
  assert.equal(store.list(now + 2000)[0].expiresAt, first.expiresAt + 1000);
});

test('fresh storage and publication write document v2', t => {
  const { directory, onCleanup } = fixture(t);
  let store = new DirectoryStore(directory);
  onCleanup(() => store.close());
  store.close();
  assert.deepEqual(readDocument(directory), { version: 2, listings: [] });
  store = new DirectoryStore(directory);
  const row = store.publish(id, { ...listing, requestsAccepted: false }, now);
  store.close();
  assert.deepEqual(readDocument(directory), { version: 2, listings: [row] });
});

test('legacy v1 documents migrate on commit and preserve mixed legacy/v2 rows across reopen', t => {
  const { directory, onCleanup } = fixture(t);
  let store = new DirectoryStore(directory);
  onCleanup(() => store.close());
  const legacy = store.publish(id, listing, now);
  store.close();
  editDocument(directory, () => JSON.stringify({ version: 1, listings: [legacy] }));
  store = new DirectoryStore(directory);
  assert.deepEqual(store.list(now), [legacy]);
  const enabled = store.publish('b'.repeat(64), { ...listing, requestsAccepted: true }, now + 1);
  const disabled = store.publish('c'.repeat(64), { ...listing, requestsAccepted: false }, now + 2);
  store.close();
  assert.deepEqual(readDocument(directory), { version: 2, listings: [legacy, enabled, disabled] });
  store = new DirectoryStore(directory);
  assert.deepEqual(store.list(now + 2), [disabled, enabled, legacy]);
  const renewed = store.publish(id, listing, now + 3);
  store.close();
  store = new DirectoryStore(directory);
  assert.deepEqual(store.list(now + 3), [renewed, disabled, enabled]);
});

test('malformed capability writes fail without changing the saved listing', t => {
  const { directory, onCleanup } = fixture(t);
  let store = new DirectoryStore(directory);
  onCleanup(() => store.close());
  const initial = store.publish(id, { ...listing, requestsAccepted: true }, now);
  for (const requestsAccepted of [null, 'true', 'false', 0, 1, {}, []]) {
    assert.throws(() => store.publish(id, { ...listing, requestsAccepted }, now + 1),
      error => error.status === 400 && error.code === 'malformed_request');
    assert.deepEqual(store.list(now + 1), [initial]);
  }
  store.close();
  store = new DirectoryStore(directory);
  assert.deepEqual(store.list(now + 1), [initial]);
});

test('abrupt process death releases OS lock without repair and preserves committed timestamps', async t => {
  const { directory, onCleanup } = fixture(t);
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { DirectoryStore } from ${JSON.stringify(storeUrl)};
     const store = new DirectoryStore(process.argv[1]);
     store.publish(${JSON.stringify(id)}, ${JSON.stringify(listing)}, ${now});
     process.stdout.write('READY'); process.stdin.resume();`, directory],
  { stdio: ['pipe', 'pipe', 'pipe'], env: {} });
  const exited = once(child, 'exit');
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
  onCleanup(async () => {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  });
  const ready = await Promise.race([once(child.stdout, 'data'), exited.then(() => { throw new Error('Lock child failed'); })]);
  assert.equal(ready[0].toString(), 'READY');
  assert.equal(childAttempt(directory), 'LOCKED');
  child.kill('SIGKILL');
  await exited;
  const store = new DirectoryStore(directory);
  try {
    assert.deepEqual(store.list(now + FRESH_MS + 1), [{ id, ...listing, updatedAt: now, expiresAt: now + FRESH_MS }]);
  } finally { store.close(); }
});

test('startup fails closed on corrupt documents, duplicate ids, timestamps and schema', async t => {
  const mutations = [
    () => '{',
    () => '{"version":1,"version":1,"listings":[]}',
    old => JSON.stringify({ ...JSON.parse(old), extra: true }),
    old => JSON.stringify({ ...JSON.parse(old), version: 3 }),
    ...[null, 'true', 'false', 0, 1, {}, []].map(requestsAccepted => old => {
      const doc = JSON.parse(old);
      doc.listings[0].requestsAccepted = requestsAccepted;
      return JSON.stringify(doc);
    }),
    old => {
      const doc = JSON.parse(old);
      doc.version = 1;
      doc.listings[0].requestsAccepted = true;
      return JSON.stringify(doc);
    },
    old => { const doc = JSON.parse(old); doc.listings.push(doc.listings[0]); return JSON.stringify(doc); },
    old => { const doc = JSON.parse(old); doc.listings[0].expiresAt++; return JSON.stringify(doc); },
    old => { const doc = JSON.parse(old); doc.listings[0].updatedAt = -1; return JSON.stringify(doc); },
    old => { const doc = JSON.parse(old); doc.listings[0].id = 'B'.repeat(64); return JSON.stringify(doc); },
    old => { const doc = JSON.parse(old); doc.listings[0].guestUrl += '?credential=no'; return JSON.stringify(doc); },
    old => { const doc = JSON.parse(old); doc.listings[0].invitationRequired = false; return JSON.stringify(doc); },
    old => { const doc = JSON.parse(old); doc.listings = Array.from({ length: 101 }, (_, i) => ({ ...doc.listings[0], id: i.toString(16).padStart(64, '0') })); return JSON.stringify(doc); },
    () => ' '.repeat(128 * 1024 + 1),
  ];
  for (const [index, mutation] of mutations.entries()) await t.test(`invalid document ${index + 1}`, t => {
    const { directory } = fixture(t);
    const store = new DirectoryStore(directory);
    store.publish(id, listing, now);
    store.close();
    editDocument(directory, mutation);
    assert.throws(() => new DirectoryStore(directory), StorageError);
    assert.throws(() => new DirectoryStore(directory), StorageError);
  });
  for (const sql of ['CREATE TABLE unexpected (x TEXT)', 'PRAGMA user_version=2', 'PRAGMA application_id=0', 'DELETE FROM registry']) {
    await t.test(sql, t => {
      const { directory } = fixture(t);
      new DirectoryStore(directory).close();
      const db = new DatabaseSync(join(directory, 'registry.sqlite'));
      try { db.exec(sql); } finally { db.close(); }
      assert.throws(() => new DirectoryStore(directory), StorageError);
    });
  }
});

test('unsafe permissions, symlinks, hardlinks, foreign files and missing/corrupt DBs fail without repair', async t => {
  for (const change of [
    (root, directory) => chmodSync(directory, 0o755),
    (root, directory) => chmodSync(join(directory, 'registry.sqlite'), 0o644),
    (root, directory) => writeFileSync(join(directory, 'foreign'), 'no', { mode: 0o600 }),
    (root, directory) => { const db = join(directory, 'registry.sqlite'); renameSync(db, join(root, 'original')); symlinkSync(join(root, 'original'), db); },
    (root, directory) => linkSync(join(directory, 'registry.sqlite'), join(root, 'hardlink')),
    (root, directory) => { renameSync(directory, join(root, 'original')); symlinkSync(join(root, 'original'), directory); },
    (root, directory) => writeFileSync(join(directory, 'registry.sqlite'), Buffer.from('not a database')),
    (root, directory) => writeFileSync(join(directory, 'registry.sqlite'), Buffer.alloc(0)),
    (root, directory) => { rmSync(join(directory, 'registry.sqlite')); writeFileSync(join(directory, 'registry.sqlite-journal'), '', { mode: 0o600 }); },
  ]) await t.test(`unsafe fixture ${change.toString().slice(0, 65)}`, t => {
    const { root, directory } = fixture(t);
    new DirectoryStore(directory).close();
    change(root, directory);
    assert.throws(() => new DirectoryStore(directory), StorageError);
  });
  await t.test('symlink in parent chain', t => {
    const { root, directory } = fixture(t);
    mkdirSync(join(root, 'real'), { mode: 0o700 });
    symlinkSync(join(root, 'real'), directory);
    assert.throws(() => new DirectoryStore(join(directory, 'child')), StorageError);
    assert.equal(existsSync(join(root, 'real', 'child')), false);
  });
});

test('unsafe path changes poison a running store even if permissions are restored', t => {
  const { directory, onCleanup } = fixture(t);
  const store = new DirectoryStore(directory);
  onCleanup(() => store.close());
  store.publish(id, listing, now);
  const path = join(directory, 'registry.sqlite');
  chmodSync(path, 0o644);
  assert.throws(() => store.list(now), StorageError);
  chmodSync(path, 0o600);
  assert.throws(() => store.list(now), StorageError);
  assert.throws(() => store.publish(id, listing, now), StorageError);
});

test('commit failure disables all cached reads and writes; rollback on close preserves prior state', t => {
  const { directory, onCleanup } = fixture(t);
  let store = new DirectoryStore(directory);
  onCleanup(() => store.close());
  const initial = store.publish(id, listing, now);
  const exec = DatabaseSync.prototype.exec;
  const failure = t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    if (sql === 'COMMIT') throw new Error('injected commit I/O failure');
    return exec.call(this, sql);
  });
  assert.throws(() => store.publish(id, { ...listing, hostLabel: 'Uncommitted' }, now + 1), StorageError);
  failure.mock.restore();
  assert.throws(() => store.list(now), StorageError);
  assert.throws(() => store.withdraw(id, now), StorageError);
  store.close();
  store = new DirectoryStore(directory);
  assert.deepEqual(store.list(now), [initial]);
});

test('read eviction persists removal; returned rows cannot mutate committed state', t => {
  const { directory, onCleanup } = fixture(t);
  let store = new DirectoryStore(directory);
  onCleanup(() => store.close());
  store.publish(id, listing, now);
  store.list(now)[0].guestUrl = 'https://evil.test/';
  assert.equal(store.list(now)[0].guestUrl, listing.guestUrl);
  assert.deepEqual(store.list(now + RETAIN_MS), []);
  store.close();
  store = new DirectoryStore(directory);
  assert.deepEqual(store.list(now), []);
  assert.ok(readFileSync(join(directory, 'registry.sqlite')).length < 1024 * 1024);
});
