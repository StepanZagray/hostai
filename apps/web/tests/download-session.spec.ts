import { expect, test, type Page } from "@playwright/test";
import { download, downloadFixture } from "./support/download-fixture";

async function navigate(page: Page, name: string) {
  const link = page
    .getByRole("navigation", { name: "Main navigation", exact: true })
    .getByRole("link", { name, exact: true });
  if (!(await link.isVisible()))
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await link.click();
}

function trackWrites(page: Page) {
  const writes: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path.startsWith("/api/")) writes.push(path);
  });
  return writes;
}

for (const width of [320, 1440]) {
  test(`model drafts survive internal navigation at ${width}px and remain local to the tab`, async ({
    page,
    context,
  }) => {
    const state = await downloadFixture(page);
    const writes = trackWrites(page);
    await page.setViewportSize({ width, height: 1100 });
    await page.goto("/models");
    await page.evaluate(() => Reflect.set(window, "downloadNavigationMarker", "same document"));
    const input = page.getByLabel("Model and tag", { exact: true });
    const chooser = page.getByLabel("Choose a starter model", { exact: true });
    await chooser.selectOption("gemma3:1b");
    await navigate(page, "Connection");
    await navigate(page, "Models");
    await expect(input).toHaveValue("gemma3:1b");
    await expect(chooser).toHaveValue("gemma3:1b");
    await expect(input).toBeEditable();
    await input.fill("draft-only:small");
    await navigate(page, "Playground");
    await navigate(page, "Models");
    await expect(input).toHaveValue("draft-only:small");
    expect(await page.evaluate(() => Reflect.get(window, "downloadNavigationMarker"))).toBe(
      "same document",
    );
    expect(
      await page.evaluate(() =>
        [...Object.values(localStorage), ...Object.values(sessionStorage)].join(" "),
      ),
    ).not.toContain("draft-only:small");
    expect(page.url()).not.toContain("draft-only");
    await page.screenshot({
      path: `test-results/download-session-draft-${width}.png`,
      animations: "disabled",
    });
    const other = await context.newPage();
    try {
      const otherState = await downloadFixture(other);
      await other.goto("/models");
      await expect(other.getByLabel("Model and tag", { exact: true })).toHaveValue("");
      expect(otherState.starts).toHaveLength(0);
    } finally {
      await other.close();
    }
    await input.fill("");
    await navigate(page, "Connection");
    await navigate(page, "Models");
    await expect(input).toHaveValue("");
    await input.fill("cleared-by-reload:small");
    await page.reload();
    await expect(input).toHaveValue("");
    expect(state.starts).toHaveLength(0);
    expect(writes).toEqual([]);
  });
}

test("download checks start only after opening Models and keep one polling loop through navigation", async ({
  page,
}) => {
  await page.clock.install();
  const state = await downloadFixture(page);
  await page.goto("/connection");
  for (let tick = 0; tick < 10; tick++) await page.clock.fastForward(2000);
  expect(state.reads).toBe(0);
  expect(state.starts).toHaveLength(0);
  await navigate(page, "Models");
  await expect(page.getByRole("button", { name: "Download model", exact: true })).toBeEnabled();
  expect(state.reads).toBe(1);
  await navigate(page, "Connection");
  for (let tick = 0; tick < 8; tick++) await page.clock.fastForward(2000);
  await expect.poll(() => state.reads).toBe(2);
  await navigate(page, "Models");
  await expect.poll(() => state.reads).toBe(3);
  await page.clock.fastForward(2000);
  expect(state.reads).toBe(3);
  for (let tick = 0; tick < 7; tick++) await page.clock.fastForward(2000);
  await expect.poll(() => state.reads).toBe(4);
});

for (const operation of ["start", "cancel"] as const) {
  test(`pending ${operation} survives navigation without aborting or duplicating the action`, async ({
    page,
  }) => {
    await page.clock.install();
    const state = await downloadFixture(page, operation === "cancel" ? [download()] : []);
    const writes = trackWrites(page);
    const aborted: string[] = [];
    page.on("requestfailed", (request) => {
      if (request.method() === "POST" && request.url().includes("/api/model-downloads"))
        aborted.push(request.url());
    });
    let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (operation === "start") state.waitForStart = wait;
    else state.waitForCancel = wait;
    try {
      await page.goto("/models");
      if (operation === "start") {
        await page.getByLabel("Model and tag", { exact: true }).fill(download().model);
        await page.getByRole("button", { name: "Download model", exact: true }).click();
        await expect.poll(() => state.starts.length).toBe(1);
      } else {
        await page.getByRole("button", { name: "Cancel download", exact: true }).click();
        await expect.poll(() => state.cancels.length).toBe(1);
      }
      // Keep GETs at the pre-mutation state: the held response must apply the change.
      state.jobs = operation === "start" ? [] : [download()];
      await navigate(page, "Connection");
      await navigate(page, "Models");
      await expect(page.getByRole("button", { name: "Working…", exact: true })).toBeDisabled();
      expect(aborted).toEqual([]);
      release!();
      await expect(page.getByRole("button", { name: "Working…", exact: true })).toHaveCount(0);
      if (operation === "start") await expect(page.getByRole("progressbar")).toBeVisible();
      else await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
      expect(aborted).toEqual([]);
      expect(writes).toEqual([
        operation === "start"
          ? "/api/model-downloads"
          : `/api/model-downloads/${download().id}/cancel`,
      ]);
    } finally {
      release?.();
    }
  });
}

