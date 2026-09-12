import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { parseSession, retryAfter } from "./session";
import { modelInterface } from "../lib/model-admission";

afterEach(() => vi.restoreAllMocks());

describe("guest retry deadlines", () => {
  it("anchors seconds to monotonic time regardless of device date", () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    vi.spyOn(Date, "now").mockReturnValue(0);
    const response = new Response(null, { headers: { "Retry-After": "12" } });
    expect(retryAfter(response)).toBe(13_000);
    expect(
      retryAfter(new Response(null, { headers: { "Retry-After": "12", Date: "invalid" } })),
    ).toBe(13_000);
    vi.spyOn(Date, "now").mockReturnValue(9_000_000_000_000);
    expect(retryAfter(response)).toBe(13_000);
  });

  it("uses the host Date for HTTP-date waits and bounds excessive waits", () => {
    vi.spyOn(performance, "now").mockReturnValue(500);
    const host = "Thu, 10 Sep 2026 02:00:00 GMT";
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Do not use the device date");
    });
    expect(
      retryAfter(
        new Response(null, {
          headers: {
            Date: host,
            "Retry-After": "Thu, 10 Sep 2026 02:00:12 GMT",
          },
        }),
      ),
    ).toBe(12_500);
    for (const value of ["99999999999999999999999999", "Fri, 11 Sep 2026 02:00:00 GMT"])
      expect(
        retryAfter(new Response(null, { headers: { Date: host, "Retry-After": value } })),
      ).toBe(300_500);
  });

  it("does not invent waits from missing, invalid or elapsed dates", () => {
    const cases: Record<string, string>[] = [
      {},
      { "Retry-After": "invalid" },
      { "Retry-After": "0" },
      { "Retry-After": "Thu, 10 Sep 2026 02:00:00 GMT" },
      { "Retry-After": "Thu, 10 Sep 2026 02:00:00 GMT", Date: "invalid" },
      { "Retry-After": "Thu, 10 Sep 2026 02:00:00 GMT", Date: "Thu, 10 Sep 2026 02:01:00 GMT" },
    ];
    for (const headers of cases) expect(retryAfter(new Response(null, { headers }))).toBe(0);
  });
});

describe("guest session metadata", () => {
  const base = {
    hostLabel: "A host",
    model: "pebby:latest",
    expiresAt: "2026-09-11T10:00:00Z",
    available: true,
    unavailableReason: null,
    maxConcurrentGuests: 1,
    maxTokens: 1024,
    requestsPerMinute: 6,
    scope: "local-preview",
  };

  it("treats a missing ui field as the default chat interface", () => {
    expect(parseSession(base)?.ui).toBeNull();
    expect(parseSession({ ...base, ui: null })?.ui).toBeNull();
  });

  it("uses explicit capabilities rather than assuming missing UI means chat", () => {
    const unsupported = parseSession({ ...base, capabilities: { chat: false, infer: true } })!;
    expect(modelInterface(unsupported)).toBe("unsupported");
    const chat = parseSession({ ...base, capabilities: { chat: true, infer: false } })!;
    expect(modelInterface(chat)).toBe("chat");
    const malformed = parseSession({ ...base, capabilities: { chat: "true", infer: false } })!;
    expect(modelInterface(malformed)).toBe("unsupported");
  });

  it("keeps a well-formed runtime interface", () => {
    expect(parseSession({ ...base, ui: { runtime: "stub", entry: "ui/index.html" } })?.ui).toEqual({
      runtime: "stub",
      entry: "ui/index.html",
    });
    expect(
      parseSession({ ...base, ui: { runtime: "a0-b", entry: "a/b/c/d/e/f/g/h.html" } })?.ui,
    ).toEqual({ runtime: "a0-b", entry: "a/b/c/d/e/f/g/h.html" });
  });

  it("falls back to chat when the ui grammar is violated", () => {
    const invalid: unknown[] = [
      "ui/index.html",
      { runtime: "stub" },
      { runtime: "Stub", entry: "ui/index.html" },
      { runtime: "-stub", entry: "ui/index.html" },
      { runtime: "s".repeat(33), entry: "ui/index.html" },
      { runtime: "stub", entry: "../index.html" },
      { runtime: "stub", entry: "ui/../index.html" },
      { runtime: "stub", entry: "/ui/index.html" },
      { runtime: "stub", entry: "ui//index.html" },
      { runtime: "stub", entry: "ui/index.html?x=1" },
      { runtime: "stub", entry: "a/b/c/d/e/f/g/h/i.html" },
      { runtime: "stub", entry: "ui/in dex.html" },
    ];
    for (const ui of invalid) {
      const session = parseSession({ ...base, ui });
      expect(session, JSON.stringify(ui)).not.toBeNull();
      expect(session?.ui, JSON.stringify(ui)).toBeNull();
    }
  });
});
