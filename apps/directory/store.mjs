import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readdirSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { epoch, exactFields, FRESH_MS, limited, MAX_LISTINGS, parseJson, RETAIN_MS,
  validateListing } from './protocol.mjs';

const MAX_DOCUMENT_BYTES = 128 * 1024;
const MAX_DATABASE_BYTES = 1024 * 1024;
const SCHEMA = 'CREATE TABLE registry (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), document TEXT NOT NULL) STRICT';
const APPLICATION_ID = 0x48414944;
// SQLite's OS lock is cross-process. This claim additionally rejects duplicate
// handles in this process without opening/closing another descriptor to the DB.
const openDirectories = new Set();

export class StorageError extends Error {
  constructor() { super('Directory storage is unavailable'); }
}

function directoryChain(path) {
  let cursor = parse(path).root;
  for (const part of path.slice(cursor.length).split('/').filter(Boolean)) {
    cursor = join(cursor, part);
    if (!lstatSync(cursor).isDirectory()) throw new StorageError();
  }
}

function checked(path, directory = false) {
  const stat = lstatSync(path);
  if ((directory ? !stat.isDirectory() : !stat.isFile())
      || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600)
      || (!directory && (stat.nlink !== 1 || stat.size > MAX_DATABASE_BYTES))) throw new StorageError();
  return stat;
}
const fileIdentity = stat => `${stat.dev}:${stat.ino}`;

function decodeDocument(bytes) {
  const document = parseJson(bytes, MAX_DOCUMENT_BYTES);
  exactFields(document, ['version', 'listings']);
  if (![1, 2].includes(document.version) || !Array.isArray(document.listings)
      || document.listings.length > MAX_LISTINGS) throw new StorageError();
  const rows = new Map();
  for (const value of document.listings) {
    exactFields(value, ['id', 'hostLabel', 'model', 'guestUrl', 'invitationRequired', 'updatedAt', 'expiresAt',
      ...(document.version === 2 && Object.hasOwn(value, 'requestsAccepted') ? ['requestsAccepted'] : [])]);
    if (typeof value.id !== 'string' || !/^[0-9a-f]{64}$/.test(value.id) || rows.has(value.id)) throw new StorageError();
    const listing = validateListing({ hostLabel: value.hostLabel, model: value.model,
      guestUrl: value.guestUrl, invitationRequired: value.invitationRequired,
      ...(Object.hasOwn(value, 'requestsAccepted') ? { requestsAccepted: value.requestsAccepted } : {}) });
    epoch(value.updatedAt);
    if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt !== value.updatedAt + FRESH_MS) throw new StorageError();
    rows.set(value.id, { id: value.id, ...listing, updatedAt: value.updatedAt, expiresAt: value.expiresAt });
  }
  return rows;
}

// A single bounded JSON document inside SQLite keeps the storage schema small.
// DELETE journaling + synchronous EXTRA commits atomically; EXCLUSIVE locking
// mode retains the OS file lock across commits for this handle's whole lifetime.
// There is no PID lockfile and no stale-lock repair. Existing unsafe paths fail.
export class DirectoryStore {
  #db;
  #directoryFd;
  #claim;
  #databaseIdentity;
  #rows = new Map();
  #failed = false;
  #closed = false;

