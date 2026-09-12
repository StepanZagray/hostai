import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { readChatStream, readInferStream, type InferRecord } from "../lib/api";
import { guestInferSocket, guestSocket } from "./socket";

class Socket {
  static instances: Socket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  closes = 0;
  constructor(readonly url: URL) {
    Socket.instances.push(this);
  }
  send(message: string) {
    this.sent.push(message);
  }
  close() {
    this.closes++;
  }
  frame(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent);
  }
}
const body = JSON.stringify({
  model: "fixture:small",
  messages: [{ role: "user", content: "Hello" }],
  temperature: 0.7,
  maxTokens: 128,
});
beforeEach(() => {
  vi.useFakeTimers();
  Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("window", {
    location: { href: "https://fixture.example/?owner=no#access=private-key" },
  });
});
afterEach(() => {
  for (const socket of Socket.instances) socket.onclose?.();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function start() {
  const controller = new AbortController();
  const response = guestSocket("private-key", body, controller.signal);
  const socket = Socket.instances.at(-1)!;
  return { controller, response, socket };
}

it("sends one credential envelope after opening and closes at the terminal record", async () => {
  const { response, socket } = start();
  expect(socket.url.href).toBe("wss://fixture.example/guest/v1/chat-stream");
  expect(socket.sent).toEqual([]);
  socket.onopen!();
  expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
    { key: "private-key", request: JSON.parse(body) },
  ]);
  socket.frame({ content: "First ", done: false });
  const chunks: string[] = [];
  const reading = readChatStream(await response, (chunk) => chunks.push(chunk.content));
  await Promise.resolve();
  socket.frame({ content: "second", done: true });
  await reading;
  expect(chunks).toEqual(["First ", "second"]);
  expect(socket.closes).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([401, 403, 408, 429, 503])(
  "preserves pre-stream status %s without returning server details",
  async (status) => {
    const { response, socket } = start();
    socket.onopen!();
    socket.frame({ type: "error", status, retryAfter: 12, detail: "private-key" });
    const result = await response;
    expect(result.status).toBe(status);
    expect(await result.text()).toBe("");
    expect(result.headers.get("Retry-After")).toBe(status === 429 ? "12" : null);
    expect(socket.closes).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("abort before a first frame closes the socket without waiting for the host", async () => {
  const { controller, response, socket } = start();
  const rejection = expect(response).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await rejection;
  expect(socket.sent).toEqual([]);
  expect(socket.onopen).toBeNull();
  expect(socket.closes).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("abort during a response rejects its reader and closes the one owned socket", async () => {
  const { controller, response, socket } = start();
  socket.onopen!();
  socket.frame({ content: "Partial", done: false });
  const reader = (await response).body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("Partial");
  const reading = expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await reading;
  reader.releaseLock();
  expect(socket.closes).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("a truncated socket never turns partial output into a completed answer", async () => {
  const { response, socket } = start();
  socket.onopen!();
  socket.frame({ content: "Partial", done: false });
  const reading = readChatStream(await response, () => {});
  const rejection = expect(reading).rejects.toThrow("ended before completion");
  socket.onclose!();
  await rejection;
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects invalid or binary frames and closes before exposing a response", async () => {
  for (const data of [
    "not json",
    new ArrayBuffer(8),
    JSON.stringify({ type: "error", status: 200 }),
  ]) {
    const { response, socket } = start();
    const rejection = expect(response).rejects.toThrow("ended before completion");
    socket.onmessage!({ data } as MessageEvent);
    await rejection;
    expect(socket.closes).toBe(1);
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds queued output when the consumer stops reading", async () => {
  const { response, socket } = start();
  socket.onopen!();
  socket.frame({ content: "x".repeat(600_000), done: false });
  const result = await response;
  socket.frame({ content: "x".repeat(600_000), done: false });
  await expect(result.text()).rejects.toThrow("ended before completion");
  expect(socket.closes).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds opening, first-frame and overall waits without automatic retries", async () => {
  let attempt = start();
  let rejection = expect(attempt.response).rejects.toThrow("ended before completion");
  await vi.advanceTimersByTimeAsync(10_000);
  await rejection;
  expect(attempt.socket.sent).toEqual([]);
  attempt = start();
  attempt.socket.onopen!();
  rejection = expect(attempt.response).rejects.toThrow("ended before completion");
  await vi.advanceTimersByTimeAsync(70_000);
  await rejection;
  attempt = start();
  attempt.socket.onopen!();
  attempt.socket.frame({ content: "", done: false });
  const reading = readChatStream(await attempt.response, () => {});
  const timedOut = expect(reading).rejects.toThrow("ended before completion");
  for (let i = 0; i < 20; i++) {
    await vi.advanceTimersByTimeAsync(30_000);
    attempt.socket.frame({ content: "", done: false });
  }
  await vi.advanceTimersByTimeAsync(15_001);
  await timedOut;
  expect(Socket.instances).toHaveLength(3);
  expect(vi.getTimerCount()).toBe(0);
});

it("cancelled and oversized submissions open no network connection", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(guestSocket("key", body, controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  await expect(
    guestSocket("key", "x".repeat(262_145), new AbortController().signal),
  ).rejects.toThrow("Invalid client request");
  expect(Socket.instances).toEqual([]);
});

it("sends an infer envelope with the key first and relays infer records unchanged", async () => {
  const controller = new AbortController();
  const response = guestInferSocket(
    "private-key",
    "pebby:latest",
    { board: [[0, 1]] },
    controller.signal,
  );
  const socket = Socket.instances.at(-1)!;
  expect(socket.url.href).toBe("wss://fixture.example/guest/v1/chat-stream");
  expect(socket.url.href).not.toContain("private-key");
  socket.onopen!();
  expect(socket.sent).toHaveLength(1);
  expect(JSON.parse(socket.sent[0])).toEqual({
    key: "private-key",
    infer: { model: "pebby:latest", input: { board: [[0, 1]] } },
  });
  expect(Object.keys(JSON.parse(socket.sent[0]))[0]).toBe("key");
  socket.frame({ event: { pong: 1 }, done: false });
  const records: InferRecord[] = [];
  const reading = readInferStream(await response, (record) => records.push(record));
  await Promise.resolve();
  socket.frame({ done: true });
  await reading;
  expect(records).toEqual([{ event: { pong: 1 }, done: false }, { done: true }]);
  expect(socket.closes).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects an infer input that JSON cannot carry without opening a socket", async () => {
  const before = Socket.instances.length;
  const signal = new AbortController().signal;
  const outcomes: string[] = [];
  for (const input of [1n, "x".repeat(262_200)])
    await guestInferSocket("private-key", "pebby:latest", input, signal).then(
      () => outcomes.push("resolved"),
      (error: Error) => outcomes.push(error.message),
    );
  expect(outcomes).toEqual(["Invalid client request.", "Invalid client request."]);
  expect(Socket.instances).toHaveLength(before);
});
