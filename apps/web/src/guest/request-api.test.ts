import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  parseAccessRequest,
  parseRequestHello,
  requestJson,
  requestRetrySeconds,
} from "./request-api";

const id = "51e6b724-f7f7-4dd1-a74a-7140f86eaf3b";
const expected = { name: "Guest", model: "model:small" };
const pending = {
  version: 1,
  id,
  state: "pending",
  code: "ABC-123",
  ...expected,
  channel: "internet",
  expiresInSeconds: 900,
  grantId: null,
  grantExpiresAt: null,
};
const hello = {
  version: 1,
  scope: "temporary-internet",
  requestsAccepted: true,
  intakeId: id,
  hostLabel: "Host",
  model: expected.model,
};
const secret = "A".repeat(43);
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { location: { protocol: "https:" } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("request protocol parsing", () => {
  it("accepts v1 internet details and requires null metadata when intake is closed", () => {
    expect(parseRequestHello(hello)).toEqual(hello);
    expect(parseRequestHello({ ...hello, requestsAccepted: false })).toBeNull();
    expect(
      parseRequestHello({
        ...hello,
        requestsAccepted: false,
        intakeId: null,
        hostLabel: null,
        model: null,
      })?.requestsAccepted,
    ).toBe(false);
    for (const change of [
      { version: 2 },
      { scope: "local-preview" },
      { intakeId: "bad" },
      { model: null },
      { requestsAccepted: "true" },
    ])
      expect(parseRequestHello({ ...hello, ...change })).toBeNull();
    expect(parseRequestHello(null)).toBeNull();
  });

  it("accepts the optional code separator, strips extras and validates echoed identity", () => {
    const parsed = parseAccessRequest(
      { ...pending, requestedAt: "2026-01-01T00:00:00Z", extra: secret },
      expected,
    )!;
    expect(parsed.code).toBe("ABC123");
    expect(parsed).not.toHaveProperty("extra");
    expect(parseAccessRequest({ ...pending, code: "ABC123" }, expected, parsed)).toEqual(parsed);
    for (const change of [
      { name: "Other" },
      { model: "other" },
      { id: "61e6b724-f7f7-4dd1-a74a-7140f86eaf3b" },
      { code: "ZZZ999" },
    ])
      expect(parseAccessRequest({ ...pending, ...change }, expected, parsed)).toBeNull();
  });

  it("rejects malformed fields, unsafe grants, out-of-bounds TTLs and state regressions", () => {
    for (const change of [
      { version: 2 },
      { id: `${id}\n` },
      { state: "unknown" },
      { code: "ILI-OUU" },
      { code: "ABC123\n" },
      { name: "X".repeat(41) },
      { channel: "local" },
      { expiresInSeconds: -1 },
      { expiresInSeconds: 901 },
      { expiresInSeconds: 1.5 },
      { expiresInSeconds: "900" },
      { grantId: id },
      { grantExpiresAt: "tomorrow" },
      { state: "approved" },
    ])
      expect(parseAccessRequest({ ...pending, ...change }, expected)).toBeNull();
    const approved = parseAccessRequest(
      { ...pending, state: "approved", grantId: id, grantExpiresAt: "2026-09-10T01:00:00Z" },
      expected,
    )!;
    expect(approved.state).toBe("approved");
    expect(parseAccessRequest(pending, expected, approved)).toBeNull();
    expect(parseAccessRequest({ ...approved, state: "revoked" }, expected, approved)?.state).toBe(
      "revoked",
    );
    expect(
      parseAccessRequest(
        { ...approved, state: "cancelled", grantId: null, grantExpiresAt: null },
        expected,
        approved,
      )?.state,
    ).toBe("cancelled");
    expect(parseAccessRequest(approved, expected, { ...approved, state: "cancelled" })).toBeNull();
  });
});

describe("bounded credential transport", () => {
  it("uses fixed endpoints, no ambient credentials, and only a request bearer on authenticated calls", async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json(hello)));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    await requestJson("/guest/v1/hello", signal);
    const [, init] = fetch.mock.calls[0];
    expect(init).toMatchObject({
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      mode: "same-origin",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { Accept: "application/json" },
    });
    expect(init.headers).not.toHaveProperty("Authorization");
    const body = { intakeId: id, ...expected, accessCommitment: "f".repeat(64) };
    await requestJson("/guest/v1/requests", signal, secret, body);
    expect(fetch.mock.calls[1]).toEqual([
      "/guest/v1/requests",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer hgq1.${secret}`,
        },
      }),
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses insecure origins, pre-aborted work and oversized UTF-8 submissions before fetching", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    controller.abort();
    await expect(requestJson("/guest/v1/hello", controller.signal)).rejects.toThrow();
    await expect(
      requestJson("/guest/v1/requests", new AbortController().signal, secret, {
        intakeId: id,
        name: "Guest",
        model: "🌍".repeat(1000),
        accessCommitment: "f".repeat(64),
      }),
    ).rejects.toThrow();
    vi.stubGlobal("window", { location: { protocol: "http:" } });
    await expect(requestJson("/guest/v1/hello", new AbortController().signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([400, 401, 403, 404, 409, 410, 429, 500, 503])(
    "maps HTTP %s without reading or echoing provider errors",
    async (status) => {
      const cancel = vi.fn();
      const response = new Response(new ReadableStream({ cancel }), {
        status,
        headers: { "Retry-After": "20" },
      });
      const read = vi.spyOn(response, "json");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      await expect(
        requestJson("/guest/v1/hello", new AbortController().signal),
      ).rejects.toMatchObject({ status, retrySeconds: status === 429 ? 20 : 0 });
      expect(read).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("bounds backoff hints, including HTTP dates and malformed values", () => {
    for (const [value, seconds] of [
      ["0", 1],
      ["45", 45],
      ["99999999999", 60],
      ["nonsense", 5],
      ["", 5],
    ] as const)
      expect(requestRetrySeconds(new Response(null, { headers: { "Retry-After": value } }))).toBe(
        seconds,
      );
    const later = new Date(Date.now() + 30_000).toUTCString();
    expect(requestRetrySeconds(new Response(null, { headers: { "Retry-After": later } }))).toBe(30);
  });

  it("enforces the 32 KiB limit while streaming without trusting Content-Length", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(16384));
          controller.enqueue(new Uint8Array(16385));
        },
        cancel,
      }),
      { headers: { "Content-Type": "application/json", "Content-Length": "1" } },
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(requestJson("/guest/v1/hello", new AbortController().signal)).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["headers", "body"])(
    "enforces a single 10s deadline through stalled %s",
    async (stage) => {
      const cancel = vi.fn();
      const response = new Response(new ReadableStream({ cancel }), {
        headers: { "Content-Type": "application/json" },
      });
      const fetch = vi
        .fn()
        .mockImplementation(() =>
          stage === "headers" ? new Promise(() => {}) : Promise.resolve(response),
        );
      vi.stubGlobal("fetch", fetch);
      const attempt = requestJson("/guest/v1/hello", new AbortController().signal);
      const rejection = expect(attempt).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(10_000);
      await rejection;
      expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
      if (stage === "body") {
        expect(cancel).toHaveBeenCalledOnce();
        expect(response.body!.locked).toBe(false);
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
