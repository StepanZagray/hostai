import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Admission, DirectoryProtocol, MAX_BODY_BYTES, parseJson, ProtocolError } from './protocol.mjs';
import { DirectoryStore } from './store.mjs';

const DEFAULT_STATIC_ROOT = fileURLToPath(new URL('../web/dist/directory/', import.meta.url));
const DEADLINE_MS = 5000;
const MAX_STATIC_BYTES = 2 * 1024 * 1024;
// Socket peers include a shared TLS proxy: allow a 256-request burst and
// 40 requests/second (2,400/minute), including readers. The aggregate ceiling
// is a 512-request burst and 100 requests/second (6,000/minute).
export const DEFAULT_REQUEST_ADMISSION = Object.freeze({ capacity: 512, refillMs: 10, maxKeys: 1 });
export const DEFAULT_IP_ADMISSION = Object.freeze({ capacity: 256, refillMs: 25, maxKeys: 256 });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function configuredOrigin(value, allowLoopbackDevelopment) {
  if (value === undefined) return null;
  let url;
  try { url = new URL(value); } catch { throw new TypeError('Invalid public origin'); }
  if (typeof value !== 'string' || ![url.origin, `${url.origin}/`].includes(value)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || (url.protocol !== 'https:' && !(allowLoopbackDevelopment && url.protocol === 'http:'
        && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new TypeError('Invalid public origin');
  return { host: url.host, origin: url.origin };
}

function send(res, status, value, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': bytes.length, 'Connection': 'close', ...headers });
  res.end(bytes);
}

async function body(req) {
  if (req.headersDistinct['content-type']?.length !== 1
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'])
      || req.headers['content-encoding'] !== undefined || req.headers.expect !== undefined) throw new ProtocolError(400, 'malformed_request');
  if (req.headers['content-length'] !== undefined
      && (!/^(0|[1-9][0-9]*)$/.test(req.headers['content-length'])
        || Number(req.headers['content-length']) > MAX_BODY_BYTES)) throw new ProtocolError(400, 'malformed_request');
  return await new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    const finish = (error, result) => {
      req.off('data', data);
      req.off('end', end);
      req.off('aborted', aborted);
      req.off('error', aborted);
      req.off('close', closed);
      if (error) { req.pause(); reject(error); }
      else resolveBody(result);
    };
    const aborted = () => finish(new ProtocolError(400, 'malformed_request'));
    const closed = () => { if (!req.complete) aborted(); };
    const data = chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) finish(new ProtocolError(400, 'malformed_request'));
      else chunks.push(chunk);
    };
    const end = () => {
      try { finish(null, parseJson(Buffer.concat(chunks, size))); }
      catch (error) { finish(error); }
    };
    req.on('data', data);
    req.on('end', end);
    req.on('aborted', aborted);
    req.on('error', aborted);
    req.on('close', closed);
  });
}

async function staticFile(root, route) {
  let filename;
  if (route === '/' || route === '/directory.html') filename = join(root, 'directory.html');
  else if (/^\/assets\/[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/.test(route)
      && route.length <= 168 && MIME[extname(route)] && extname(route) !== '.html') filename = join(root, route.slice(1));
  else throw new ProtocolError(404, 'not_found');
  let file;
  try {
    // Neither a symlinked build directory nor a symlinked asset may escape the
    // static root. NOFOLLOW also protects the final open and rejects symlinks.
    if (await realpath(root) !== root || await realpath(dirname(filename)) !== dirname(filename)) throw new Error();
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_STATIC_BYTES) throw new Error();
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size !== stat.size) throw new Error();
    return { bytes: bytes.subarray(0, size), contentType: MIME[extname(filename)] };
  } catch { throw new ProtocolError(404, 'not_found'); }
  finally { await file?.close(); }
}

