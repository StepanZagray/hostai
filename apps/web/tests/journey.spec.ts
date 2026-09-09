import { expect, test } from "@playwright/test";
import { hostFixture } from "./support/host-fixture";

test("ready setup leads to a model without starting another workspace", async ({
  page,
  baseURL,
}) => {
  await hostFixture(page);
  await page.goto("/connection");
  await expect(page.getByRole("link", { name: "Try a local model", exact: true })).toBeVisible();
  const setup = page.getByRole("region", { name: "Get your host ready", exact: true });
  await expect(setup).toContainText("Your gateway is already running");
  await expect(setup).toContainText("Ollama is already connected");
  await expect(setup).not.toContainText("pnpm desktop:dev");
  await expect(setup).not.toContainText("pnpm backend:dev");
  await expect(page.getByText(baseURL!, { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/setup-ready-journey.png", fullPage: true });
  await page.getByRole("link", { name: "Try a local model", exact: true }).click();
  await page.getByRole("link", { name: "Try in playground", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveValue(
    "fixture-model:small",
  );
});

test("setup recovers from a missing runtime through an empty library to chat", async ({ page }) => {
  await hostFixture(page, false);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/connection");
  const setup = page.getByRole("region", { name: "Get your host ready", exact: true });
  await expect(setup).toContainText("ollama serve");
  await expect(page.getByRole("link", { name: "Try a local model", exact: true })).toHaveCount(0);
  await hostFixture(page, true, []);
  await page.getByRole("button", { name: "Check connection", exact: true }).click();
  await expect(setup).toContainText("Ollama is already connected");
  await expect(setup).toContainText("ollama pull qwen3:0.6b");
  await page.screenshot({ path: "test-results/setup-empty-journey-mobile.png", fullPage: true });
  await hostFixture(page);
  await page.getByRole("button", { name: "Check connection", exact: true }).click();
  await expect(page.getByRole("link", { name: "Try a local model", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("setup explains unavailable models before recommending another download", async ({ page }) => {
  await hostFixture(page);
  await page.route("**/api/models", (route) =>
    route.fulfill({
      json: {
        connected: true,
        models: [
          {
            name: "remote:cloud",
            sizeBytes: 0,
            parameterSize: "",
            quantization: "",
            modifiedAt: "",
            chatUnavailableReason: "Cloud models are unavailable for local chat.",
          },
        ],
      },
    }),
  );
  await page.goto("/connection");
  const setup = page.getByRole("region", { name: "Get your host ready", exact: true });
  await expect(page.getByRole("link", { name: "Review model library", exact: true })).toBeVisible();
  await expect(setup).not.toContainText("ollama pull");
  await page.screenshot({ path: "test-results/setup-unavailable-journey.png", fullPage: true });
  await expect(page.getByRole("link", { name: "Try a local model", exact: true })).toHaveCount(0);
});
