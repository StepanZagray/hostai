import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { readHostSnapshot } from "./host-refresh";

const status = { status: "online", ollamaConnected: true };
const models = [{ name: "test-model:small" }];
const requests = [{ id: "test-request", status: "completed" }];
function fixture(failed: string[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      if (failed.includes(path)) return Response.json({ detail: "Unavailable" }, { status: 503 });
      return Response.json(
        path === "/api/status"
          ? status
          : path === "/api/models"
            ? { models, connected: true }
            : { requests },
      );
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());

describe("independent host refresh", () => {
  it.each([
    [],
    ["status"],
    ["models"],
    ["requests"],
    ["status", "models"],
    ["status", "requests"],
    ["models", "requests"],
    ["status", "models", "requests"],
  ])("keeps successful endpoints when these fail: %j", async (...args) => {
    const failed = args as string[];
    fixture(failed.map((name) => `/api/${name}`));
    const snapshot = await readHostSnapshot(new AbortController().signal);
    expect(snapshot.status).toEqual(failed.includes("status") ? null : status);
    expect(snapshot.models).toEqual(failed.includes("models") ? [] : models);
    expect(snapshot.requests).toEqual(failed.includes("requests") ? [] : requests);
    for (const name of ["status", "models", "requests"] as const)
      expect(snapshot.errors[name] !== null).toBe(failed.includes(name));
  });
  it("distinguishes failed discovery from an available runtime with no installed models", async () => {
    fixture();
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockResolvedValueOnce(Response.json(status));
    fetch.mockResolvedValueOnce(Response.json({ models: [], connected: false }));
    const failed = await readHostSnapshot(new AbortController().signal);
    expect(failed.status).toEqual(status);
    expect(failed.errors.models).toContain("Model discovery is unavailable");
    fetch.mockResolvedValueOnce(Response.json(status));
    fetch.mockResolvedValueOnce(Response.json({ models: [], connected: true }));
    const empty = await readHostSnapshot(new AbortController().signal);
    expect(empty.models).toEqual([]);
    expect(empty.errors.models).toBeNull();
  });
  it("discards an aborted snapshot even when fetch ignores cancellation", async () => {
    fixture();
    const abort = new AbortController();
    const snapshot = readHostSnapshot(abort.signal);
    abort.abort();
    await expect(snapshot).rejects.toMatchObject({ name: "AbortError" });
  });
  it("recovers failed endpoints on the next successful refresh", async () => {
    fixture(["/api/requests"]);
    expect((await readHostSnapshot(new AbortController().signal)).errors.requests).not.toBeNull();
    fixture();
    const recovered = await readHostSnapshot(new AbortController().signal);
    expect(recovered.requests).toEqual(requests);
    expect(recovered.errors).toEqual({ status: null, models: null, requests: null });
  });
  it("treats null endpoint payloads as unavailable instead of throwing during refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(null)),
    );
    const snapshot = await readHostSnapshot(new AbortController().signal);
    expect(snapshot.status).toBeNull();
    expect(snapshot.models).toEqual([]);
    expect(snapshot.requests).toEqual([]);
    expect(Object.values(snapshot.errors).every(Boolean)).toBe(true);
  });
});
