import { expect, test, type Page } from "@playwright/test";

async function hostFixture(page: Page, connected = true) {
  await page.route("**/api/status", (route) =>
    route.fulfill({
      json: {
        status: "online",
        ollamaConnected: connected,
        ollamaUrl: "http://127.0.0.1:11434",
        version: "0.1.0",
        javaVersion: "26",
        uptimeSeconds: 12,
        activeRequests: 0,
        maxConcurrentRequests: 2,
        totalRequests: 0,
        failedRequests: 0,
      },
    }),
  );
  await page.route("**/api/models", (route) =>
    route.fulfill({
      json: {
        connected,
        models: connected
          ? [
              {
                name: "fixture-model:small",
                sizeBytes: 800000000,
                parameterSize: "0.6B",
                quantization: "Q4_K_M",
                modifiedAt: new Date().toISOString(),
              },
            ]
          : [],
      },
    }),
  );
  await page.route("**/api/requests", (route) => route.fulfill({ json: { requests: [] } }));
}

test("offline host has useful setup and disabled generation", async ({ page }) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 503,
      json: {
        detail: "The HostAI backend is unavailable. Start the Java service, then reconnect.",
      },
    }),
  );
  await page.goto("/");
  await expect(page.getByText("Gateway offline", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Connect your runtime" }).click();
  await expect(page.getByRole("heading", { name: "Connection & setup" })).toBeVisible();
  await page.getByRole("link", { name: "Playground", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
});

test("model search, navigation and streamed conversation", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await hostFixture(page);
  await page.route("**/api/chat", async (route) => {
    expect(route.request().postDataJSON().model).toBe("fixture-model:small");
    await route.fulfill({
      contentType: "application/x-ndjson",
      body: '{"content":"Hello from the test runtime.","done":false}\n{"content":"","done":true,"outputTokens":7}\n',
    });
  });
  await page.goto("/models");
  await page.getByRole("textbox", { name: "Search installed models" }).fill("missing");
  await expect(page.getByRole("heading", { name: "No matching models" })).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await page.getByRole("link", { name: "Try in playground" }).click();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Hello");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Hello from the test runtime.", { exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "7 output tokens" })).toBeVisible();
  await page.screenshot({ path: "test-results/playground-completed.png", fullPage: true });
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What’s on your mind?" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("stream failures are visible and allow another request", async ({ page }) => {
  await hostFixture(page);
  await page.route("**/api/chat", (route) =>
    route.fulfill({ status: 429, json: { detail: "All generation slots are busy." } }),
  );
  await page.goto("/playground");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Hello");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("alert")).toHaveText("All generation slots are busy.");
  await page.screenshot({ path: "test-results/playground-overloaded.png", fullPage: true });
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Try again");
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
});

test("malformed streams show a readable error and allow retry", async ({ page }) => {
  await hostFixture(page);
  await page.route("**/api/chat", (route) =>
    route.fulfill({ contentType: "application/x-ndjson", body: "not JSON\n" }),
  );
  await page.goto("/playground");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Hello");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("alert")).toHaveText("The model returned an invalid stream.");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Try again");
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
  await page.screenshot({ path: "test-results/playground-invalid-stream.png", fullPage: true });
});

test("mobile navigation and layout fit the viewport", async ({ page }) => {
  await hostFixture(page, false);
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Host overview" })).toBeVisible();
    await expect(page.getByText("Gateway online", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    if (width === 320) {
      await page.getByRole("button", { name: "Open navigation" }).click();
      await page.getByRole("link", { name: "Models", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Your model library" })).toBeVisible();
      await page.screenshot({ path: "test-results/mobile-models.png", fullPage: true });
    }
  }
  await page.screenshot({ path: "test-results/desktop-overview.png", fullPage: true });
});
