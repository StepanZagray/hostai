import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { AccessRequests } from "./access-requests";
import {
  canRequestAction,
  parseRequests,
  type OwnerRequest,
  type RequestAction,
  type RequestsStatus,
  type RequestSharingStatus,
} from "./access-requests-model";

const id = "abcdef01-2345-4678-9abc-def012345678";
const intakeId = "abcdef01-2345-4678-9abc-def012345679";
const grantId = "abcdef01-2345-4678-9abc-def012345680";
function item(overrides: Partial<OwnerRequest> = {}): OwnerRequest {
  return {
    version: 1,
    id,
    state: "pending",
    code: "ABC-123",
    name: "Visitor",
    model: "test:small",
    channel: "internet",
    expiresInSeconds: 900,
    grantId: null,
    grantExpiresAt: null,
    requestedAt: "2026-09-10T00:00:00Z",
    ...overrides,
  };
}
function requests(overrides: Partial<RequestsStatus> = {}): RequestsStatus {
  return {
    enabled: true,
    available: true,
    intakeId,
    remainingGrantSlots: 100,
    remainingRequestSlots: 20,
    items: [item()],
    ...overrides,
  };
}
function status(overrides: Partial<RequestsStatus> = {}): RequestSharingStatus {
  return {
    state: "local",
    model: "test:small",
    internet: { state: "live" },
    requests: requests(overrides),
  };
}
const approve: RequestAction = { type: "approve", id, code: "ABC-123", expiresInHours: 24 };
const reject: RequestAction = { type: "reject", id, code: "ABC-123" };
function render(
  snapshot: RequestSharingStatus | null = status(),
  overrides: Partial<Parameters<typeof AccessRequests>[0]> = {},
) {
  return renderToStaticMarkup(
    <AccessRequests
      status={snapshot}
      ready
      pending=""
      error={false}
      refreshing={false}
      approvalUncertain={false}
      onAction={() => {}}
      {...overrides}
    />,
  );
}
function button(html: string, label: string) {
  return html.match(new RegExp(`<button\\b[^>]*>${label}</button>`))?.[0];
}

describe("owner request status validation", () => {
  it("accepts older backends and current intake states", () => {
    expect(parseRequests(undefined)).toBeUndefined();
    expect(parseRequests(requests())).toEqual(requests());
    expect(
      parseRequests(requests({ enabled: false, available: false, intakeId: null, items: [] })),
    ).toBeDefined();
    expect(parseRequests(requests({ available: false }))).toBeDefined();
    expect(parseRequests(requests({ items: [item({ code: "abc123" })] }))).toBeDefined();
  });
  it.each([
    null,
    [],
    {},
    requests({ enabled: "true" as never }),
    requests({ available: 1 as never }),
    requests({ intakeId: "not-a-uuid" }),
    requests({ intakeId: null }),
    requests({ enabled: false }),
    requests({ remainingGrantSlots: 101 }),
    requests({ remainingGrantSlots: -1 }),
    requests({ remainingGrantSlots: 1.5 }),
    requests({ remainingRequestSlots: 21 }),
    requests({ remainingRequestSlots: "1" as never }),
    requests({ remainingGrantSlots: 0 }),
    requests({ remainingRequestSlots: 0 }),
    requests({ items: null as never }),
  ])("rejects malformed intake data %#", (value) => {
    expect(() => parseRequests(value)).toThrow("Guest access request status could not be read");
  });
  it.each([
    { version: 2 },
    { id: "not-a-uuid" },
    { state: "unknown" },
    { state: "toString" },
    { code: "ABC12" },
    { code: "ABC--123" },
    { code: "ILOU12" },
    { code: "ABC/12" },
    { name: "x".repeat(41) },
    { name: null },
    { model: null },
    { channel: "local" },
    { expiresInSeconds: -1 },
    { expiresInSeconds: 901 },
    { expiresInSeconds: 1.5 },
    { grantId: "invalid" },
    { grantExpiresAt: "yesterday" },
    { requestedAt: "1" },
    { requestedAt: "2026-09-10" },
    { state: "approved" },
  ])("rejects invalid or unknown owner rows: %j", (overrides) => {
    expect(() =>
      parseRequests(requests({ items: [item(overrides as Partial<OwnerRequest>)] })),
    ).toThrow();
  });
  it("rejects duplicate identifiers and more than ten pending rows", () => {
    expect(() =>
      parseRequests(requests({ items: [item(), item({ id: id.toUpperCase() })] })),
    ).toThrow();
    const items = Array.from({ length: 11 }, (_, index) =>
      item({ id: `abcdef01-2345-4678-9abc-${String(index).padStart(12, "0")}` }),
    );
    expect(() => parseRequests(requests({ items }))).toThrow();
    expect(parseRequests(requests({ items: items.slice(0, 10) }))?.items).toHaveLength(10);
  });
  it("accepts resolved records and approved grant metadata", () => {
    for (const state of [
      "approved",
      "rejected",
      "cancelled",
      "expired",
      "revoked",
      "failed",
    ] as const) {
      expect(
        parseRequests(
          requests({
            items: [item({ state, grantId, grantExpiresAt: "2026-09-11T00:00:00.000Z" })],
          }),
        )?.items[0].state,
      ).toBe(state);
    }
  });
});

