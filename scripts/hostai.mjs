#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

const MAX_BYTES = 262_144;
const HELP = `HostAI — use hosted models without a browser

Usage:
  hostai models [--json]
  hostai describe MODEL [--json]
  hostai chat MODEL [PROMPT] [--messages FILE] [--json]
  hostai infer MODEL [JSON] [--input FILE]

Options:
  --url URL           Local HostAI gateway (default: HOSTAI_URL or http://127.0.0.1:8080)
  --guest             Use local guest routes; requires HOSTAI_ACCESS_TOKEN and --url
  --temperature N     Chat sampling temperature, 0–2 (default: 0.7)
  --max-tokens N      Chat output limit, 1–8192 (default: 512)
  --messages FILE     JSON array of chat messages; use - for stdin
  --input FILE        Opaque inference JSON; use - for stdin
  --json              Print raw NDJSON chat records or the JSON model catalog
  --help              Show this help

With no prompt, chat reads piped stdin or starts an interactive conversation.
Interactive commands: /clear, /exit. Ctrl+C cancels the request and exits.
Inference always prints NDJSON. Input/output meaning belongs to the provider.
This CLI connects to a running HostAI gateway; it does not start a model engine.
`;

function options(argv) {
  const positional = [];
  const flags = {};
  const valued = new Set(["url", "temperature", "max-tokens", "messages", "input"]);
  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (literal || !arg.startsWith("--")) { positional.push(arg); continue; }
    if (arg === "--") { literal = true; continue; }
    const name = arg.slice(2);
    if (Object.hasOwn(flags, name)) throw new Error(`Duplicate option: ${arg}`);
    if (name === "help" || name === "json" || name === "guest") flags[name] = true;
    else if (valued.has(name)) {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) throw new Error(`${arg} needs a value.`);
      flags[name] = argv[++i];
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return { positional, flags };
}

function gatewayUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.port === "0" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("--url must be a loopback HTTP HostAI gateway origin, such as http://127.0.0.1:8080.");
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url;
}

async function inputText(stream) {
  const parts = [];
  let size = 0;
  for await (const part of stream) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += bytes.length;
    if (size > MAX_BYTES) throw new Error("Input exceeds 262144 bytes.");
    parts.push(bytes);
  }
  return Buffer.concat(parts).toString("utf8");
}

async function fileInput(path, stdin) {
  if (path === "-") return inputText(stdin);
  const { createReadStream } = await import("node:fs");
  return inputText(createReadStream(path));
}

function jsonInput(text) {
  try { return JSON.parse(text); } catch { throw new Error("Input must be valid JSON."); }
}

// Model text must not send terminal control sequences. Raw JSON remains lossless.
const printable = (text) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

async function request(origin, path, body, signal, token) {
  const response = await fetch(new URL(path, origin), {
    method: body === undefined ? "GET" : "POST",
    headers: { Accept: body === undefined ? "application/json" : "application/x-ndjson", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(610_000)]) : AbortSignal.timeout(610_000), redirect: "error",
  });
  if (!response.ok) {
    let detail = "";
    try {
      const problem = jsonInput(await inputText(response.body));
      if (!token && typeof problem.detail === "string") detail = printable(problem.detail).slice(0, 512);
    } catch { /* A malformed error response cannot replace the HTTP status. */ }
    const retry = response.headers.get("retry-after");
    throw new Error(`HostAI returned HTTP ${response.status}${detail ? `: ${detail}` : "."}${retry && /^\d+$/.test(retry) ? ` Retry after ${retry} seconds.` : ""}`);
  }
  return response;
}

