import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { guestInfer } from "./infer";

const session = { model: "pebby:latest", scope: "local-preview" as const };

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 204 })),
  );
});
afterEach(() => vi.unstubAllGlobals());

it("posts { model, input } to /guest/v1/infer with the key only in the Authorization header", async () => {
  const controller = new AbortController();
  await guestInfer("private-key", session, { ping: 1 }, controller.signal);
  const mock = vi.mocked(fetch);
  expect(mock).toHaveBeenCalledTimes(1);
  const [path, init] = mock.mock.calls[0] as [string, RequestInit];
  expect(path).toBe("/guest/v1/infer");
  expect(init.method).toBe("POST");
  expect(init.signal).toBe(controller.signal);
  expect(init.credentials).toBe("omit");
  expect(init.redirect).toBe("error");
  expect(init.referrerPolicy).toBe("no-referrer");
  expect(JSON.parse(init.body as string)).toEqual({ model: "pebby:latest", input: { ping: 1 } });
  expect(init.headers).toEqual({
    Accept: "application/x-ndjson",
    "Content-Type": "application/json",
    Authorization: "Bearer private-key",
  });
  expect(init.body).not.toContain("private-key");
});

it("rejects inputs JSON cannot carry or that exceed the request limit before any request", async () => {
  const signal = new AbortController().signal;
  await expect(guestInfer("private-key", session, 1n, signal)).rejects.toThrow(
    "Invalid client request.",
  );
  await expect(guestInfer("private-key", session, "x".repeat(262_200), signal)).rejects.toThrow(
    "Invalid client request.",
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("uses the WebSocket transport for temporary internet access", async () => {
  class Socket {
    static created = 0;
    onopen: (() => void) | null = null;
    onmessage: unknown = null;
    onerror: unknown = null;
    onclose: unknown = null;
    constructor(readonly url: URL) {
      Socket.created++;
    }
    send() {}
    close() {}
  }
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("window", { location: { href: "https://fixture.example/" } });
  const controller = new AbortController();
  const pending = guestInfer(
    "private-key",
    { ...session, scope: "temporary-internet" },
    { ping: 1 },
    controller.signal,
  );
  expect(Socket.created).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});