test("an unconfirmed start retains its exact request through navigation and retry", async ({
  page,
}) => {
  await page.clock.install();
  const state = await downloadFixture(page);
  state.loseStartResponse = true;
  let hideJobs = true;
  await page.route("**/api/model-downloads", (route) =>
    route.request().method() === "GET" && hideJobs
      ? route.fulfill({ json: { downloads: [] } })
      : route.fallback(),
  );
  await page.goto("/models");
  await page.getByLabel("Model and tag", { exact: true }).fill(download().model);
  await page.getByRole("button", { name: "Download model", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry start request", exact: true }),
  ).toBeVisible();
  await navigate(page, "Playground");
  await navigate(page, "Models");
  await expect(page.getByLabel("Model and tag", { exact: true })).toHaveValue(download().model);
  await expect(page.getByLabel("Model and tag", { exact: true })).toBeDisabled();
  state.loseStartResponse = false;
  await page.getByRole("button", { name: "Retry start request", exact: true }).click();
  await expect(page.getByRole("progressbar")).toBeVisible();
  expect(state.starts).toHaveLength(2);
  expect(state.starts[1]).toEqual(state.starts[0]);
  expect(state.jobs).toHaveLength(1);
  hideJobs = false;
  await page.reload();
  await expect(page.getByLabel("Model and tag", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Retry start request", exact: true })).toHaveCount(
    0,
  );
  expect(state.starts).toHaveLength(2);
});

test("unknown outcomes detected away from Models remain available without stealing focus on return", async ({
  page,
}) => {
  await page.clock.install();
  const state = await downloadFixture(page, [download()]);
  await page.goto("/models");
  await expect(page.getByRole("progressbar")).toBeVisible();
  await navigate(page, "Connection");
  state.jobs = [];
  const before = state.reads;
  await page.clock.fastForward(2000);
  await expect.poll(() => state.reads).toBe(before + 1);
  await navigate(page, "Models");
  await expect(page.getByText("Status unknown", { exact: true })).toHaveCount(1);
  await expect(
    page.getByRole("heading", {
      name: `Download status unknown for ${download().model}`,
      exact: true,
    }),
  ).not.toBeFocused();
  await navigate(page, "Connection");
  await navigate(page, "Models");
  await expect(page.getByText("Status unknown", { exact: true })).toHaveCount(1);
  await page
    .getByRole("button", { name: `Dismiss notice for ${download().model}`, exact: true })
    .click();
  await navigate(page, "Connection");
  await navigate(page, "Models");
  await expect(page.getByText("Status unknown", { exact: true })).toHaveCount(0);
  expect(state.starts).toHaveLength(0);
  expect(state.cancels).toHaveLength(0);
});

test("returning to Models does not repeat a completed job's library refresh", async ({ page }) => {
  await page.clock.install();
  const completed = download({ state: "completed", message: "Download completed." });
  const state = await downloadFixture(page, [completed]);
  await page.goto("/models");
  await expect(page.getByText("Downloaded", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh models", exact: true })).toBeEnabled();
  await expect.poll(() => state.modelChecks).toBe(2);
  const checks = state.modelChecks;
  await navigate(page, "Connection");
  await navigate(page, "Models");
  await expect(page.getByRole("button", { name: "Download model", exact: true })).toBeEnabled();
  expect(state.modelChecks).toBe(checks);
  state.jobs = [];
  await navigate(page, "Connection");
  await navigate(page, "Models");
  await expect(page.getByText("Downloaded", { exact: true })).toHaveCount(0);
  state.jobs = [completed];
  await navigate(page, "Connection");
  await navigate(page, "Models");
  await expect.poll(() => state.modelChecks).toBe(checks + 1);
});

test("reload drops an active uncertain start and unknown notices without restarting or cancelling work", async ({
  page,
}) => {
  await page.clock.install();
  const state = await downloadFixture(page, [download()]);
  await page.goto("/models");
  await expect(page.getByRole("progressbar")).toBeVisible();
  state.jobs = [];
  await page.clock.fastForward(2000);
  await expect(page.getByText("Status unknown", { exact: true })).toBeVisible();
  await page.route("**/api/model-downloads", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { downloads: [] } })
      : route.fallback(),
  );
  state.loseStartResponse = true;
  await page.getByLabel("Model and tag", { exact: true }).fill("another-model:small");
  await page.getByRole("button", { name: "Download model", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry start request", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Status unknown", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Download model", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Model and tag", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Retry start request", exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText("Status unknown", { exact: true })).toHaveCount(0);
  expect(state.starts).toHaveLength(1);
  expect(state.jobs).toHaveLength(1);
  expect(state.cancels).toHaveLength(0);
});
