import { expect, test, type Page } from "@playwright/test";
import { hostFixture } from "./support/host-fixture";

/**
 * The guest's connection controls live in the header's session menu, a native
 * <details> that starts closed. Guard against an already-open menu (clicking the
 * summary toggles), and close it afterwards so the sheet cannot cover the page.
 */
async function useGuestMenu(page: Page, name: string) {
  const summary = page.locator("#guest-session-menu");
  if (!(await summary.evaluate((node) => !!node.closest("details")?.open))) await summary.click();
  await page.getByRole("button", { name, exact: true }).click();
  await summary.evaluate((node) => {
    const details = node.closest("details");
    if (details?.open) details.open = false;
  });
}

const models = [
  { name: "headless:latest", capabilities: { chat: false, infer: true } },
  { name: "chat-runtime:latest", capabilities: { chat: true, infer: false } },
  {
    name: "custom-runtime:latest",
    capabilities: { chat: false, infer: true },
    ui: { runtime: "custom", entry: "ui/index.html" },
  },
].map((model) => ({
  sizeBytes: 1,
  parameterSize: "",
  quantization: "",
  modifiedAt: "",
  chatUnavailableReason: null,
  ui: null,
  ...model,
}));

test("capabilities select working chat and keep unsupported models out of chat and sharing", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await hostFixture(page, true, []);
  await page.route("**/api/models", (route) =>
    route.fulfill({ json: { connected: true, models } }),
  );
  const sent: Record<string, unknown>[] = [];
  await page.route("**/api/chat", (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({
      contentType: "application/x-ndjson",
      body: '{"content":"Provider chat works.","done":true,"outputTokens":4}\n',
    });
  });
  await page.goto("/playground");
  await expect(page.getByRole("combobox", { name: "Model" })).toHaveValue("chat-runtime:latest");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Hello provider");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("Provider chat works.", { exact: true })).toBeVisible();
  expect(sent[0]).toMatchObject({
    model: "chat-runtime:latest",
    messages: [{ role: "user", content: "Hello provider" }],
  });
  await page.getByRole("button", { name: "API example" }).click();
  await expect(page.getByText(/\/api\/chat/)).toBeVisible();
  await page.getByRole("button", { name: "Hide API example" }).click();
  await page.screenshot({ path: "test-results/capability-chat.png", fullPage: true });

  await page.getByRole("combobox", { name: "Model" }).selectOption("headless:latest");
  await expect(page.getByRole("heading", { name: "No supported interface" })).toBeVisible();
  await expect(composer).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Run settings" })).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveCount(0);
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    await expect(page.getByRole("heading", { name: "No supported interface" })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/capability-unsupported-${width}.png`,
      fullPage: true,
    });
  }
  expect(sent).toHaveLength(1);
  // Returning to the chat model preserves its conversation and keyboard navigation.
  await page.getByRole("combobox", { name: "Model" }).selectOption("chat-runtime:latest");
  await expect(page.getByText("Provider chat works.", { exact: true })).toBeVisible();
  await composer.focus();
  await expect(composer).toBeFocused();
  await page.keyboard.press("Tab");

  await page.goto("/models");
  const unsupported = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: "headless:latest", exact: true }) });
  await expect(unsupported.getByText("No supported interface", { exact: true })).toBeVisible();
  await expect(unsupported.getByRole("link", { name: "Try in playground" })).toHaveCount(0);
  const custom = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: "custom-runtime:latest", exact: true }) });
  await custom.getByRole("link", { name: "Set up guest access" }).click();
  await expect(page.getByText("No model has a supported interface.", { exact: false })).toHaveCount(
    0,
  );
  await expect(page.locator('select option[value="headless:latest"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("guest capability metadata suppresses an unsupported composer and recovers to chat", async ({
  page,
}) => {
  test.skip(!process.env.HOSTAI_GUEST_TEST_URL, "Requires the isolated guest bundle server");
  const origin = process.env.HOSTAI_GUEST_TEST_URL!;
  let chat = false;
  let sent = 0;
  await page.route("**/guest/v1/session", (route) =>
    route.fulfill({
      json: {
        hostLabel: "Fixture host",
        model: "runtime:latest",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        available: chat,
        unavailableReason: chat ? null : "The shared model is unavailable.",
        maxConcurrentGuests: 1,
        maxTokens: 1024,
        requestsPerMinute: 6,
        scope: "local-preview",
        ui: null,
        capabilities: { chat, infer: false },
      },
    }),
  );
  await page.route("**/guest/v1/chat", (route) => {
    sent++;
    expect(route.request().headers().authorization).toBe("Bearer fixture-access");
    return route.fulfill({
      contentType: "application/x-ndjson",
      body: '{"content":"Guest provider answer.","done":true}\n',
    });
  });
  await page.goto(`${origin}/#access=fixture-access`);
  await expect(page.getByRole("heading", { name: "No supported interface" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "test-results/capability-guest-unsupported.png", fullPage: true });
  chat = true;
  await useGuestMenu(page, "Reconnect");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Hello");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("Guest provider answer.", { exact: true })).toBeVisible();
  expect(sent).toBe(1);
});
