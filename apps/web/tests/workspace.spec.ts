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
  await expect(page.getByText("Gateway unavailable", { exact: true })).toBeVisible();
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

test("activity refresh failure keeps chat usable and recovers on retry", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await hostFixture(page);
  let failed = false;
  await page.route("**/api/requests", (route) =>
    failed
      ? route.fulfill({ status: 503, json: { detail: "Unavailable" } })
      : route.fulfill({
          json: {
            requests: [
              {
                id: "previous",
                model: "fixture-model:small",
                status: "completed",
                durationMs: 200,
                outputTokens: 7,
                startedAt: new Date().toISOString(),
              },
            ],
          },
        }),
  );
  await page.route("**/api/chat", (route) =>
    route.fulfill({
      contentType: "application/x-ndjson",
      body: '{"content":"Still working","done":true}\n',
    }),
  );
  await page.goto("/activity");
  await expect(page.getByRole("cell", { name: "completed", exact: true })).toBeVisible();
  failed = true;
  await page.getByRole("button", { name: "Refresh activity" }).click();
  await expect(page.getByRole("heading", { name: "Request activity unavailable" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "A quiet workspace" })).toHaveCount(0);
  await expect(page.getByText("Gateway online", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Playground", exact: true }).click();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Hello");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Still working", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Request activity could not be refreshed.");
  await page.screenshot({ path: "test-results/partial-refresh-playground.png", fullPage: true });
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  failed = false;
  const retry = page.getByRole("button", { name: "Retry refresh" });
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("link", { name: "Request activity", exact: true }).click();
  await expect(page.getByRole("cell", { name: "completed", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("failed model discovery is unavailable, not an empty library", async ({ page }) => {
  await hostFixture(page);
  await page.route("**/api/models", (route) =>
    route.fulfill({ status: 503, json: { detail: "Unavailable" } }),
  );
  await page.goto("/models");
  await expect(page.getByText("Gateway online", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Model discovery unavailable" })).toBeVisible();
  await expect(page.getByText("Model count unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your library starts here" })).toHaveCount(0);
  await page.screenshot({ path: "test-results/models-unavailable.png", fullPage: true });
  await page.getByRole("link", { name: "Playground", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  await page.getByRole("link", { name: "Request activity", exact: true }).click();
  await expect(page.getByRole("heading", { name: "A quiet workspace" })).toBeVisible();
});

test("failed status refresh never claims readiness from a successful model fetch", async ({
  page,
}) => {
  await hostFixture(page);
  await page.route("**/api/status", (route) =>
    route.fulfill({ status: 503, json: { detail: "Unavailable" } }),
  );
  await page.goto("/models");
  await expect(page.getByText("Gateway unavailable", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "fixture-model:small", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Try in playground" }).click();
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("Gateway status could not be refreshed.");
  await page.route("**/api/models", (route) =>
    route.fulfill({ json: { models: [], connected: true } }),
  );
  await page.getByRole("button", { name: "Retry refresh" }).click();
  await page.getByRole("link", { name: "Models", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your library starts here" })).toBeVisible();
});

test("model count stays unknown until discovery finishes", async ({ page }) => {
  await hostFixture(page);
  let finishDiscovery!: () => void;
  const discovery = new Promise<void>((resolve) => {
    finishDiscovery = resolve;
  });
  await page.route("**/api/models", async (route) => {
    await discovery;
    await route.fulfill({ json: { connected: true, models: [] } });
  });
  try {
    await page.goto("/models");
    await expect(page.getByText("Checking installed models…", { exact: true })).toBeVisible();
    await expect(page.getByText("0 installed models", { exact: true })).toHaveCount(0);
  } finally {
    finishDiscovery();
  }
  await expect(page.getByText("0 installed models", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your library starts here" })).toBeVisible();
});
