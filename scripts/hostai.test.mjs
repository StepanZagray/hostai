import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable, PassThrough } from "node:stream";
import { main } from "./hostai.mjs";

async function fixture(t, handler) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    calls.push({ path: req.url, method: req.method, body: body ? JSON.parse(body) : undefined });
    handler(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const closed = once(server, "close");
    server.close(); server.closeAllConnections();
    await closed;
  });
  return { calls, url: `http://127.0.0.1:${server.address().port}` };
}

function io(url, input = "") {
  let out = "", err = "";
  return {
    stdin: Readable.from([input]), stdout: { write: (text) => { out += text; } },
    stderr: { write: (text) => { err += text; } }, env: { HOSTAI_URL: url },
    output: () => out, errors: () => err,
  };
}

test("models lists both UI modes and API-only models without invoking generation", async (t) => {
  const { calls, url } = await fixture(t, (_, res) => res.end(JSON.stringify({ connected: true, models: [
    { name: "chat", ui: null, capabilities: { chat: true, infer: false } },
    { name: "custom", ui: { runtime: "custom", entry: "ui/index.html" }, capabilities: { chat: false, infer: true } },
    { name: "api-only", ui: null, capabilities: { chat: false, infer: true } },
  ] })));
  const streams = io(url);
  await main(["models"], streams);
  assert.match(streams.output(), /chat\tyes\tno\tchat/);
  assert.match(streams.output(), /custom\tno\tyes\tcustom/);
  assert.match(streams.output(), /api-only\tno\tyes\tnone/);
  assert.deepEqual(calls.map((call) => call.path), ["/api/models"]);
});

test("chat maps settings and piped prompts, streams split UTF-8, and preserves raw JSON", async (t) => {
  const { calls, url } = await fixture(t, (_, res) => {
    res.setHeader("Content-Type", "application/x-ndjson");
    const bytes = Buffer.from('{"content":"Héllo","done":false}\n{"content":"!","done":true}\n');
    const split = bytes.indexOf(Buffer.from("é")) + 1;
    res.write(bytes.subarray(0, split));
    res.end(bytes.subarray(split));
  });
  const streams = io(url, "Piped prompt");
  await main(["chat", "runtime", "--temperature", "0.2", "--max-tokens", "123"], streams);
  assert.equal(streams.output(), "Héllo!\n");
  assert.deepEqual(calls[0], { path: "/api/chat", method: "POST", body: { model: "runtime", messages: [{ role: "user", content: "Piped prompt" }], temperature: 0.2, maxTokens: 123 } });
  const raw = io(url);
  await main(["chat", "runtime", "Hello", "--json"], raw);
  assert.deepEqual(raw.output().trim().split("\n").map(JSON.parse), [{ content: "Héllo", done: false }, { content: "!", done: true }]);
});

test("custom models can infer through HostAI with JSON input and no UI", async (t) => {
  const { calls, url } = await fixture(t, (_, res) => res.end('{"event":{"position":[1,2]},"done":false}\n{"done":true}\n'));
  const streams = io(url, '{"action":"up","board":[[0,1]]}');
  await main(["infer", "custom", "--input", "-"], streams);
  assert.deepEqual(calls[0].body, { model: "custom", input: { action: "up", board: [[0,1]] } });
  assert.deepEqual(streams.output().trim().split("\n").map(JSON.parse), [{ event: { position: [1,2] }, done: false }, { done: true }]);
  const nullInput = io(url);
  await main(["infer", "custom", "null"], nullInput);
  assert.deepEqual(calls[1].body, { model: "custom", input: null });
});

test("describe exposes custom instructions, schemas and examples without loading UI or inferring", async (t) => {
  const interaction = { instructions: "Send op:info first. Requests are stateless.", inputSchema: { type: "object", description: "Operation." }, outputSchema: { type: "object", description: "Result." }, examples: [{ description: "Inspect", input: { op: "info" }, output: { ok: true } }] };
  const { calls, url } = await fixture(t, (_, res) => res.end(JSON.stringify({ connected: true, models: [
    { name: "custom", capabilities: { chat: false, infer: true }, interaction },
    { name: "chat", capabilities: { chat: true, infer: false } },
    { name: "undocumented", capabilities: { chat: false, infer: true } },
  ] })));
  const custom = io(url);
  await main(["describe", "custom", "--json"], custom);
  assert.deepEqual(JSON.parse(custom.output()).infer.inputSchema, interaction.inputSchema);
  assert.deepEqual(JSON.parse(custom.output()).infer.examples, interaction.examples);
  assert.equal(JSON.parse(custom.output()).infer.endpoint, "/api/infer");
  const chat = io(url);
  await main(["describe", "chat"], chat);
  assert.match(chat.output(), /conversation history/);
  await assert.rejects(main(["describe", "missing"], io(url)), /Model not found/);
  await assert.rejects(main(["describe", "undocumented"], io(url)), /headless interaction contract/);
  assert.ok(calls.every((call) => call.path === "/api/models"));
});