// The caller owns the store and must close it after closing the server. Tests
// can inject a clock/random source, admission limits, and a private static root.
// The CLI below is the only listener entry point and always binds loopback.
export function createDirectoryServer({ store, publicOrigin, allowLoopbackDevelopment = false,
  staticRoot = DEFAULT_STATIC_ROOT, clock = Date.now, random, maxChallenges,
  globalAdmission, keyAdmission,
  requestAdmission = DEFAULT_REQUEST_ADMISSION,
  ipAdmission = DEFAULT_IP_ADMISSION,
} = {}) {
  const advertised = configuredOrigin(publicOrigin, allowLoopbackDevelopment);
  const root = resolve(staticRoot);
  // Neither Host nor forwarding headers may choose the signed audience.
  const expectedOrigin = () => {
    if (advertised) return advertised;
    const url = new URL(`http://127.0.0.1:${server.address().port}`);
    return { host: url.host, origin: url.origin };
  };
  const protocol = new DirectoryProtocol({ store, audience: () => expectedOrigin().origin,
    clock, random, maxChallenges, globalAdmission, keyAdmission });
  const requests = new Admission(requestAdmission);
  const peers = new Admission(ipAdmission);
  const sockets = new Set();
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: DEADLINE_MS,
    requestTimeout: DEADLINE_MS, connectionsCheckingInterval: 100,
    keepAliveTimeout: 1, keepAliveTimeoutBuffer: 0, rejectNonStandardBodyWrites: true }, (req, res) => {
    // Includes response transmission, unlike Node's requestTimeout. Every
    // connection handles one request, bounding slow readers and pipelining.
    const deadline = setTimeout(() => req.socket.destroy(), DEADLINE_MS);
    deadline.unref();
    res.once('close', () => clearTimeout(deadline));
    void (async () => {
      try {
        const expected = expectedOrigin();
        if (req.headersDistinct.host?.length !== 1 || req.headers.host !== expected.host
            || (req.headers.origin !== undefined && (req.headersDistinct.origin?.length !== 1
              || req.headers.origin !== expected.origin))) throw new ProtocolError(403, 'origin_rejected');
        const now = clock();
        requests.take('global', now);
        peers.take(req.socket.remoteAddress, now); // Forwarded / X-Forwarded-For are ignored.
        if (!req.url || req.url.length > 1024 || !req.url.startsWith('/')
            || /[%?#\\\x00-\x20\x7f]/.test(req.url) || req.url.startsWith('//')
            || req.url.split('/').some(part => part === '.' || part === '..')) throw new ProtocolError(400, 'malformed_request');
        if (req.method === 'GET') {
          if (req.headers['transfer-encoding'] !== undefined
              || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) throw new ProtocolError(400, 'malformed_request');
          if (req.url === '/registry/v1/listings') return send(res, 200, protocol.list());
          if (req.url === '/registry/v1/config') {
            protocol.assertAvailable();
            return send(res, 200, { version: 1, registration: 'open', invitationRequired: true });
          }
          const file = await staticFile(root, req.url);
          return send(res, 200, file.bytes, { 'Content-Type': file.contentType });
        }
        if (req.method === 'POST' && ['/registry/v1/challenges', '/registry/v1/listings'].includes(req.url)) {
          const parsed = await body(req);
          // IncomingMessage may auto-destroy after a fully read body while its
          // socket is still healthy. Only a closed transport cancels mutation.
          if (req.socket.destroyed || res.destroyed) return;
          return send(res, 200, req.url.endsWith('/challenges') ? protocol.challenge(parsed) : protocol.mutate(parsed));
        }
        throw new ProtocolError(404, 'not_found');
      } catch (error) {
        const failure = error instanceof ProtocolError ? error : new ProtocolError(503, 'service_unavailable');
        send(res, failure.status, { version: 1, error: failure.code },
          failure.status === 429 ? { 'Retry-After': String(failure.retryAfter) } : {});
      }
    })();
  });
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 1;
  server.setTimeout(DEADLINE_MS, socket => socket.destroy());
  server.on('connection', socket => {
    sockets.add(socket);
    // Absolute connection deadline covers partial headers and stalled uploads.
    const deadline = setTimeout(() => socket.destroy(), DEADLINE_MS);
    deadline.unref();
    socket.once('close', () => { clearTimeout(deadline); sockets.delete(socket); });
  });
  server.on('checkContinue', (req, res) => send(res, 400, { version: 1, error: 'malformed_request' }));
  server.on('checkExpectation', (req, res) => send(res, 400, { version: 1, error: 'malformed_request' }));
  server.on('clientError', (_error, socket) => socket.destroy());
  // closeAllConnections also covers sockets still waiting for their headers.
  const closeAll = server.closeAllConnections.bind(server);
  server.closeAllConnections = () => { closeAll(); for (const socket of sockets) socket.destroy(); };
  return server;
}

function main() {
  let store;
  try {
    const value = process.env.HOSTAI_DIRECTORY_PORT ?? '8090';
    if (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65535) throw new TypeError();
    const port = Number(value);
    const publicOrigin = process.env.HOSTAI_DIRECTORY_PUBLIC_ORIGIN;
    const allowLoopbackDevelopment = process.env.HOSTAI_DIRECTORY_ALLOW_LOOPBACK_HTTP === '1';
    configuredOrigin(publicOrigin, allowLoopbackDevelopment);
    store = new DirectoryStore(process.env.HOSTAI_DIRECTORY_DATA_DIR ?? join(homedir(), '.local/share/hostai-directory'));
    const server = createDirectoryServer({ store, publicOrigin, allowLoopbackDevelopment });
    let stopping = false;
    const stop = failed => {
      if (stopping) return;
      stopping = true;
      if (failed) { process.stderr.write('Directory server unavailable.\n'); process.exitCode = 1; }
      server.close(() => {
        try { store.close(); } catch { process.exitCode = 1; }
      });
      server.closeAllConnections();
    };
    server.on('error', () => stop(true));
    process.once('SIGINT', () => stop(false));
    process.once('SIGTERM', () => stop(false));
    server.listen(port, '127.0.0.1', () => process.stdout.write(`Directory listening on 127.0.0.1:${port}\n`));
  } catch {
    try { store?.close(); } catch { /* No input or filesystem details in logs. */ }
    process.stderr.write('Directory server unavailable.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
