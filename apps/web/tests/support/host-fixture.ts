import type { Page } from "@playwright/test";

export async function hostFixture(page: Page, connected = true, names = ["fixture-model:small"]) {
  await page.route("**/api/directory", (route) =>
    route.fulfill({
      json: {
        state: "off",
        configured: false,
        registryUrl: null,
        enabled: false,
        canPublish: false,
        identityId: null,
        updatedAt: null,
        expiresAt: null,
        error: null,
      },
    }),
  );
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
          ? names.map((name) => ({
              name,
              sizeBytes: 800000000,
              parameterSize: "0.6B",
              quantization: "Q4_K_M",
              modifiedAt: new Date().toISOString(),
              chatUnavailableReason: null,
            }))
          : [],
      },
    }),
  );
  await page.route("**/api/model-downloads", (route) => route.fulfill({ json: { downloads: [] } }));
  await page.route("**/api/requests", (route) => route.fulfill({ json: { requests: [] } }));
}