test("local guest CLI uses bearer authorization and exposes only the granted model", async (t) => {
  const { calls, url } = await fixture(t, (req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture-secret");
    if (req.url === "/guest/v1/session") res.end(JSON.stringify({ model: "granted", available: true, capabilities: { chat: true, infer: false } }));
    else if (req.url === "/guest/v1/chat") res.end('{"content":"guest answer","done":true}\n');
    else { res.writeHead(401); res.end('{"detail":"fixture-secret"}'); }
  });
  const streams = () => ({ ...io(url), env: { HOSTAI_URL: url, HOSTAI_ACCESS_TOKEN: "fixture-secret" } });
  const described = streams();
  await main(["describe", "granted", "--guest", "--json"], described);
  assert.equal(JSON.parse(described.output()).chat.endpoint, "/guest/v1/chat");
  await assert.rejects(main(["describe", "private", "--guest"], streams()), /Model not found/);
  await main(["chat", "granted", "hello", "--guest"], streams());
  await assert.rejects(main(["infer", "granted", "{}", "--guest"], streams()), (error) => /HTTP 401/.test(error.message) && !error.message.includes("fixture-secret"));
  await assert.rejects(main(["models", "--guest"], io(url)), /HOSTAI_ACCESS_TOKEN/);
  assert.deepEqual(calls.map((call) => call.path), ["/guest/v1/session", "/guest/v1/session", "/guest/v1/chat", "/guest/v1/infer"]);
});

test("scripted conversations accept a message array from stdin", async (t) => {
  const { calls, url } = await fixture(t, (_, res) => res.end('{"content":"ok","done":true}\n'));
  const messages = [{ role: "system", content: "Be brief" }, { role: "user", content: "Hello" }, { role: "assistant", content: "Hi" }, { role: "user", content: "Again" }];
  await main(["chat", "runtime", "--messages", "-"], io(url, JSON.stringify(messages)));
  assert.deepEqual(calls[0].body.messages, messages);
});

test("interactive chat keeps conversation context and /clear resets it", { timeout: 5000 }, async (t) => {
  const { calls, url } = await fixture(t, (_, res) => res.end('{"content":"answer","done":true}\n'));
  const streams = io(url);
  const input = new PassThrough(); input.isTTY = true;
  const prompts = ["Hello", "Again", "/clear", "Fresh", "/exit"];
  const terminalOutput = new PassThrough();
  let emitted = "";
  terminalOutput.on("data", (data) => {
    emitted += data.toString();
    if (emitted.endsWith("> ")) { emitted = ""; setImmediate(() => input.write(`${prompts.shift()}\n`)); }
  });
  try { await main(["chat", "runtime"], { ...streams, stdin: input, stderr: terminalOutput }); }
  finally { input.destroy(); terminalOutput.destroy(); }
  assert.equal(calls.length, 3);
  assert.equal(calls[1].body.messages.length, 3);
  assert.deepEqual(calls[2].body.messages, [{ role: "user", content: "Fresh" }]);
});

test("invalid inputs and non-loopback origins fail before network work", async () => {
  for (const args of [["infer", "custom", "bad json"], ["chat", "runtime", "hi", "--max-tokens", "0"],
    ["chat", "runtime", "hi", "--temperature", "NaN"], ["chat", "runtime", "hi", "--messages", "-"],
    ["models", "--url", "https://example.com"], ["models", "--url", "http://127.0.0.1:8080/api"], ["infer", "custom", "{}", "--input", "-"],
    ["models", "--unknown"], ["chat"]]) await assert.rejects(main(args, io("http://127.0.0.1:1")));
});

test("HTTP errors and incomplete or terminal-error streams fail clearly", async (t) => {
  let body = '{"detail":"This model does not support chat."}', status = 400;
  const { url } = await fixture(t, (_, res) => { res.writeHead(status, { "Retry-After": "3" }); res.end(body); });
  await assert.rejects(main(["chat", "model", "hi"], io(url)), /HTTP 400.*does not support chat.*Retry after 3/);
  status = 200; body = '{"content":"partial","done":false}\n';
  await assert.rejects(main(["chat", "model", "hi"], io(url)), /before completion/);
  body = '{"content":"","done":true,"error":"Provider failed"}\n';
  await assert.rejects(main(["chat", "model", "hi"], io(url)), /Provider failed/);
});

test("CLI SIGINT aborts the gateway stream and exits nonzero", { timeout: 7000 }, async (t) => {
  let closedResolve;
  const closed = new Promise((resolve) => { closedResolve = resolve; });
  const { url } = await fixture(t, (_, res) => {
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    res.write('{"content":"started","done":false}\n');
    res.on("close", closedResolve);
  });
  const child = spawn(process.execPath, ["scripts/hostai.mjs", "chat", "runtime", "hi", "--url", url], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const exited = once(child, "exit");
  let err = "";
  child.stderr.on("data", (data) => { err += data.toString(); });
  await once(child.stdout, "data");
  child.kill("SIGINT");
  const [code] = await exited;
  await closed;
  assert.equal(code, 130);
  assert.match(err, /Cancelled/);
});
