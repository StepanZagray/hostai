import { expect, test, type Page } from "@playwright/test";
import { hostFixture } from "./support/host-fixture";
import type { ModelDownload } from "../src/lib/model-downloads";

const id = "5ed717e7-26ce-4c7d-b2ea-aa03292cb572";
function download(patch: Partial<ModelDownload> = {}): ModelDownload {
  return {
    id,
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
async function fixture(page: Page, initial: ModelDownload[] = []) {
  await hostFixture(page, true, []);
  const state = {
    jobs: initial,
    starts: [] as { requestId: string; model: string }[],
    failRead: false,
    loseStartResponse: false,
  };
  await page.route("**/api/model-downloads", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      state.starts.push(body);
      let job = state.jobs.find((item) => item.id === body.requestId);
      if (!job) {
        job = download({ id: body.requestId, model: body.model });
        state.jobs.unshift(job);
      }
      if (state.loseStartResponse) return route.abort("failed");
      return route.fulfill({ status: 202, json: job });
    }
    return state.failRead
      ? route.fulfill({ status: 503, json: { detail: "Gateway unavailable." } })
      : route.fulfill({ json: { downloads: state.jobs } });
  });
  await page.route("**/api/model-downloads/*/cancel", (route) => {
    const job = state.jobs.find((item) => route.request().url().includes(item.id))!;
    job.state = "cancelled";
    job.message = "Download cancelled.";
    return route.fulfill({ json: job });
  });
  return state;
}

