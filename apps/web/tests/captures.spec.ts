import { expect, test, type Page } from "@playwright/test";
import { hostFixture } from "./support/host-fixture";
import { download, downloadFixture } from "./support/download-fixture";
import { accessFixture, grant, publishInternet } from "./support/sharing-fixture";

// Opt-in design review captures of every surface, light and dark, desktop and
// 320px. Never compared: the pictures are evidence for a human to inspect.
test.skip(process.env.HOSTAI_CAPTURES !== "1", "Opt-in design captures");

const sizes = [
  { name: "1440", width: 1440, height: 1000 },
  { name: "320", width: 320, height: 900 },
] as const;
const schemes = ["light", "dark"] as const;

async function shoot(page: Page, name: string) {
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(150);
    await page.screenshot({
      path: `test-results/design/${name}-${scheme}.png`,
      fullPage: true,
      animations: "disabled",
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

const answer = [
  "## A useful answer",
  "",
  "Virtual threads are cheap, so blocking code can **scale** without callbacks.",
  "",
  "- One thread per task",
  "- Parked, not spinning",
  "",
  "```java",
  'Thread.startVirtualThread(() -> System.out.println("hi"));',
  "```",
  "",
  "| Kind | Cost |",
  "| --- | --- |",
  "| Platform | High |",
  "| Virtual | Low |",
].join("\n");

async function chatFixture(page: Page) {
  await page.route("**/api/chat", (route) =>
    route.fulfill({
      headers: { "Content-Type": "application/x-ndjson" },
      body: `${JSON.stringify({ content: answer, done: false })}\n${JSON.stringify({ content: "", done: true, outputTokens: 42 })}\n`,
    }),
  );
}

async function requestsFixture(page: Page) {
  await page.route("**/api/requests", (route) =>
    route.fulfill({
      json: {
        requests: [
          {
            id: "1",
            model: "fixture-model:small",
            status: "completed",
            startedAt: new Date(Date.now() - 60_000).toISOString(),
            durationMs: 2140,
            outputTokens: 118,
          },
          {
            id: "2",
            model: "fixture-model:small",
            status: "failed",
            startedAt: new Date(Date.now() - 120_000).toISOString(),
            durationMs: 380,
            outputTokens: null,
          },
          {
            id: "3",
            model: "other-model:medium",
            status: "running",
            startedAt: new Date().toISOString(),
            durationMs: null,
            outputTokens: null,
          },
        ],
      },
    }),
  );
}

for (const size of sizes) {
  test(`owner surfaces at ${size.name}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: size.width, height: size.height });

    await hostFixture(page, true, ["fixture-model:small", "other-model:medium"]);
    await requestsFixture(page);
    await page.goto("/");
    await expect(page.getByText("Ready to run", { exact: true })).toBeVisible();
    await shoot(page, `overview-ready-${size.name}`);

    await page.goto("/connection");
    await expect(page.getByRole("heading", { name: "Connection & setup" })).toBeVisible();
    await shoot(page, `connection-ready-${size.name}`);

    await page.goto("/activity");
    await expect(page.getByRole("cell", { name: "completed", exact: true })).toBeVisible();
    await shoot(page, `activity-${size.name}`);

    await chatFixture(page);
    await page.goto("/playground");
    await expect(page.getByText("Available to try", { exact: true })).toBeVisible();
    await shoot(page, `playground-empty-${size.name}`);
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Explain virtual threads");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("heading", { name: "A useful answer" })).toBeVisible();
    await shoot(page, `playground-answer-${size.name}`);

    const fixture = await accessFixture(page, ["fixture-model:small", "other-model:medium"]);
    publishInternet(fixture);
    fixture.state.grants.push(
      { ...grant("local"), label: "Colleague on this machine" },
      { ...grant("internet"), id: "f2f2", label: "Friend abroad" },
      {
        ...grant("local"),
        id: "old1",
        label: "Old guest",
        expiresAt: new Date(Date.now() - 3600_000).toISOString(),
      },
    );
    fixture.state.removableKeys = 1;
    fixture.cleanup.enabled = true;
    await page.goto("/sharing");
    await expect(page.getByText("Reachable from the internet", { exact: true })).toBeVisible();
    await shoot(page, `sharing-live-${size.name}`);

    if (size.name === "320") {
      await page.goto("/");
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
      await shoot(page, `nav-open-${size.name}`);
    }
  });

  test(`setup and download surfaces at ${size.name}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: size.width, height: size.height });
    await hostFixture(page, false);
    await page.goto("/");
    await expect(page.getByText("Setup required", { exact: true })).toBeVisible();
    await shoot(page, `overview-setup-${size.name}`);

    await downloadFixture(page, [download()]);
    await page.goto("/models");
    await expect(page.getByRole("progressbar")).toBeVisible();
    await shoot(page, `models-download-${size.name}`);

    await accessFixture(page);
    await page.goto("/sharing");
    await expect(page.getByText("Not hosting", { exact: true })).toBeVisible();
    await shoot(page, `sharing-stopped-${size.name}`);
  });

  test(`guest surfaces at ${size.name}`, async ({ page }) => {
    test.skip(!process.env.HOSTAI_GUEST_TEST_URL, "Requires the guest bundle server");
    test.setTimeout(120_000);
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.route("**/guest/v1/session", (route) =>
      route.fulfill({
        json: {
          hostLabel: "Stepan’s workstation",
          model: "fixture-model:small",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          available: true,
          unavailableReason: null,
          maxConcurrentGuests: 1,
          maxTokens: 1024,
          requestsPerMinute: 6,
          scope: "local-preview",
        },
      }),
    );
    await page.route("**/guest/v1/chat", (route) =>
      route.fulfill({
        headers: { "Content-Type": "application/x-ndjson" },
        body: `${JSON.stringify({ content: answer, done: false })}\n${JSON.stringify({ content: "", done: true })}\n`,
      }),
    );
    await page.goto(process.env.HOSTAI_GUEST_TEST_URL!);
    await expect(page.getByLabel("Access key", { exact: true })).toBeVisible();
    await shoot(page, `guest-key-${size.name}`);
    // A hash-only navigation would not reload the bundle, so leave the origin first.
    await page.goto("about:blank");
    await page.goto(process.env.HOSTAI_GUEST_TEST_URL! + "#access=fixture-access-key");
    await expect(page.locator("#guest-access-status")).toHaveText(
      "Access was available at the last check.",
    );
    await shoot(page, `guest-connected-${size.name}`);
    // The header session menu is a surface of its own: session facts, the access
    // reading and the connection controls all live behind that one summary.
    const summary = page.locator("#guest-session-menu");
    await summary.click();
    await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
    await shoot(page, `guest-session-menu-${size.name}`);
    await summary.evaluate((node) => {
      const details = node.closest("details");
      if (details?.open) details.open = false;
    });
    await page.getByLabel("Message", { exact: true }).fill("Explain virtual threads");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("heading", { name: "A useful answer" })).toBeVisible();
    await shoot(page, `guest-answer-${size.name}`);
  });
}
