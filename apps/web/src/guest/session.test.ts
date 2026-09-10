import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { retryAfter } from "./session";

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
