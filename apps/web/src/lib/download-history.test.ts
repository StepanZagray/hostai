import { expect, it } from "vite-plus/test";
import { mergeDownload, reconcileDownloads, type DownloadHistory } from "./download-history";
import type { ModelDownload } from "./model-downloads";

const job = (id: string, state: ModelDownload["state"] = "running"): ModelDownload => ({
  id,
  state,
  model: "fixture-model:small",
  phase: "starting",
  message: "Starting download.",
  digest: null,
  completedBytes: null,
  totalBytes: null,
  createdAt: "2026-09-10T00:00:00Z",
  updatedAt: "2026-09-10T00:00:00Z",
  error: null,
});
const empty = (): DownloadHistory => ({ downloads: [], unreported: [] });

it("bounds mutation history while retaining unknown outcomes separately", () => {
  const old = Array.from({ length: 20 }, (_, i) => job(String(i), "completed"));
  const missing = job("missing");
  const next = mergeDownload({ downloads: old, unreported: [missing] }, job("new"));
  expect(next.downloads).toHaveLength(20);
  expect(next.downloads[0].id).toBe("new");
  expect(next.unreported).toEqual([missing]);
});

it("keeps an absent running job as unreported without inventing a terminal outcome", () => {
  const running = job("a");
  const next = reconcileDownloads({ downloads: [running], unreported: [] }, []);
  expect(next).toEqual({ downloads: [], unreported: [running] });
  expect(reconcileDownloads(next, [])).toEqual(next);
  expect(running.state).toBe("running");
});
it.each(["completed", "failed", "cancelled"] as const)(
  "does not retain evicted %s history",
  (state) => {
    expect(reconcileDownloads({ downloads: [job("a", state)], unreported: [] }, [])).toEqual(
      empty(),
    );
  },
);
it("does not infer a lost download from an initially empty list", () => {
  expect(reconcileDownloads(empty(), [])).toEqual(empty());
});
it("reconciles returning IDs without matching unrelated jobs by model name", () => {
  const missing = { downloads: [], unreported: [job("a")] };
  expect(reconcileDownloads(missing, [job("b")]).unreported).toEqual([job("a")]);
  expect(reconcileDownloads(missing, [job("a", "completed")])).toEqual({
    downloads: [job("a", "completed")],
    unreported: [],
  });
});
it("accepts a cancellation response for an unreported job without reviving stale progress", () => {
  const running = job("b");
  const next = mergeDownload(
    { downloads: [running], unreported: [job("a")] },
    job("a", "cancelled"),
  );
  expect(next).toEqual({ downloads: [job("a", "cancelled"), running], unreported: [] });
  expect(reconcileDownloads(next, []).unreported).toEqual([running]);
});
it("bounds retained unknown outcomes separately from the current gateway history", () => {
  const old = Array.from({ length: 20 }, (_, i) => job(String(i)));
  const next = reconcileDownloads({ downloads: [job("new")], unreported: old }, [job("current")]);
  expect(next.unreported).toHaveLength(20);
  expect(next.unreported[0].id).toBe("new");
  expect(next.downloads).toEqual([job("current")]);
});
