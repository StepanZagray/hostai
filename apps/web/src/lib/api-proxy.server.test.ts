import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { proxy } from "./api-proxy.server";
import { readChatStream } from "./api";

const origin = "http://127.0.0.1:3000";
function chat(body: BodyInit = "{}", headers: HeadersInit = {}, signal?: AbortSignal) {
  return new Request(`${origin}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
    signal,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  });
}
function backend(response = new Response("{}")) {
  const fetch = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("same-origin API proxy", () => {
  const requestId = "abcdef01-2345-4678-9abc-def012345678";
  const ownerRequestPaths = [
    "/api/sharing/requests/start",
    "/api/sharing/requests/stop",
    `/api/sharing/requests/${requestId}/approve`,
    `/api/sharing/requests/${requestId}/reject`,
    `/api/sharing/requests/${requestId.toUpperCase()}/approve`,
  ];
  function ownerRequest(path: string, headers: HeadersInit = {}, method = "POST") {
    return new Request(origin + path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(method === "POST"
        ? { body: JSON.stringify({ code: "ABC-123", expiresInHours: 24 }) }
        : {}),
    });
  }
  it.each(ownerRequestPaths)("forwards the exact owner request endpoint: %s", async (path) => {
    const fetch = backend();
    const request = ownerRequest(path, { Origin: origin, "Sec-Fetch-Site": "same-origin" });
    const response = await proxy({ request });
    expect(response.status).toBe(200);
    await response.text();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0].pathname).toBe(path);
    expect(fetch.mock.calls[0][1].method).toBe("POST");
    expect(JSON.parse(new TextDecoder().decode(fetch.mock.calls[0][1].body))).toEqual({
      code: "ABC-123",
      expiresInHours: 24,
    });
  });
  it.each(ownerRequestPaths)(
    "rejects cross-origin and same-site owner requests: %s",
    async (path) => {
      const fetch = backend();
      const rejected: HeadersInit[] = [
        { Origin: "https://foreign.example" },
        { Origin: "null" },
        { "Sec-Fetch-Site": "cross-site" },
        { "Sec-Fetch-Site": "same-site" },
        { "Sec-Fetch-Site": "unknown" },
        { Origin: origin, "Sec-Fetch-Site": "cross-site" },
      ];
      for (const headers of rejected) {
        expect((await proxy({ request: ownerRequest(path, headers) })).status).toBe(403);
      }
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each<HeadersInit>([{}, { "Sec-Fetch-Site": "none" }])(
    "allows non-browser owner request clients: %j",
    async (headers) => {
      const fetch = backend();
      await (await proxy({ request: ownerRequest(ownerRequestPaths[0], headers) })).text();
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
  it.each([
    "/api/sharing/requests",
    "/api/sharing/requests/START",
    "/api/sharing/requests/start/",
    "/api/sharing/requests/start/extra",
    "/api/sharing/requests//stop",
    "/api/sharing/requests/not-a-uuid/approve",
    `/api/sharing/requests/${requestId.slice(1)}/approve`,
    `/api/sharing/requests/${requestId.replace("a", "g")}/reject`,
    `/api/sharing/requests/${requestId}/APPROVE`,
    `/api/sharing/requests/${requestId}/approve/`,
    `/api/sharing/requests/${requestId}/approve/extra`,
    `/api/sharing/requests/${requestId}/revoke`,
    `/api/sharing/requests/${requestId}%2fapprove`,
    `/api/sharing/requests/${requestId}/%61pprove`,
    "/api/sharing/requests/%2e%2e/approve",
  ])("rejects malformed owner request paths: %s", async (path) => {
    const fetch = backend();
    expect((await proxy({ request: ownerRequest(path) })).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(ownerRequestPaths)(
    "requires POST and JSON for owner request actions: %s",
    async (path) => {
      const fetch = backend();
      for (const method of ["GET", "PUT", "DELETE", "OPTIONS"])
        expect((await proxy({ request: ownerRequest(path, {}, method) })).status).toBe(404);
      expect(
        (await proxy({ request: ownerRequest(path, { "Content-Type": "text/plain" }) })).status,
      ).toBe(415);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    "/api/directory",
    "/api/directory/listings",
    "/api/directory/start",
    "/api/directory/stop",
    "/registry/v1/listings",
    "/registry/v2/listings",
  ])("rejects removed discovery endpoints without contacting Java: %s", async (path) => {
    const fetch = backend();
    for (const method of ["GET", "POST"]) {
      const request = ownerRequest(
        path,
        { Origin: origin, "Sec-Fetch-Site": "same-origin" },
        method,
      );
      expect((await proxy({ request })).status).toBe(404);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    new Request(`${origin}/api/admin`),
    new Request(`${origin}/api/chat`, { method: "DELETE" }),
    new Request(`${origin}/api/status`, { method: "POST" }),
  ])("rejects requests outside the method/path allowlist", async (request) => {
    const fetch = backend();
    expect((await proxy({ request })).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects cross-origin requests and lookalike JSON media types", async () => {
    const fetch = backend();
    expect((await proxy({ request: chat("{}", { Origin: "https://example.com" }) })).status).toBe(
      403,
    );
    expect(
      (await proxy({ request: chat("{}", { "Content-Type": "application/jsonp" }) })).status,
    ).toBe(415);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("forwards a valid Unicode body over the old character limit without changing its bytes", async () => {
    const fetch = backend();
    const body = JSON.stringify({
      model: "test-model:small",
      messages: Array.from({ length: 4 }, () => ({
        role: "user",
        content: "界".repeat(1_250) + "\t".repeat(13_750),
      })),
      temperature: 0.7,
      maxTokens: 128,
    });
    const response = await proxy({
      request: chat(body, { "Content-Type": "Application/JSON; charset=utf-8" }),
    });
    await response.text();
    expect(body.length).toBeGreaterThan(100_000);
    expect(fetch).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(fetch.mock.calls[0][1].body)).toBe(body);
    expect(fetch.mock.calls[0][0].pathname).toBe("/api/chat");
  });
  it("allows exactly 256 KiB and rejects even one byte more", async () => {
    const fetch = backend();
    await (await proxy({ request: chat("a".repeat(256 * 1024)) })).text();
    expect(fetch).toHaveBeenCalledOnce();
    expect((await proxy({ request: chat("a".repeat(256 * 1024 + 1)) })).status).toBe(413);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("counts streamed Unicode bytes and stops reading before contacting Java", async () => {
    const fetch = backend();
    const cancel = vi.fn();
    const request = chat(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("界".repeat(90_000)));
        },
        cancel,
      }),
    );
    expect((await proxy({ request })).status).toBe(413);
    expect(cancel).not.toHaveBeenCalled();
    expect(request.body?.locked).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    await request.body?.cancel();
  });
  it("rejects an oversized Content-Length without reading its body", async () => {
    const fetch = backend();
    const cancel = vi.fn();
    const request = chat(new ReadableStream({ cancel }), { "Content-Length": "262145" });
    expect((await proxy({ request })).status).toBe(413);
    expect(cancel).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    await request.body?.cancel();
  });
  it("does not contact Java for an already-aborted request", async () => {
    const fetch = backend();
    const abort = new AbortController();
    abort.abort();
    await proxy({ request: chat("{}", {}, abort.signal) });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("releases an upload reader when the client disconnects", async () => {
    const fetch = backend();
    const abort = new AbortController();
    const cancel = vi.fn();
    const request = chat(new ReadableStream({ cancel }), {}, abort.signal);
    const response = proxy({ request });
    abort.abort();
    await response;
    expect(cancel).not.toHaveBeenCalled();
    expect(request.body?.locked).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    await request.body?.cancel();
  });
  it("bounds stalled upload time and reports a timeout", async () => {
    vi.useFakeTimers();
    const fetch = backend();
    const cancel = vi.fn();
    const request = chat(new ReadableStream({ cancel }));
    const response = proxy({ request });
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await response).status).toBe(504);
    expect(cancel).not.toHaveBeenCalled();
    expect(request.body?.locked).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await request.body?.cancel();
  });
  it("preserves overload status, problem details and Retry-After", async () => {
    backend(
      Response.json(
        { detail: "All generation slots are busy." },
        {
          status: 429,
          headers: { "Content-Type": "application/problem+json", "Retry-After": "1" },
        },
      ),
    );
    const response = await proxy({ request: chat() });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(await response.json()).toEqual({ detail: "All generation slots are busy." });
  });
  it("delivers terminal generation errors through the streaming proxy to the client parser", async () => {
    backend(
      new Response(
        '{"content":"Partial","done":false}\n' +
          '{"content":"","done":true,"error":"The generation exceeded its time limit."}\n',
        { headers: { "Content-Type": "application/x-ndjson" } },
      ),
    );
    const response = await proxy({ request: chat() });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    const onChunk = vi.fn();
    await expect(readChatStream(response, onChunk)).rejects.toThrow(
      "The generation exceeded its time limit.",
    );
    expect(onChunk).toHaveBeenCalledExactlyOnceWith({ content: "Partial", done: false });
  });
  it("forwards the first chunk without waiting for completion and aborts on cancellation", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const upstream = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("first\n"));
        },
        cancel,
      }),
    );
    const fetch = backend(upstream);
    const response = await proxy({ request: chat() });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first\n");
    await reader.cancel();
    reader.releaseLock();
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(upstream.body?.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("lets the backend's ten-minute deadline run and still bounds a hung backend", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, init) => {
        signal = init.signal;
        return new Promise((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
        });
      }),
    );
    const response = proxy({ request: chat() });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signal?.aborted).toBe(true);
    expect((await response).status).toBe(504);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cleans up readers and timers on upstream stream failure", async () => {
    vi.useFakeTimers();
    const upstream = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("Connection lost"));
        },
      }),
    );
    backend(upstream);
    const response = await proxy({ request: chat() });
    await expect(response.text()).rejects.toThrow("Connection lost");
    expect(upstream.body?.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reports an unreachable backend and clears its deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Connection refused")));
    const response = await proxy({ request: chat() });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      detail: "The HostAI backend is unavailable. Start the Java service, then reconnect.",
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds stalled metadata requests independently of the chat deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
          }),
      ),
    );
    const response = proxy({ request: new Request(`${origin}/api/status`) });
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await response).status).toBe(504);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves headers and cleans up for a bodyless response", async () => {
    vi.useFakeTimers();
    backend(new Response(null, { status: 204, headers: { "Retry-After": "1" } }));
    const response = await proxy({ request: new Request(`${origin}/api/status`) });
    expect(response.status).toBe(204);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("owner management proxy", () => {
  const id = "5ed717e7-26ce-4c7d-b2ea-aa03292cb572";
  const mutation = (path: string, headers: HeadersInit = {}) =>
    new Request(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: "{}",
    });
  it.each([
    "/api/model-downloads",
    `/api/model-downloads/${id}/cancel`,
    "/api/sharing/start",
    "/api/sharing/stop",
    "/api/sharing/internet/start",
    "/api/sharing/internet/stop",
    "/api/sharing/grants",
    `/api/sharing/grants/${id}/revoke`,
  ])("forwards %s with JSON negotiation", async (path) => {
    const fetch = backend();
    await (await proxy({ request: mutation(path, { Origin: origin }) })).text();
    expect(fetch.mock.calls[0][0].pathname).toBe(path);
    expect(fetch.mock.calls[0][1].headers.Accept).toBe("application/json");
  });
  it.each([
    "/api/model-downloads/not-a-job/cancel",
    "/guest/v1/chat",
    "/api/sharing/grants/not-a-uuid/revoke",
    `/api/sharing/grants/${id}/delete`,
    `/api/model-downloads/${id}/delete`,
    `/api/model-downloads/${id}/cancel/extra`,
  ])("rejects %s without upstream work", async (path) => {
    const fetch = backend();
    expect((await proxy({ request: mutation(path) })).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects cross-site metadata even when Origin is absent", async () => {
    const fetch = backend();
    expect(
      (
        await proxy({
          request: mutation("/api/model-downloads", { "Sec-Fetch-Site": "cross-site" }),
        })
      ).status,
    ).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("bounds management requests independently of a running download", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) =>
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }),
          ),
      ),
    );
    const response = proxy({ request: mutation("/api/model-downloads") });
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await response).status).toBe(504);
    expect(vi.getTimerCount()).toBe(0);
  });
});
