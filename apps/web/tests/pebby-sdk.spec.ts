import { expect, test } from "@playwright/test";

test("installed Pebby SDK renders its real UI and runs environment actions through the bridge", async ({
  page,
}) => {
  test.skip(process.env.HOSTAI_PEBBY !== "sdk", "Requires test-provider-sdk.py --ui-test");
  const errors: string[] = [];
  const operations: unknown[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().endsWith("/api/infer") && request.method() === "POST") {
      operations.push(request.postDataJSON().input);
    }
  });
  await page.goto("/playground");
  await expect(page.getByText("Runtime connected", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Model" })).toHaveValue("pebby:latest");
  await expect(page.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
  const frame = page.frameLocator("iframe");
  await expect(frame.getByRole("heading", { name: "Pebby", exact: true })).toBeVisible();
  await expect(frame.locator("#transport")).toHaveText("HostAI bridge");
  await expect(frame.locator("#source-fields")).toBeEnabled();
  await frame.getByLabel("Shipped", { exact: true }).selectOption("0");
  await frame.getByRole("button", { name: "Load shipped level" }).click();
  await expect(frame.locator("#action-count")).toHaveText("0 actions");
  await frame.getByRole("button", { name: "Right", exact: true }).click();
  await expect(frame.locator("#action-count")).toHaveText("1 action");
  await expect(frame.locator("#source-error")).toBeHidden();
  await page.screenshot({ path: "test-results/pebby-sdk-playground.png", fullPage: true });
  await frame.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(frame.locator("#action-count")).toHaveText("0 actions");
  expect(operations).toContainEqual({ op: "info" });
  expect(operations).toContainEqual({ op: "shipped", index: 0 });
  expect(operations).toContainEqual({ op: "play", level: { shipped: 0 }, actions: [4] });
  await page.goto("/models");
  await expect(page.getByText(/No weight size reported/)).toBeVisible();
  await page.screenshot({ path: "test-results/pebby-sdk-models.png", fullPage: true });
  expect(errors).toEqual([]);
});
