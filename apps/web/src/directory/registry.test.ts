import { afterEach, expect, it, vi } from "vite-plus/test";
import { fresh, guestAddress, parseDirectory, readDirectory } from "./registry";
const now = 1_800_000_000_000;
const listing = () => ({
  id: "a".repeat(64),
  hostLabel: "A chosen host name",
  model: "fixture-model:small",
  guestUrl: "https://fixture-host.trycloudflare.com/",
  updatedAt: now,
  expiresAt: now + 90000,
  invitationRequired: true,
});
const snapshot = () => ({ version: 1, servedAt: now, listings: [listing()] });
afterEach(() => vi.unstubAllGlobals());

it("uses directory time and elapsed time even when the browser clock disagrees", () => {
  const value = parseDirectory(snapshot())!;
  expect(fresh(value.listings[0], value, 89999)).toBe(true);
  expect(fresh(value.listings[0], value, 90000)).toBe(false);
  expect(fresh(value.listings[0], value, -10)).toBe(true);
});
it.each([
  "http://fixture-host.trycloudflare.com/",
  "https://fixture-host.trycloudflare.com:443/",
  "https://fixture-host.trycloudflare.com/#access=secret",
  "https://fixture-host.trycloudflare.com/?key=secret",
  "https://user@fixture-host.trycloudflare.com/",
  "https://fixture-host.trycloudflare.com/api/sharing",
  "https://fixture-host.trycloudflare.com.attacker.example/",
  "https://127.0.0.1/",
  "https://fixture-host.trycloudflare.com",
])("rejects unsafe or noncanonical guest address %s", (url) => {
  expect(guestAddress(url)).toBeNull();
  expect(parseDirectory({ ...snapshot(), listings: [{ ...listing(), guestUrl: url }] })).toBeNull();
});
it("rejects incompatible schemas, duplicate identities and impossible freshness", () => {
  for (const value of [
    null,
    {},
    { ...snapshot(), version: 2 },
    { ...snapshot(), servedAt: NaN },
    { ...snapshot(), listings: [listing(), listing()] },
    { ...snapshot(), listings: Array(101).fill(listing()) },
    ...[
      { id: "bad" },
      { hostLabel: "Host\nName" },
      { hostLabel: " " },
      { model: "" },
      { invitationRequired: false },
      { updatedAt: now + 1 },
      { expiresAt: now + 90001 },
      { expiresAt: "tomorrow" },
    ].map((patch) => ({ ...snapshot(), listings: [{ ...listing(), ...patch }] })),
  ])
    expect(parseDirectory(value)).toBeNull();
});
it("copies only public listing fields and preserves expired records for explicit inspection", () => {
  const value = parseDirectory({
    ...snapshot(),
    servedAt: now + 95000,
    listings: [{ ...listing(), unexpected: "ignored" }],
  })!;
  expect(value.listings[0]).toEqual(listing());
  expect(fresh(value.listings[0], value, 0)).toBe(false);
  expect(parseDirectory({ ...snapshot(), listings: [] })).toEqual({ servedAt: now, listings: [] });
});
it("reads only the directory endpoint without credentials or redirects", async () => {
  const fetch = vi.fn(async () => Response.json(snapshot()));
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  expect(await readDirectory(signal, "/registry/v1/listings")).toEqual(parseDirectory(snapshot()));
  expect(fetch).toHaveBeenCalledWith(
    "/registry/v1/listings",
    expect.objectContaining({ signal, cache: "no-store", credentials: "omit", redirect: "error" }),
  );
});
it("bounds directory responses and cancels an oversized body", async () => {
  const cancel = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(131073));
            },
            cancel,
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    ),
  );
  await expect(
    readDirectory(new AbortController().signal, "/api/directory/listings"),
  ).rejects.toThrow();
  expect(cancel).toHaveBeenCalledOnce();
});
it.each([
  () => new Response("provider detail", { status: 503 }),
  () => new Response("{}", { headers: { "Content-Type": "text/html" } }),
  () => Response.json({ version: 2 }),
  () => new Response(new Uint8Array([255]), { headers: { "Content-Type": "application/json" } }),
])("rejects failed or malformed directory replies", async (create) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => create()),
  );
  await expect(
    readDirectory(new AbortController().signal, "/registry/v1/listings"),
  ).rejects.toThrow();
});