test("download is explicit, persists across navigation, cancels and retries with a new ID", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/models");
  const panel = page.getByRole("region", { name: "Model downloads", exact: true });
  await expect(panel.getByRole("button", { name: "Download model", exact: true })).toBeEnabled();
  expect(state.starts).toHaveLength(0);
  await page.getByLabel("Model and tag", { exact: true }).fill("fixture-model");
  await panel.getByRole("button", { name: "Download model", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Use model:tag");
  expect(state.starts).toHaveLength(0);
  await page.getByLabel("Model and tag", { exact: true }).fill("fixture-model:small");
  await panel.getByRole("button", { name: "Download model", exact: true }).click();
  await expect(panel.getByRole("progressbar")).toHaveAttribute("value", "25000000");
  await expect(panel).toContainText("Current layer abcd12345678");
  await page.screenshot({ path: "test-results/download-progress.png", fullPage: true });
  const first = state.starts[0].requestId;
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page.goto("/models");
  await expect(panel.getByRole("button", { name: "Cancel download", exact: true })).toBeVisible();
  expect(state.starts).toHaveLength(1);
  state.jobs[0] = download({
    id: first,
    digest: "sha256:fedc9876543210",
    completedBytes: null,
    totalBytes: null,
  });
  await expect(panel.getByRole("progressbar")).not.toHaveAttribute("value");
  await expect(panel).toContainText("Current layer fedc98765432");
  await page.setViewportSize({ width: 320, height: 850 });
  await page.screenshot({ path: "test-results/download-unknown-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.getByRole("button", { name: "Cancel download", exact: true }).click();
  await expect(panel).toContainText("Ollama may keep cached layers");
  await panel.getByRole("button", { name: "Retry download", exact: true }).click();
  await expect.poll(() => state.starts.length).toBe(2);
  expect(state.starts[1].requestId).not.toBe(first);
  await expect(panel.getByRole("button", { name: "Cancel download", exact: true })).toBeVisible();
});

test("completion refreshes the library and lets the user explicitly select the downloaded model", async ({
  page,
}) => {
  const state = await fixture(page, [download()]);
  await page.goto("/models");
  await expect(page.getByRole("progressbar")).toBeVisible();
  await page.route("**/api/models", (route) =>
    route.fulfill({
      json: {
        connected: true,
        models: [
          {
            name: "fixture-model:small",
            sizeBytes: 100000000,
            parameterSize: "",
            quantization: "",
            modifiedAt: "",
            chatUnavailableReason: null,
          },
        ],
      },
    }),
  );
  state.jobs[0] = download({
    state: "completed",
    phase: "finalizing",
    message: "Model downloaded.",
  });
  await expect(page.getByRole("link", { name: "Try downloaded model", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/download-ready.png", fullPage: true });
  await page.getByRole("link", { name: "Try downloaded model", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveValue(
    "fixture-model:small",
  );
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeEditable();
});

test("lost start response reuses its ID while uncertain and recovers the existing job", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/models");
  const button = page.getByRole("button", { name: "Download model", exact: true });
  await expect(button).toBeEnabled();
  state.loseStartResponse = true;
  // An empty list models a temporarily stale read; the accepted job remains on the fixture server.
  let hideJobs = true;
  await page.route("**/api/model-downloads", (route) =>
    route.request().method() === "GET" && hideJobs
      ? route.fulfill({ json: { downloads: [] } })
      : route.fallback(),
  );
  await page.getByLabel("Model and tag", { exact: true }).fill("fixture-model:small");
  await button.click();
  await expect(page.getByRole("alert")).toContainText("start could not be confirmed");
  await expect(page.getByLabel("Choose a starter model", { exact: true })).toBeDisabled();
  state.loseStartResponse = false;
  await page.getByRole("button", { name: "Retry start request", exact: true }).click();
  expect(state.starts).toHaveLength(2);
  expect(state.starts[1]).toEqual(state.starts[0]);
  expect(state.jobs).toHaveLength(1);
  hideJobs = false;
  await expect(page.getByRole("button", { name: "Cancel download", exact: true })).toBeVisible();
});

test("unavailable status preserves saved progress and cancellation remains usable", async ({
  page,
}) => {
  const state = await fixture(page, [download()]);
  await page.goto("/models");
  await expect(page.getByRole("progressbar")).toBeVisible();
  state.failRead = true;
  await expect(page.getByRole("alert")).toContainText("Saved progress may be out of date");
  await expect(page.getByRole("progressbar")).toBeVisible();
  await page.getByRole("button", { name: "Cancel download", exact: true }).click();
  await expect(page.getByText("This request stopped.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download model", exact: true })).toBeDisabled();
  state.failRead = false;
  await page.getByRole("button", { name: "Check download status", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download model", exact: true })).toBeEnabled();
});

test("cancelled state cannot be restored by an earlier in-flight status response", async ({
  page,
}) => {
  const state = await fixture(page, [download()]);
  await page.goto("/models");
  await expect(page.getByRole("progressbar")).toBeVisible();
  let release: (() => void) | undefined;
  await page.route("**/api/model-downloads", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const stale = structuredClone(state.jobs);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ json: { downloads: stale } }).catch(() => {});
  });
  await expect.poll(() => !!release).toBe(true);
  await page.getByRole("button", { name: "Cancel download", exact: true }).click();
  await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
  release!();
  await expect(page.getByRole("button", { name: "Cancel download", exact: true })).toHaveCount(0);
  await expect(page.getByRole("progressbar")).toHaveCount(0);
});

test("a rejected start restores editable input and an uncertain start can be dismissed explicitly", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/models");
  const input = page.getByLabel("Model and tag", { exact: true });
  await input.fill("fixture-model:small");
  let reject = true;
  await page.route("**/api/model-downloads", (route) =>
    route.request().method() === "POST" && reject
      ? route.fulfill({
          status: 409,
          json: { detail: "Another model download is already running." },
        })
      : route.fallback(),
  );
  await page.getByRole("button", { name: "Download model", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Another model download");
  await expect(input).toBeEditable();
  await expect(page.getByRole("button", { name: "Retry start request", exact: true })).toHaveCount(
    0,
  );
  reject = false;
  state.loseStartResponse = true;
  await page.route("**/api/model-downloads", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { downloads: [] } })
      : route.fallback(),
  );
  await page.getByRole("button", { name: "Download model", exact: true }).click();
  await expect(input).toBeDisabled();
  await page.screenshot({ path: "test-results/download-uncertain.png", fullPage: true });
  await page.getByRole("button", { name: "Use a different model", exact: true }).click();
  await expect(input).toBeEditable();
  expect(state.starts).toHaveLength(1);
});

test("malformed status stays actionable without exposing a raw parser exception", async ({
  page,
}) => {
  await fixture(page);
  await page.route("**/api/model-downloads", (route) =>
    route.fulfill({ body: "<html>not JSON</html>", contentType: "text/html" }),
  );
  await page.goto("/models");
  await expect(page.getByRole("alert")).toContainText("Download status could not be read");
  await expect(page.getByRole("alert")).not.toContainText("Unexpected token");
  await page.screenshot({ path: "test-results/download-status-error.png", fullPage: true });
  await expect(
    page.getByRole("button", { name: "Check download status", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("button", { name: "Download model", exact: true })).toBeDisabled();
});

test("starter selection reviews size and source before an explicit download and same-model handoff", async ({
  page,
}) => {
  const state = await fixture(page);
  let chats = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/chat")) chats++;
  });
  await page.goto("/models");
  const chooser = page.getByLabel("Choose a starter model", { exact: true });
  const input = page.getByLabel("Model and tag", { exact: true });
  await page.getByRole("link", { name: "Choose a starter", exact: true }).click();
  await expect(chooser).toBeFocused();
  await chooser.selectOption("gemma3:1b");
  await expect(input).toHaveValue("gemma3:1b");
  await expect(page.getByText(/Listed model size: approximately 815 MB/)).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Model details and terms on Ollama" }),
  ).toHaveAttribute("href", "https://ollama.com/library/gemma3:1b");
  expect(state.starts).toHaveLength(0);
  await input.fill("custom-model:small");
  await expect(chooser).toHaveValue("");
  await expect(page.getByText(/Download size is unknown for custom tags/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Model details and terms on Ollama" })).toHaveCount(
    0,
  );
  await chooser.selectOption("qwen2.5:0.5b");
  await expect(input).toHaveValue("qwen2.5:0.5b");
  expect(state.starts).toHaveLength(0);
  await page.getByRole("button", { name: "Download model", exact: true }).click();
  await expect(page.getByRole("progressbar")).toBeVisible();
  expect(state.starts).toHaveLength(1);
  expect(state.starts[0].model).toBe("qwen2.5:0.5b");
  await page.route("**/api/models", (route) =>
    route.fulfill({
      json: {
        connected: true,
        models: [{ name: "qwen2.5:0.5b", sizeBytes: 398000000, chatUnavailableReason: null }],
      },
    }),
  );
  state.jobs[0] = { ...state.jobs[0], state: "completed", message: "Download completed." };
  await page.getByRole("link", { name: "Try downloaded model", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveValue(
    "qwen2.5:0.5b",
  );
  expect(chats).toBe(0);
  expect(state.starts).toHaveLength(1);
});

test("an installed starter goes straight to Playground without downloading again", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.route("**/api/models", (route) =>
    route.fulfill({
      json: {
        connected: true,
        models: [{ name: "gemma3:1b", sizeBytes: 815000000, chatUnavailableReason: null }],
      },
    }),
  );
  await page.goto("/models");
  await page.getByLabel("Choose a starter model", { exact: true }).selectOption("gemma3:1b");
  await expect(page.getByRole("button", { name: "Download again", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/model-choice-installed.png", fullPage: true });
  await page.getByRole("link", { name: "Try installed model", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveValue("gemma3:1b");
  expect(state.starts).toHaveLength(0);
});

for (const width of [320, 768, 1440]) {
  test(`starter details remain readable and keyboard accessible at ${width}px`, async ({
    page,
  }) => {
    const state = await fixture(page);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/models");
    const chooser = page.getByLabel("Choose a starter model", { exact: true });
    await chooser.focus();
    await page.keyboard.press("ArrowDown");
    await expect(chooser).toHaveValue("qwen2.5:0.5b");
    await expect(chooser).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Model and tag", { exact: true })).toBeFocused();
    await expect(page.getByText(/File size is not RAM or VRAM/)).toBeVisible();
    expect(state.starts).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `test-results/model-choice-${width}.png`, fullPage: true });
  });
}

test("starter information remains available while the runtime is offline", async ({ page }) => {
  await hostFixture(page, false);
  let starts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST") starts++;
  });
  await page.goto("/models");
  const chooser = page.getByLabel("Choose a starter model", { exact: true });
  await expect(chooser).toBeEnabled();
  await chooser.selectOption("gemma3:1b");
  await expect(page.getByLabel("Model and tag", { exact: true })).toHaveValue("gemma3:1b");
  const start = page.getByRole("button", { name: "Download model", exact: true });
  await expect(start).toBeDisabled();
  await expect(start).toHaveAttribute("aria-describedby", /download-offline/);
  await expect(page.getByRole("link", { name: "Open setup", exact: true })).toBeVisible();
  expect(starts).toBe(0);
});

test("an installed starter requires actual chat admission before offering Try", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.route("**/api/models", (route) =>
    route.fulfill({
      json: {
        connected: true,
        models: [
          {
            name: "gemma3:1b",
            sizeBytes: 815000000,
            chatUnavailableReason: "This installed tag cannot chat.",
          },
        ],
      },
    }),
  );
  await page.goto("/models");
  await page.getByLabel("Choose a starter model", { exact: true }).selectOption("gemma3:1b");
  const panel = page.getByRole("region", { name: "Model downloads", exact: true });
  await expect(panel.getByText("This installed tag cannot chat.", { exact: true })).toBeVisible();
  await expect(panel.getByRole("link", { name: "Try installed model", exact: true })).toHaveCount(
    0,
  );
  expect(state.starts).toHaveLength(0);
});
