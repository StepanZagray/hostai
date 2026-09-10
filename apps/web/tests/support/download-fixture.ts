import type { Page } from "@playwright/test";
import { hostFixture } from "./host-fixture";
import type { ModelDownload } from "../../src/lib/model-downloads";

export const downloadId = "5ed717e7-26ce-4c7d-b2ea-aa03292cb572";
export function download(patch: Partial<ModelDownload> = {}): ModelDownload {
  return {
    id: downloadId,
    model: "fixture-model:small",
    state: "running",
    phase: "downloading",
    message: "Downloading model layer.",
    digest: "sha256:abcd1234567890",
    completedBytes: 25_000_000,
    totalBytes: 100_000_000,
    createdAt: "2026-09-09T19:00:00Z",
    updatedAt: "2026-09-09T19:00:00Z",
    error: null,
    ...patch,
  };
}
export async function downloadFixture(page: Page, initial: ModelDownload[] = []) {
  await hostFixture(page, true, []);
  const state = {
    jobs: initial,
    starts: [] as { requestId: string; model: string }[],
    failRead: false,
    loseStartResponse: false,
    modelChecks: 0,
    reads: 0,
    waitForStart: null as Promise<void> | null,
    waitForCancel: null as Promise<void> | null,
    cancels: [] as string[],
  };
  await page.route("**/api/models", (route) => {
    state.modelChecks++;
    return route.fallback();
  });
  await page.route("**/api/model-downloads", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      state.starts.push(body);
      let job = state.jobs.find((item) => item.id === body.requestId);
      if (!job) {
        job = download({ id: body.requestId, model: body.model });
        state.jobs.unshift(job);
      }
      if (state.waitForStart) await state.waitForStart;
      if (state.loseStartResponse) return route.abort("failed");
      return route.fulfill({ status: 202, json: job });
    }
    state.reads++;
    return state.failRead
      ? route.fulfill({ status: 503, json: { detail: "Gateway unavailable." } })
      : route.fulfill({ json: { downloads: state.jobs } });
  });
  await page.route("**/api/model-downloads/*/cancel", async (route) => {
    const job = state.jobs.find((item) => route.request().url().includes(item.id))!;
    state.cancels.push(job.id);
    job.state = "cancelled";
    job.message = "Download cancelled.";
    if (state.waitForCancel) await state.waitForCancel;
    return route.fulfill({ json: job });
  });
  return state;
}