describe("request action safety", () => {
  it("starts a disabled intake only while local sharing and internet are live with both capacities", () => {
    const snapshot = status({ enabled: false, available: false, intakeId: null, items: [] });
    expect(canRequestAction({ type: "start" }, snapshot, true)).toBe(true);
    expect(canRequestAction({ type: "start" }, snapshot, false)).toBe(false);
    expect(canRequestAction({ type: "start" }, { ...snapshot, state: "stopped" }, true)).toBe(
      false,
    );
    expect(
      canRequestAction(
        { type: "start" },
        { ...snapshot, internet: { state: "interrupted" } },
        true,
      ),
    ).toBe(false);
    for (const key of ["remainingGrantSlots", "remainingRequestSlots"] as const)
      expect(
        canRequestAction(
          { type: "start" },
          { ...snapshot, requests: { ...snapshot.requests!, [key]: 0 } },
          true,
        ),
      ).toBe(false);
  });
  it("requires a matching pending request and an explicit valid approval duration", () => {
    expect(canRequestAction(approve, status(), true)).toBe(true);
    for (const expiresInHours of [0, NaN, 1.5, 169])
      expect(canRequestAction({ ...approve, expiresInHours }, status(), true)).toBe(false);
    for (const expiresInHours of [1, 24, 168])
      expect(canRequestAction({ ...approve, expiresInHours }, status(), true)).toBe(true);
    for (const changed of [
      { id: grantId },
      { code: "XYZ-789" },
      { model: "different" },
      { expiresInSeconds: 0 },
      { state: "expired" as const },
    ])
      expect(canRequestAction(approve, status({ items: [item(changed)] }), true)).toBe(false);
  });
  it("blocks approvals when stale, offline, unavailable, full, or awaiting explicit refresh", () => {
    expect(canRequestAction(approve, status(), false)).toBe(false);
    expect(canRequestAction(approve, status(), true, true)).toBe(false);
    expect(
      canRequestAction(approve, { ...status(), internet: { state: "interrupted" } }, true),
    ).toBe(false);
    expect(canRequestAction(approve, { ...status(), requests: undefined }, true)).toBe(false);
    for (const overrides of [
      { available: false },
      { enabled: false },
      { remainingGrantSlots: 0 },
      { remainingRequestSlots: 0 },
    ])
      expect(canRequestAction(approve, status(overrides), true)).toBe(false);
  });
  it("allows rejection at capacity and emergency stop despite stale or unavailable status", () => {
    expect(
      canRequestAction(reject, status({ available: false, remainingGrantSlots: 0 }), true, true),
    ).toBe(true);
    expect(canRequestAction(reject, status(), false)).toBe(false);
    expect(canRequestAction({ type: "stop" }, null, false, true)).toBe(true);
  });
});

describe("request panel markup", () => {
  it("starts every row with an unchosen duration and unique accessible DOM references", () => {
    const html = render(status({ items: [item(), item({ id: grantId })] }));
    expect(
      html.match(/<option value="" disabled="" selected="">Choose a duration<\/option>/g),
    ).toHaveLength(2);
    expect(html.match(/<button[^>]* disabled=""[^>]*>Approve<\/button>/g)).toHaveLength(2);
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const match of html.matchAll(/(?:for|aria-describedby|aria-labelledby)="([^"]+)"/g))
      for (const reference of match[1].split(" ")) expect(ids).toContain(reference);
    expect(html).toContain("Approval grants internet access to");
    expect(html).toContain("Guest names are unverified");
    expect(html).toContain("does not verify identity");
    expect(html).not.toMatch(/<button[^>]*>Copy/);
  });
  it("keeps stop enabled on error and disables all mutation buttons while pending", () => {
    const stale = render(status(), { ready: false, error: true });
    expect(button(stale, "Stop requests")).not.toContain(' disabled=""');
    expect(button(stale, "Reject")).toContain(' disabled=""');
    const pending = render(status(), { pending: "request-approve:other" });
    for (const label of ["Stop requests", "Approve", "Reject", "Refresh status"])
      expect(button(pending, label)).toContain(' disabled=""');
  });
  it("explains uncertain approvals and requires refresh before enabling another approval", () => {
    const html = render(status(), { approvalUncertain: true });
    expect(html).toContain("Approval could not be confirmed");
    expect(html).toContain("does not create a second key");
    expect(button(html, "Refresh status")).not.toContain(' disabled=""');
    expect(button(html, "Approve")).toContain(' disabled=""');
  });
  it("explains the separate limits without promising key deletion", () => {
    const total = render(status({ available: false, remainingGrantSlots: 0 }));
    expect(total).toContain("0 of 100 retained key slots remaining");
    expect(total).toContain("there is no key deletion control");
    expect(total).toContain("does not free a stored key slot");
    const active = render(status({ available: false, remainingRequestSlots: 0 }));
    expect(active).toContain("revoke one in Access keys below");
  });
  it("shows pending rows first and only five compact resolved rows until expanded", () => {
    const items = Array.from({ length: 99 }, (_, index) =>
      item({
        id: `abcdef01-2345-4678-9abc-${String(index).padStart(12, "0")}`,
        name: `Resolved ${index}`,
        state: "rejected",
        requestedAt: `2026-09-10T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`,
      }),
    );
    const html = render(status({ items: [...items, item()] }));
    expect(html.match(/<li\b/g)).toHaveLength(6);
    expect(html.indexOf("Pending requests")).toBeLessThan(html.indexOf("Recent resolved requests"));
    expect(html).toContain("Show all 99 resolved requests");
    expect(html).toContain("Resolved 98");
    expect(html).not.toContain("Resolved 0");
  });
  it("renders loading, older-backend, empty, and escaped untrusted names", () => {
    expect(render(null, { ready: false })).toContain("Checking guest access requests");
    expect(render({ ...status(), requests: undefined })).toContain("unavailable in this gateway");
    expect(render(status({ items: [] }))).toContain("No pending requests");
    const html = render(status({ items: [item({ name: "<script>alert(1)</script>" })] }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