  constructor(directory) {
    try {
      if (typeof directory !== 'string' || !directory || typeof process.getuid !== 'function') throw new StorageError();
      this.directory = resolve(directory);
      this.databasePath = join(this.directory, 'registry.sqlite');
      directoryChain(dirname(this.directory));
      try { mkdirSync(this.directory, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const directoryIdentity = fileIdentity(checked(this.directory, true));
      if (openDirectories.has(directoryIdentity)) throw new StorageError();
      openDirectories.add(directoryIdentity);
      this.#claim = directoryIdentity;
      this.#directoryFd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (fileIdentity(fstatSync(this.#directoryFd)) !== this.#claim) throw new StorageError();
      this.#inspect();
      let fresh = false;
      if (!existsSync(this.databasePath)) {
        if (readdirSync(this.directory).length) throw new StorageError();
        const fd = openSync(this.databasePath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
        try { fsyncSync(fd); } finally { closeSync(fd); }
        fresh = true;
      }
      const databaseStat = checked(this.databasePath);
      if (!fresh && databaseStat.size === 0) throw new StorageError();
      this.#databaseIdentity = fileIdentity(databaseStat);
      this.#db = new DatabaseSync(this.databasePath, { timeout: 0, allowExtension: false });
      this.#db.exec('PRAGMA trusted_schema=OFF; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA max_page_count=256; BEGIN EXCLUSIVE');
      if (fresh) {
        this.#db.exec(`${SCHEMA}; PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1`);
        this.#db.prepare('INSERT INTO registry VALUES (1, ?)').run('{"version":2,"listings":[]}');
      } else {
        const schema = this.#db.prepare('SELECT type, name, sql FROM sqlite_schema').all();
        if (schema.length !== 1 || schema[0].type !== 'table' || schema[0].name !== 'registry' || schema[0].sql !== SCHEMA
            || this.#db.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID
            || this.#db.prepare('PRAGMA user_version').get().user_version !== 1) throw new StorageError();
        const integrity = this.#db.prepare('PRAGMA quick_check').all();
        if (integrity.length !== 1 || integrity[0].quick_check !== 'ok') throw new StorageError();
      }
      const documents = this.#db.prepare('SELECT singleton, document FROM registry').all();
      if (documents.length !== 1 || documents[0].singleton !== 1 || typeof documents[0].document !== 'string') throw new StorageError();
      this.#rows = decodeDocument(Buffer.from(documents[0].document));
      this.#db.exec('COMMIT');
      fsyncSync(this.#directoryFd);
      const parentFd = openSync(dirname(this.directory), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
      this.assertAvailable();
    } catch {
      this.#failed = true;
      this.close();
      throw new StorageError();
    }
  }

  #inspect() {
    const names = readdirSync(this.directory);
    if (names.length > 2 || names.some(name => !['registry.sqlite', 'registry.sqlite-journal'].includes(name))) throw new StorageError();
    for (const name of names) checked(join(this.directory, name));
  }

  assertAvailable() {
    if (this.#closed || this.#failed) throw new StorageError();
    try {
      directoryChain(dirname(this.directory));
      if (fileIdentity(checked(this.directory, true)) !== this.#claim
          || fileIdentity(checked(this.databasePath)) !== this.#databaseIdentity) throw new StorageError();
      this.#inspect();
    } catch {
      this.#failed = true;
      throw new StorageError();
    }
  }

  #commit(rows) {
    this.assertAvailable();
    try {
      const bytes = Buffer.from(JSON.stringify({ version: 2, listings: [...rows.values()] }));
      // Validate both persisted and proposed documents through the same schema.
      const committed = decodeDocument(bytes);
      this.#db.exec('BEGIN EXCLUSIVE');
      this.#db.prepare('UPDATE registry SET document = ? WHERE singleton = 1').run(bytes.toString('utf8'));
      this.#db.exec('COMMIT');
      fsyncSync(this.#directoryFd);
      this.assertAvailable();
      this.#rows = committed;
    } catch {
      // Commit errors can have an uncertain durable outcome. Never keep serving
      // a cached snapshot or attempt an automatic recovery with this instance.
      this.#failed = true;
      throw new StorageError();
    }
  }

  #retained(now) {
    epoch(now);
    return new Map([...this.#rows].filter(([, row]) => now - row.updatedAt < RETAIN_MS));
  }

  list(now) {
    this.assertAvailable();
    const rows = this.#retained(now);
    if (rows.size !== this.#rows.size) this.#commit(rows);
    return [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).map(row => ({ ...row }));
  }

  publish(id, listing, now) {
    this.assertAvailable();
    const rows = this.#retained(now);
    if (!rows.has(id) && rows.size >= MAX_LISTINGS) {
      const expired = [...rows.values()].filter(row => row.expiresAt <= now)
        .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))[0];
      if (expired) rows.delete(expired.id);
      else throw limited(Math.max(1, Math.ceil(Math.min(...[...rows.values()].map(row => row.expiresAt - now)) / 1000)));
    }
    const row = { id, ...validateListing(listing), updatedAt: now, expiresAt: now + FRESH_MS };
    rows.set(id, row);
    this.#commit(rows);
    return { ...row };
  }

  withdraw(id, now) {
    this.assertAvailable();
    const rows = this.#retained(now);
    rows.delete(id);
    if (rows.size !== this.#rows.size) this.#commit(rows);
    return null;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#rows.clear();
    let failed = false;
    try { this.#db?.close(); } catch { failed = true; }
    if (this.#directoryFd !== undefined) {
      try { closeSync(this.#directoryFd); } catch { failed = true; }
    }
    if (this.#claim) openDirectories.delete(this.#claim);
    if (failed) throw new StorageError();
  }
}
