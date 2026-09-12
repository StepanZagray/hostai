import { expect, test, type Page } from "@playwright/test";
import { hostFixture } from "./support/host-fixture";

async function runtimeFixture(page: Page, endpoint: unknown) {
  await hostFixture(page, false, []);
  await page.route("**/api/status", (route) =>
    route.fulfill({
      json: {
        status: "online",
        ollamaConnected: false,
        ollamaUrl: endpoint,
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
}

const sections = [
  ["/connection", "region", "Get your host ready"],
  ["/", "region", "Host setup"],
  ["/models", "complementary", "Add a model from your terminal"],
] as const;

for (const [path, role, name] of sections) {
  test(`${path} copies commands for the gateway's custom runtime`, async ({ page }) => {
    await runtimeFixture(page, "http://localhost:11500/");
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async (text: string) => {
            document.documentElement.dataset.copied = text;
          },
        },
      });
    });
    const mutations: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "GET") mutations.push(request.url());
    });
    await page.goto(path);
    const section = page.getByRole(role, { name, exact: true });
    const action = path === "/models" ? "pull qwen3:0.6b" : "serve";
    const label = path === "/models" ? "Copy model download command" : "Copy Ollama start command";
    const command = `OLLAMA_HOST='http://127.0.0.1:11500' ollama ${action}`;
    await expect(section.locator("pre").filter({ hasText: command })).toHaveText(command);
    await section.getByRole("button", { name: label, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-copied", command);
    if (path === "/")
      await expect(section.locator("pre").last()).toHaveText(
        "OLLAMA_HOST='http://127.0.0.1:11500' ollama pull qwen3:0.6b",
      );
    expect(mutations).toEqual([]);
  });

  test(`${path} withholds commands until gateway metadata recovers`, async ({ page }) => {
    await hostFixture(page, false, []);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/status", async (route) => {
      await gate;
      await route.fulfill({ status: 503, json: { detail: "Unavailable" } });
    });
    await page.goto(path);
    const section = page.getByRole(role, { name, exact: true });
    try {
      await expect(section.getByText("Checking your Ollama address…").first()).toBeVisible();
      await expect(section.locator("pre")).toHaveCount(0);
      if (path === "/connection")
        await section.screenshot({ path: "test-results/runtime-commands/loading.png" });
    } finally {
      release();
    }
    await expect(section.getByText(/Ollama’s address is unavailable/).first()).toBeVisible();
    await expect(section.locator("pre").filter({ hasText: "ollama" })).toHaveCount(0);
    if (path === "/connection")
      await section.screenshot({ path: "test-results/runtime-commands/unavailable.png" });
    await runtimeFixture(page, "http://127.0.0.1:11500");
    await page.reload();
    await expect(section.locator("pre").filter({ hasText: "11500" }).first()).toBeVisible();
  });
}

test("HTTPS setup explains TLS instead of offering a plaintext server", async ({ page }) => {
  await runtimeFixture(page, "https://localhost");
  for (const [path, role, name] of sections) {
    await page.goto(path);
    const section = page.getByRole(role, { name, exact: true });
    if (path !== "/models") {
      await expect(section).toContainText("HostAI expects HTTPS at https://127.0.0.1:443");
      await expect(section).not.toContainText("ollama serve");
      if (path === "/connection")
        await section.screenshot({ path: "test-results/runtime-commands/https.png" });
    }
    if (path !== "/connection")
      await expect(section.locator("pre")).toHaveText(
        "OLLAMA_HOST='https://127.0.0.1:443' ollama pull qwen3:0.6b",
      );
  }
});

test("malformed runtime metadata never becomes a copyable command", async ({ page }) => {
  await runtimeFixture(page, "http://localhost:11434'; echo unsafe");
  for (const [path, role, name] of sections) {
    await page.goto(path);
    const section = page.getByRole(role, { name, exact: true });
    await expect(section.getByText(/Ollama’s address is unavailable/).first()).toBeVisible();
    await expect(section.locator("pre")).toHaveCount(0);
  }
});

test("a ready overview avoids redundant start and download commands", async ({ page }) => {
  await hostFixture(page);
  await page.goto("/");
  const section = page.getByRole("region", { name: "Host setup" });
  await expect(section).toContainText("Ollama is already connected");
  await expect(section).toContainText("Your library has a model available to try");
  await expect(section.locator("pre")).toHaveCount(0);
  await section.screenshot({ path: "test-results/runtime-commands/ready.png" });
});

for (const width of [320, 768, 1024, 1440]) {
  test(`IPv6 runtime commands remain usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    await runtimeFixture(page, "http://[::1]:11500");
    for (const [path, role, name] of sections) {
      await page.goto(path);
      const section = page.getByRole(role, { name, exact: true });
      await expect(section.locator("pre").first()).toContainText("http://[::1]:11500");
      await expect(section.getByRole("button", { name: /Copy.*command/ }).first()).toBeVisible();
      const bounds = await section.boundingBox();
      for (const copy of await section.getByRole("button", { name: /Copy.*command/ }).all()) {
        const buttonBounds = await copy.boundingBox();
        expect(buttonBounds!.x + buttonBounds!.width).toBeLessThanOrEqual(
          bounds!.x + bounds!.width,
        );
      }
      await section.screenshot({
        path: `test-results/runtime-commands/${width}-${path === "/" ? "overview" : path.slice(1)}.png`,
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  });
}