async function records(response, onRecord, chat) {
  if (!response.body) throw new Error("HostAI returned an empty stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let complete = false;
  const consume = (line) => {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > MAX_BYTES) throw new Error("HostAI returned an oversized record.");
    const record = jsonInput(line);
    if (!record || typeof record !== "object" || typeof record.done !== "boolean"
        || (chat && typeof record.content !== "string")
        || ("error" in record && (typeof record.error !== "string" || !record.done)))
      throw new Error("HostAI returned an invalid stream record.");
    onRecord(record);
    if (record.error) throw new Error(printable(record.error));
    complete = record.done;
  };
  try {
    while (!complete) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline;
      while (!complete && (newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        consume(line);
      }
      if (complete) break;
      if (Buffer.byteLength(buffer) > MAX_BYTES) throw new Error("HostAI returned an oversized record.");
      if (done) { consume(buffer); break; }
    }
    if (!complete) throw new Error("HostAI closed the stream before completion.");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function main(argv, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, env = process.env, signal } = {}) {
  const { positional, flags } = options(argv);
  if (flags.help || positional.length === 0) { stdout.write(HELP); return; }
  const [command, model, payload, ...extra] = positional;
  if (!["models", "describe", "chat", "infer"].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (extra.length || (command === "models" && model) || (command === "describe" && payload)) throw new Error("Too many arguments. Quote prompts and JSON as one argument.");
  if (command !== "models" && !model) throw new Error(`${command} requires a model name. Use hostai models to list them.`);
  if (flags.input !== undefined && command !== "infer") throw new Error("--input is only supported by infer.");
  if (["messages", "temperature", "max-tokens"].some((flag) => flags[flag] !== undefined) && command !== "chat")
    throw new Error("Chat options require the chat command.");
  const origin = gatewayUrl(flags.url ?? env.HOSTAI_URL ?? "http://127.0.0.1:8080");
  const token = flags.guest ? env.HOSTAI_ACCESS_TOKEN : undefined;
  if (flags.guest && (!token || token.length > 256 || /[\s\u0000-\u001f\u007f]/.test(token))) throw new Error("--guest requires a valid HOSTAI_ACCESS_TOKEN environment variable.");
  if (flags.guest && !flags.url && !env.HOSTAI_URL) throw new Error("--guest requires --url or HOSTAI_URL pointing to the local guest origin.");
  const route = (name) => `${flags.guest ? "/guest/v1" : "/api"}/${name}`;
  const requestSignal = signal ?? new AbortController().signal;
  if (command === "models" || command === "describe") {
    const value = jsonInput(await inputText((await request(origin, route(flags.guest ? "session" : "models"), undefined, requestSignal, token)).body));
    const catalog = flags.guest ? { connected: value.available, models: [{ ...value, name: value.model }] } : value;
    if (!Array.isArray(catalog?.models)) throw new Error("HostAI returned an invalid model catalog.");
    if (command === "describe") {
      const item = catalog.models.find((item) => item.name === model);
      if (!item) throw new Error("Model not found. Use hostai models to list accessible models.");
      const capabilities = item.capabilities ?? { chat: !item.ui, infer: !!item.ui };
      if (capabilities.infer && !item.interaction) throw new Error("Provider has not supplied a headless interaction contract.");
      const description = {
        model, capabilities, ui: item.ui ?? null,
        chat: capabilities.chat ? { endpoint: route("chat"), instructions: "Send messages with role user, assistant, or system and non-empty text content. The client supplies conversation history; the gateway does not execute tools.", input: { model, messages: [{ role: "user", content: "Hello" }], temperature: 0.7, maxTokens: 512 }, output: { content: "Hello!", done: true }, command: "hostai chat MODEL [PROMPT] [--messages FILE] [--json]" } : null,
        infer: capabilities.infer ? { instructions: item.interaction.instructions, inputSchema: item.interaction.inputSchema, outputSchema: item.interaction.outputSchema, examples: item.interaction.examples, endpoint: route("infer"), envelope: { model, input: "The provider-defined JSON value (see inputSchema)." }, outputEnvelope: "NDJSON records: event contains a provider-defined value (outputSchema); done terminates the stream. A terminal error means failure.", command: "hostai infer MODEL [JSON] [--input FILE]" } : null,
      };
      stdout.write(flags.json ? `${JSON.stringify(description)}\n` : printable(`${JSON.stringify(description, null, 2)}\n`));
      return;
    }
    if (flags.json) stdout.write(`${JSON.stringify(catalog)}\n`);
    else {
      stdout.write("MODEL\tCHAT\tINFER\tUI\n");
      for (const item of catalog.models) {
        const caps = item.capabilities ?? { chat: !item.ui, infer: !!item.ui };
        stdout.write(`${printable(String(item.name))}\t${caps.chat === true ? "yes" : "no"}\t${caps.infer === true ? "yes" : "no"}\t${item.ui && caps.infer === true ? "custom" : caps.chat === true ? "chat" : "none"}\n`);
      }
      if (!catalog.connected) stderr.write("No configured runtime is connected.\n");
    }
    return;
  }
  const post = async (path, value, onRecord, chat) => {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("Request exceeds 262144 bytes.");
    await records(await request(origin, path, body, requestSignal, token), onRecord, chat);
  };
  if (command === "infer") {
    if (flags.input !== undefined && payload !== undefined) throw new Error("Choose JSON argument or --input, not both.");
    if (flags.input === undefined && payload === undefined && stdin.isTTY) throw new Error("Provide JSON, --input FILE, or pipe JSON into stdin.");
    const input = jsonInput(flags.input !== undefined ? await fileInput(flags.input, stdin) : payload ?? await inputText(stdin));
    await post(route("infer"), { model, input }, (record) => stdout.write(`${JSON.stringify(record)}\n`), false);
    return;
  }
  const temperature = Number(flags.temperature ?? 0.7), maxTokens = Number(flags["max-tokens"] ?? 512);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error("--temperature must be between 0 and 2.");
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) throw new Error("--max-tokens must be an integer from 1 to 8192.");
  if (flags.messages !== undefined && payload !== undefined) throw new Error("Choose PROMPT or --messages, not both.");
  const send = async (messages) => {
    if (!Array.isArray(messages) || !messages.length) throw new Error("Chat input must be a non-empty array of messages.");
    let answer = "";
    try {
      await post(route("chat"), { model, messages, temperature, maxTokens }, (record) => {
        answer += record.content;
        stdout.write(flags.json ? `${JSON.stringify(record)}\n` : printable(record.content));
      }, true);
    } finally { if (!flags.json) stdout.write("\n"); }
    return answer;
  };
  if (flags.messages !== undefined) { await send(jsonInput(await fileInput(flags.messages, stdin))); return; }
  if (payload !== undefined || !stdin.isTTY) {
    const prompt = payload ?? await inputText(stdin);
    if (!prompt.trim()) throw new Error("Enter a non-empty prompt.");
    await send([{ role: "user", content: prompt }]);
    return;
  }
  const terminal = createInterface({ input: stdin, output: stderr });
  let history = [];
  stderr.write(`Chatting with ${printable(model)}. /clear resets context; /exit leaves.\n`);
  try {
    while (!requestSignal.aborted) {
      const prompt = await terminal.question("> ", { signal: requestSignal });
      if (prompt.trim() === "/exit") break;
      if (prompt.trim() === "/clear") { history = []; continue; }
      if (!prompt.trim()) continue;
      const messages = [...history, { role: "user", content: prompt }];
      const answer = await send(messages);
      history = [...messages, { role: "assistant", content: answer }];
      // Retain whole recent exchanges inside the gateway message and character limits.
      while (history.length && (history.length > 62 || history.reduce((sum, message) => sum + message.content.length, 0) > 49_152)) history.splice(0, 2);
    }
  } finally { terminal.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  main(process.argv.slice(2), { signal: controller.signal }).catch((error) => {
    process.stderr.write(controller.signal.aborted ? "Cancelled.\n" : `hostai: ${printable(error.message)}\n`);
    process.exitCode = controller.signal.aborted ? 130 : 1;
  }).finally(() => { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); });
}
