import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { modelUiPolicy, proxy } from "./api-proxy.server";
import { readChatStream } from "./api";

const origin = "http://127.0.0.1:3000";
function post(
  path: string,
  body: BodyInit = "{}",
  headers: HeadersInit = {},
  signal?: AbortSignal,
) {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
    signal,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  });
}
function chat(body: BodyInit = "{}", headers: HeadersInit = {}, signal?: AbortSignal) {
  return post("/api/chat", body, headers, signal);
}
function infer(body: BodyInit = "{}", headers: HeadersInit = {}, signal?: AbortSignal) {
  return post("/api/infer", body, headers, signal);
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
    "allows non-browser owner request guests: %j",
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
    "/api/sharing/grants/cleanup",
    `/api/sharing/grants/${id}/revoke`,
    `/api/sharing/grants/${id}/key`,
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
    "/api/sharing/grants/not-a-uuid/key",
    `/api/sharing/grants/${id}/key/extra`,
    `/api/sharing/grants/${id}/delete`,
    `/api/model-downloads/${id}/delete`,
    `/api/model-downloads/${id}/cancel/extra`,
  ])("rejects %s without upstream work", async (path) => {
    const fetch = backend();
    expect((await proxy({ request: mutation(path) })).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects cross-origin key cleanup without upstream work", async () => {
    const fetch = backend();
    const rejected: HeadersInit[] = [
      { Origin: "https://foreign.example" },
      { "Sec-Fetch-Site": "cross-site" },
    ];
    for (const headers of rejected) {
      expect(
        (await proxy({ request: mutation("/api/sharing/grants/cleanup", headers) })).status,
      ).toBe(403);
    }
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

describe("structured inference proxy", () => {
  it("forwards POST /api/infer with NDJSON negotiation and streams the body through", async () => {
    const fetch = backend(
      new Response('{"event":{"n":1},"done":false}\n{"done":true}\n', {
        headers: { "Content-Type": "application/x-ndjson" },
      }),
    );
    const body = JSON.stringify({ model: "pebby:1", input: { n: 1 } });
    const response = await proxy({ request: infer(body, { Origin: origin }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    expect(await response.text()).toBe('{"event":{"n":1},"done":false}\n{"done":true}\n');
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0].pathname).toBe("/api/infer");
    expect(fetch.mock.calls[0][1].method).toBe("POST");
    expect(fetch.mock.calls[0][1].headers.Accept).toBe("application/x-ndjson");
    expect(new TextDecoder().decode(fetch.mock.calls[0][1].body)).toBe(body);
  });
  it("gives /api/infer the same ten-minute deadline as chat", async () => {
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
    const response = proxy({ request: infer() });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signal?.aborted).toBe(true);
    expect((await response).status).toBe(504);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects cross-origin, non-JSON and GET /api/infer without upstream work", async () => {
    const fetch = backend();
    expect((await proxy({ request: infer("{}", { Origin: "https://example.com" }) })).status).toBe(
      403,
    );
    expect((await proxy({ request: infer("{}", { "Sec-Fetch-Site": "cross-site" }) })).status).toBe(
      403,
    );
    expect((await proxy({ request: infer("{}", { "Content-Type": "text/plain" }) })).status).toBe(
      415,
    );
    expect((await proxy({ request: new Request(`${origin}/api/infer`) })).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("model UI asset proxy", () => {
  const asset = (path: string, method = "GET") => new Request(`${origin}${path}`, { method });
  it("forwards a valid asset path and applies the model-UI headers", async () => {
    const fetch = backend(
      new Response("<!doctype html><title>UI</title>", {
        headers: { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY" },
      }),
    );
    const response = await proxy({ request: asset("/api/model-ui/pebby/ui/index.html") });
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0].pathname).toBe("/api/model-ui/pebby/ui/index.html");
    expect(fetch.mock.calls[0][1].method).toBe("GET");
    expect(fetch.mock.calls[0][1].headers.Accept).toBe("*/*");
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const policy = response.headers.get("content-security-policy");
    expect(policy).toBe(modelUiPolicy(origin));
    expect(policy).toContain(`frame-ancestors 'self' ${origin}`);
    expect(policy).toContain("connect-src 'none'");
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(await response.text()).toBe("<!doctype html><title>UI</title>");
  });
  it("defaults the content type when upstream omits it", async () => {
    backend(new Response(new Uint8Array([0, 1, 2]), { headers: {} }));
    const response = await proxy({ request: asset("/api/model-ui/pebby/ui/app.wasm") });
    // The Response constructor sets no content-type for a byte body.
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2]));
  });
  it("preserves an upstream 404 for a missing asset", async () => {
    backend(Response.json({ detail: "Not found." }, { status: 404 }));
    const response = await proxy({ request: asset("/api/model-ui/pebby/ui/missing.js") });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-security-policy")).toBe(modelUiPolicy(origin));
    expect(await response.json()).toEqual({ detail: "Not found." });
  });
  it("accepts up to eight path segments", async () => {
    const fetch = backend();
    await (await proxy({ request: asset("/api/model-ui/pebby/a/b/c/d/e/f/g/h.html") })).text();
    expect(fetch).toHaveBeenCalledOnce();
  });
  // The WHATWG URL parser resolves literal "." and ".." segments before the proxy sees the
  // pathname, so those cases cannot reach the allowlist; the percent-encoded form stays encoded
  // and exercises the proxy's own check.
  it.each([
    asset("/api/model-ui"),
    asset("/api/model-ui/"),
    asset("/api/model-ui/pebby"),
    asset("/api/model-ui/pebby/"),
    asset("/api/model-ui/Pebby/ui/index.html"),
    asset("/api/model-ui/-pebby/ui/index.html"),
    asset(`/api/model-ui/${"a".repeat(33)}/ui/index.html`),
    asset("/api/model-ui/pebby/ui//index.html"),
    asset("/api/model-ui/pebby/%2e%2e/index.html"),
    asset("/api/model-ui/pebby/ui/index%2ehtml"),
    asset("/api/model-ui/pebby/ui/in dex.html"),
    asset("/api/model-ui/pebby/a/b/c/d/e/f/g/h/i.html"),
    asset("/api/model-ui/pebby/ui/index.html", "POST"),
  ])("rejects $url without upstream work", async (request) => {
    const fetch = backend();
    expect((await proxy({ request })).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});
