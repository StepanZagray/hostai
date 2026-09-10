import { expect, test } from "@playwright/test";
import { download, downloadFixture } from "./support/download-fixture";

for (const width of [320, 768, 1024, 1440]) {
  test(`keyboard cancellation retains the model's outcome at ${width}px`, async ({ page }) => {
    const state = await downloadFixture(page, [download()]);
    await page.setViewportSize({ width, height: 1100 });
    await page.goto("/models");
    const cancel = page.getByRole("button", { name: "Cancel download", exact: true });
    await cancel.focus();
    await cancel.press("Enter");
    await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
    const heading = page.getByRole("heading", { name: download().model, exact: true });
    await expect(heading).toBeFocused();
    await expect(heading).toHaveAccessibleDescription("Download cancelled.");
    expect(state.cancels).toEqual([download().id]);
    expect(state.starts).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole("region", { name: "Model downloads", exact: true }).screenshot({
      path: `test-results/download-cancel-focus-${width}.png`,
    });
    await heading.press("Tab");
    await expect(page.getByRole("button", { name: "Retry download", exact: true })).toBeFocused();
  });
}

for (const state of ["completed", "failed"] as const) {
  test(`a ${state} download keeps focus with its model when Cancel disappears`, async ({
    page,
  }) => {
    await page.clock.install();
    const fixture = await downloadFixture(page, [download()]);
    await page.goto("/models");
    await page.getByRole("button", { name: "Cancel download", exact: true }).focus();
    const message = state === "completed" ? "Download completed." : "Transfer interrupted.";
    fixture.jobs = [download({ state, message, error: state === "failed" ? message : null })];
    await page.clock.fastForward(2000);
    const heading = page.getByRole("heading", { name: download().model, exact: true });
    await expect(heading).toBeFocused();
    await expect(heading).toHaveAccessibleDescription(message);
    expect(fixture.starts).toHaveLength(0);
    expect(fixture.cancels).toHaveLength(0);
  });
}

test("progress updates retain Cancel focus and completion never steals focus from the model draft", async ({
  page,
}) => {
  await page.clock.install();
  const fixture = await downloadFixture(page, [download()]);
  await page.goto("/models");
  const cancel = page.getByRole("button", { name: "Cancel download", exact: true });
  await cancel.focus();
  fixture.jobs = [download({ completedBytes: 50_000_000 })];
  await page.clock.fastForward(2000);
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "50000000");
  await expect(cancel).toBeFocused();
  const input = page.getByLabel("Model and tag", { exact: true });
  await input.fill("another-draft:small");
  fixture.jobs = [download({ state: "completed", message: "Download completed." })];
  await page.clock.fastForward(2000);
  await expect(page.getByText("Downloaded", { exact: true })).toBeVisible();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("another-draft:small");
  expect(fixture.starts).toHaveLength(0);
});

test("a held cancellation respects focus moved to a different control before its response", async ({
  page,
}) => {
  const fixture = await downloadFixture(page, [download()]);
  let release!: () => void;
  fixture.waitForCancel = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page.goto("/models");
    const cancel = page.getByRole("button", { name: "Cancel download", exact: true });
    await cancel.focus();
    await cancel.press("Enter");
    await expect(cancel).toBeDisabled();
    const other = page.getByRole("button", { name: "Refresh models", exact: true });
    await other.focus();
    release();
    await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
    await expect(other).toBeFocused();
    expect(fixture.cancels).toEqual([download().id]);
    expect(fixture.starts).toHaveLength(0);
  } finally {
    release?.();
  }
});

test("a missing record and its returning completion retain focus with the same model", async ({
  page,
}) => {
  await page.clock.install();
  const fixture = await downloadFixture(page, [download()]);
  await page.goto("/models");
  await page.getByRole("button", { name: "Cancel download", exact: true }).focus();
  fixture.jobs = [];
  await page.clock.fastForward(2000);
  await expect(
    page.getByRole("heading", {
      name: `Download status unknown for ${download().model}`,
      exact: true,
    }),
  ).toBeFocused();
  fixture.jobs = [download({ state: "completed", message: "Download completed." })];
  for (let tick = 0; tick < 8; tick++) await page.clock.fastForward(2000);
  await expect(page.getByRole("heading", { name: download().model, exact: true })).toBeFocused();
  expect(fixture.starts).toHaveLength(0);
  expect(fixture.cancels).toHaveLength(0);
});

test("evicting a focused terminal record returns to the draft without changing it", async ({
  page,
}) => {
  await page.clock.install();
  const fixture = await downloadFixture(page, [
    download({ state: "failed", error: "Transfer interrupted." }),
  ]);
  await page.goto("/models");
  const input = page.getByLabel("Model and tag", { exact: true });
  await input.fill("retained-entry:small");
  await page.getByRole("button", { name: "Retry download", exact: true }).focus();
  fixture.jobs = [];
  for (let tick = 0; tick < 8; tick++) await page.clock.fastForward(2000);
  await expect(page.getByRole("button", { name: "Retry download", exact: true })).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("retained-entry:small");
  expect(fixture.starts).toHaveLength(0);
});

test("a rejected cancellation leaves keyboard access to the still-running download", async ({
  page,
}) => {
  const fixture = await downloadFixture(page, [download()]);
  let cancels = 0;
  await page.route("**/api/model-downloads/*/cancel", (route) => {
    cancels++;
    return route.fulfill({ status: 503, json: { detail: "Cancellation could not be confirmed." } });
  });
  await page.goto("/models");
  const cancel = page.getByRole("button", { name: "Cancel download", exact: true });
  await cancel.focus();
  await cancel.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Cancellation could not be confirmed.");
  await expect(page.getByRole("heading", { name: download().model, exact: true })).toBeFocused();
  await expect(cancel).toBeEnabled();
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  expect(cancels).toBe(1);
  expect(fixture.starts).toHaveLength(0);
});

test("clicking elsewhere clears focus recovery intent before a background completion", async ({
  page,
}) => {
  await page.clock.install();
  const fixture = await downloadFixture(page, [download()]);
  await page.goto("/models");
  await page.getByRole("button", { name: "Cancel download", exact: true }).focus();
  await page.getByRole("heading", { name: "Your model library", exact: true }).click();
  fixture.jobs = [download({ state: "completed", message: "Download completed." })];
  await page.clock.fastForward(2000);
  await expect(page.getByText("Downloaded", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: download().model, exact: true }),
  ).not.toBeFocused();
  expect(fixture.starts).toHaveLength(0);
  expect(fixture.cancels).toHaveLength(0);
});
