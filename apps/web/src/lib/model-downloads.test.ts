import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  cancelDownload,
  downloadModelError,
  listDownloads,
  startDownload,
} from "./model-downloads";
const id = "5ed717e7-26ce-4c7d-b2ea-aa03292cb572";
const job = {
  id,
  model: "qwen3:0.6b",
  state: "running",
  phase: "downloading",
  message: "Downloading layer",
  digest: "sha256:abc",
  completedBytes: null,
  totalBytes: 500,
  createdAt: "2026-09-09T19:00:00Z",
  updatedAt: "2026-09-09T19:00:00Z",
  error: null,
};
afterEach(() => vi.unstubAllGlobals());
it.each(["qwen3:0.6b", "library/qwen3:0.6b", "user/model.name:q4_k_m"])(
  "accepts explicit library reference %s",
  (model) => expect(downloadModelError(model)).toBeNull(),
);
it.each([
  "",
  "qwen3",
  "https://example.com/model:tag",
  "example.com/model:tag",
  "../model:tag",
  "model:cloud",
  "model:tag-CLOUD",
  "a/b/c:tag",
  "a".repeat(129) + ":tag",
])("rejects non-local or ambiguous reference %s", (model) =>
  expect(downloadModelError(model)).not.toBeNull(),
);
it("accepts unknown current-layer counts without inventing progress", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ downloads: [job] })));
  expect(await listDownloads(new AbortController().signal)).toEqual([job]);
});
it.each([
  { completedBytes: -1 },
  { completedBytes: 501 },
  { totalBytes: undefined },
  { state: "queued" },
])("rejects invalid job state %j", async (patch) => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ downloads: [{ ...job, ...patch }] })),
  );
  await expect(listDownloads(new AbortController().signal)).rejects.toThrow("could not be read");
});
it("preserves a start request ID and explicitly cancels its matching job", async () => {
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json(job)));
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  await startDownload({ requestId: id, model: job.model }, signal);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ requestId: id, model: job.model });
  await cancelDownload(id, signal);
  expect(fetch.mock.calls[1][0]).toBe(`/api/model-downloads/${id}/cancel`);
  expect(fetch.mock.calls[1][1].method).toBe("POST");
});
it("does not confuse an expired job with missing gateway support", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(Response.json({ detail: "Download job not found." }, { status: 404 })),
  );
  await expect(cancelDownload(id, new AbortController().signal)).rejects.toThrow(
    "Download job not found",
  );
});
