// Real sockets against the built Node/Start adapter; no browser or Ollama needed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
let child;
let address;
let upstreamRequests = 0;
let receivedBody;
let output = "";
const stub = createServer(async (req, res) => {
  upstreamRequests++;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  receivedBody = Buffer.concat(chunks);
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  res.end('{"content":"Fixture only","done":true}\n');
});

before(async () => {
  stub.listen(0, "127.0.0.1");
  await once(stub, "listening");
  child = spawn(process.execPath, ["apps/web/server.mjs"], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOSTAI_UI_PORT: "0",
      HOSTAI_BACKEND_URL: `http://127.0.0.1:${stub.address().port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  address = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 10_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited (${code}): ${output}`));
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/HostAI workspace: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
});

after(async () => {
  let forced = false;
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      forced = true;
      child.kill("SIGKILL");
    }, 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
  await new Promise((resolve) => {
    stub.close(resolve);
    stub.closeAllConnections();
  });
  assert.equal(forced, false, "Server retained resources after graceful shutdown");
  if (child?.exitCode) assert.fail(`Production server crashed: ${output}`);
});

function post(body) {
  return fetch(`${address}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
}

function unfinishedUpload(body) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${address}/api/chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000),
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(body);
    // Keep the upload open: the rejection must not wait for the sender to finish.
  });
}

async function assertHealthy() {
  assert.equal(child.exitCode, null, output);
  const response = await post("{}");
  assert.equal(response.status, 200);
  assert.notEqual(response.headers.get("connection"), "close");
  assert.match(await response.text(), /Fixture only/);
}

test("large valid Unicode/escaped JSON reaches the backend unchanged", async () => {
  const body = JSON.stringify({
    model: "test-model:small",
    messages: Array.from({ length: 4 }, () => ({
      role: "user",
      content: "界".repeat(1250) + "\t".repeat(13750),
    })),
    temperature: 0.7,
    maxTokens: 128,
  });
  assert.ok(body.length > 100_000);
  assert.ok(Buffer.byteLength(body) < 256 * 1024);
  const response = await post(body);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Fixture only/);
  assert.deepEqual(receivedBody, Buffer.from(body));
});

test("declared oversized uploads receive 413 without resetting or crashing the server", async () => {
  const before = upstreamRequests;
  const response = await post(JSON.stringify({ content: "界".repeat(90_000) }));
  assert.equal(response.status, 413);
  assert.equal(response.headers.get("connection"), "close");
  assert.deepEqual(await response.json(), { detail: "Request is too large." });
  assert.equal(upstreamRequests, before);
  await assertHealthy();
});

test("unfinished chunked uploads receive 413 immediately once the byte limit is crossed", async () => {
  const before = upstreamRequests;
  const response = await unfinishedUpload("x".repeat(270_000));
  assert.equal(response.status, 413);
  assert.equal(response.headers.connection, "close");
  assert.deepEqual(JSON.parse(response.body), { detail: "Request is too large." });
  assert.equal(upstreamRequests, before);
  await assertHealthy();
});

test(
  "a client that keeps writing still receives the full rejection",
  { timeout: 15_000 },
  async () => {
    const before = upstreamRequests;
    for (let iteration = 0; iteration < 10; iteration++) {
      await new Promise((resolve, reject) => {
        let timer;
        const req = httpRequest(
          `${address}/api/chat`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(10_000),
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => {
              body += chunk;
            });
            res.on("error", reject);
            res.on("end", () => {
              clearInterval(timer);
              req.destroy();
              try {
                assert.equal(res.statusCode, 413);
                assert.deepEqual(JSON.parse(body), { detail: "Request is too large." });
                resolve();
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        req.on("error", (error) => {
          clearInterval(timer);
          reject(error);
        });
        timer = setInterval(() => req.write("x".repeat(65_536)), 1);
      });
    }
    assert.equal(upstreamRequests, before);
    await assertHealthy();
  },
);

test(
  "stalled uploads receive 504 before the server closes the connection",
  { timeout: 20_000 },
  async () => {
    const before = upstreamRequests;
    const response = await unfinishedUpload('{"model":');
    assert.equal(response.status, 504);
    assert.match(JSON.parse(response.body).detail, /timed out/);
    assert.equal(upstreamRequests, before);
    await assertHealthy();
  },
);
