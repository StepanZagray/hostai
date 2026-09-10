import { expect, test, type Page } from "@playwright/test";
import { hostFixture } from "./support/host-fixture";

const model = "fixture-model:small";
type Channel = "local" | "internet";
type Internet = {
  state: "off" | "starting" | "verifying" | "live" | "interrupted" | "stopping" | "failed";
  provider: "cloudflare-quick";
  available: boolean;
  publicUrl: string | null;
  checkedAt: string | null;
  error: string | null;
  restartRequired?: boolean;
};
type SharingTestWindow = typeof window & { sharingCopies: string[] };
const publicOrigin = "https://temporary-fixture.trycloudflare.com";
const grant = (channel?: Channel) => ({
  id: "b475df22-52e7-4f2d-89f2-b7b655cae056",
  label: "Visitor",
  model,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  revokedAt: null as string | null,
  channel,
});
async function accessFixture(page: Page) {
  await hostFixture(page);
  await page.addInitScript(() => {
    (window as SharingTestWindow).sharingCopies = [];
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          (window as SharingTestWindow).sharingCopies.push(text);
        },
      },
    });
  });
  const state = {
    state: "stopped",
    hostLabel: "Local host",
    model: null as string | null,
    guestUrl: null as string | null,
    error: null as string | null,
    grants: [] as ReturnType<typeof grant>[],
    internet: {
      state: "off",
      provider: "cloudflare-quick",
      available: true,
      publicUrl: null,
      checkedAt: null,
      error: null,
    } as Internet | undefined,
  };
  const calls: string[] = [];
  const bodies: { channel?: Channel; label?: string; expiresInHours?: number }[] = [];
  let reads = 0;
  let failRead = false;
  const response = {
    channel: undefined as Channel | undefined,
    inviteUrl: undefined as string | undefined,
  };
  await page.route("**/api/sharing**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "GET") {
      reads++;
      return route.fulfill({
        status: failRead ? 503 : 200,
        json: failRead ? { detail: "The gateway is unavailable." } : state,
      });
    }
    calls.push(path);
    bodies.push(route.request().postDataJSON());
    if (path === "/api/sharing/internet/start") {
      if (state.state !== "local" || !state.internet?.available)
        return route.fulfill({ status: 409, json: { detail: "Internet sharing is unavailable." } });
      Object.assign(state.internet, {
        state: "starting",
        publicUrl: null,
        checkedAt: null,
        error: null,
      });
    } else if (path === "/api/sharing/internet/stop") {
      Object.assign(state.internet!, { state: "stopping", publicUrl: null });
    } else if (path === "/api/sharing/start") {
      Object.assign(state, route.request().postDataJSON(), {
        state: "local",
        guestUrl: "http://127.0.0.1:8081",
      });
    } else if (path === "/api/sharing/stop") {
      state.state = "stopped";
      if (state.internet) Object.assign(state.internet, { state: "off", publicUrl: null });
    } else if (path.endsWith("/revoke")) state.grants[0].revokedAt = new Date().toISOString();
    else if (path.endsWith("/grants")) {
      const body = route.request().postDataJSON();
      if (body.channel === "internet" && state.internet?.state !== "live")
        return route.fulfill({ status: 409, json: { detail: "Internet sharing is not live." } });
      const item = { ...grant(response.channel ?? body.channel), label: body.label };
      state.grants.push(item);
      return route.fulfill({
        json: {
          grant: item,
          token: "fixture-secret",
          inviteUrl:
            response.inviteUrl ??
            `${item.channel === "internet" ? state.internet!.publicUrl : "http://127.0.0.1:8081"}/#access=fixture-secret`,
        },
      });
    }
    return route.fulfill({ json: state });
  });
  return {
    state,
    calls,
    bodies,
    response,
    reads: () => reads,
    failRead: () => {
      failRead = true;
    },
  };
}

test("model library leads to local access, one-time key creation and durable revoke controls", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  await page.goto("/models");
  await page.getByRole("link", { name: "Set up client access", exact: true }).click();
  await expect(page.getByLabel("Model for clients")).toHaveValue(model);
  await expect(page.getByText("Local preview only", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start local client access", exact: true }).click();
  await page.getByLabel("Key label", { exact: true }).fill("Visitor");
  await page.getByRole("button", { name: "Create client link", exact: true }).click();
  await expect(page.getByRole("region", { name: "New client link", exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("fixture-secret");
  await page.screenshot({ path: "test-results/sharing-local-key.png", fullPage: true });
  await page.getByRole("button", { name: "Revoke Visitor", exact: true }).click();
  await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "New client link", exact: true })).toHaveCount(0);
  expect(fixture.calls).toEqual([
    "/api/sharing/start",
    "/api/sharing/grants",
    `/api/sharing/grants/${grant().id}/revoke`,
  ]);
  await page.getByRole("button", { name: "Stop client access", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Client access is stopped", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(
    "fixture-secret",
  );
});

test("access storage failure blocks enabling guests and remains legible at 320px", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  fixture.state.state = "unavailable";
  fixture.state.error =
    "Access storage is unavailable. Client access is stopped; local chat still works.";
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/sharing");
  await expect(page.getByRole("alert")).toContainText("Access storage is unavailable");
  await expect(
    page.getByRole("button", { name: "Start local client access", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText("No keys are recorded.", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/sharing-mobile-unavailable.png", fullPage: true });
  expect(fixture.calls).toEqual([]);
});

test("failed access refresh retains the emergency stop without claiming current status", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  Object.assign(fixture.state, { state: "local", model, guestUrl: "http://127.0.0.1:8081" });
  await page.goto("/sharing");
  await expect(page.getByRole("button", { name: "Stop client access", exact: true })).toBeVisible();
  fixture.failRead();
  await page.getByRole("button", { name: "Refresh access", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Saved access status may be out of date");
  await expect(page.getByRole("button", { name: "Stop client access", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Stop client access", exact: true }).click();
  expect(fixture.calls).toEqual(["/api/sharing/stop"]);
});

async function refreshAccess(page: Page) {
  await page.getByRole("button", { name: "Refresh access", exact: true }).click();
  await expect(page.getByRole("button", { name: "Refresh access", exact: true })).toBeEnabled();
}

function publishLocal(fixture: Awaited<ReturnType<typeof accessFixture>>) {
  Object.assign(fixture.state, { state: "local", model, guestUrl: "http://127.0.0.1:8081" });
}

function publishInternet(fixture: Awaited<ReturnType<typeof accessFixture>>) {
  publishLocal(fixture);
  Object.assign(fixture.state.internet!, {
    state: "live",
    publicUrl: publicOrigin,
    checkedAt: new Date().toISOString(),
  });
}

test("explicit internet start verifies before issuing a key, then interruption hides it and stop keeps local access", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  await page.clock.install();
  await page.goto("/sharing");
  const internet = page.getByRole("region", { name: "Temporary internet sharing", exact: true });
  const start = page.getByRole("button", { name: "Start internet sharing", exact: true });
  await expect(start).toBeDisabled();
  await expect(internet).toContainText("Starting publishes the guest page through Cloudflare");
  await expect(internet).toContainText("Anyone can open the page in a browser");
  await expect(internet).toContainText("an internet access key is required for chat");
  await expect(internet).toContainText(
    "Cloudflare terminates TLS and can see messages and access keys",
  );
  await expect(internet).toContainText("URL changes on every start");
  await expect(internet).toContainText("no uptime guarantee");
  await expect(internet).toContainText("not production hosting");
  await page.getByRole("button", { name: "Start local client access", exact: true }).click();
  await expect(start).toBeEnabled();
  expect(fixture.calls).toEqual(["/api/sharing/start"]);
  await start.click();
  await expect(internet.getByRole("status")).toHaveText("Starting internet sharing…");
  await expect(page.getByLabel("Key channel").locator('option[value="internet"]')).toHaveJSProperty(
    "disabled",
    true,
  );
  fixture.state.internet!.state = "verifying";
  await page.clock.runFor(2_000);
  await expect(internet.getByRole("status")).toHaveText("Verifying the public connection…");
  await expect(page.getByText(publicOrigin, { exact: true })).toHaveCount(0);
  publishInternet(fixture);
  await page.clock.runFor(2_000);
  await expect(internet.getByRole("status")).toHaveText("Internet sharing is live");
  await expect(page.getByText(publicOrigin, { exact: true })).toBeVisible();
  await expect(page.getByText("Local preview only", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Public discovery requires an optional directory listing below.", {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByLabel("Key channel").selectOption("internet");
  await page.getByLabel("Key label", { exact: true }).fill("Internet visitor");
  await page.getByRole("button", { name: "Create client link", exact: true }).click();
  const link = page.getByRole("region", { name: "New client link", exact: true });
  await expect(link).toContainText("Your internet link is ready");
  await expect(page.getByRole("region", { name: "Access keys", exact: true })).toContainText(
    "Temporary internet",
  );
  expect(fixture.bodies[2]).toEqual({
    label: "Internet visitor",
    expiresInHours: 24,
    channel: "internet",
  });
  expect(await page.evaluate(() => (window as SharingTestWindow).sharingCopies)).toEqual([]);
  expect(await page.content()).not.toContain("fixture-secret");
  expect(await page.title()).not.toContain("fixture-secret");
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(
    "fixture-secret",
  );
  await page.getByRole("button", { name: "Copy client link", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as SharingTestWindow).sharingCopies))
    .toEqual([`${publicOrigin}/#access=fixture-secret`]);
  Object.assign(fixture.state.internet!, { state: "interrupted", publicUrl: null });
  await page.clock.runFor(5_000);
  await expect(internet.getByRole("status")).toHaveText("Internet sharing is interrupted");
  await expect(link).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy client link", exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create client link", exact: true }),
  ).toBeDisabled();
  await expect(start).toBeDisabled();
  await page.getByRole("button", { name: "Stop internet sharing", exact: true }).click();
  await expect(internet.getByRole("status")).toHaveText("Stopping internet sharing…");
  fixture.state.internet!.state = "off";
  await page.clock.runFor(2_000);
  await expect(internet.getByRole("status")).toHaveText("Internet sharing is off");
  await expect(
    page.getByRole("heading", { name: "Local client access is on", exact: true }),
  ).toBeVisible();
  await expect(start).toBeEnabled();
  expect(fixture.calls).toEqual([
    "/api/sharing/start",
    "/api/sharing/internet/start",
    "/api/sharing/grants",
    "/api/sharing/internet/stop",
  ]);
});

test("a returned local key is never promoted by channel selection or internet start and stop", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  publishInternet(fixture);
  // The returned grant, rather than the currently selected form channel, owns the disclosure.
  fixture.response.channel = "local";
  await page.goto("/sharing");
  await page.getByLabel("Key channel").selectOption("internet");
  await page.getByLabel("Key label", { exact: true }).fill("Local visitor");
  await page.getByRole("button", { name: "Create client link", exact: true }).click();
  const link = page.getByRole("region", { name: "New client link", exact: true });
  await expect(link).toContainText("Your local preview link is ready");
  await page.getByRole("button", { name: "Stop internet sharing", exact: true }).click();
  fixture.state.internet!.state = "off";
  await refreshAccess(page);
  await expect(link).toBeVisible();
  await page.getByRole("button", { name: "Start internet sharing", exact: true }).click();
  publishInternet(fixture);
  await refreshAccess(page);
  await page.getByRole("button", { name: "Copy client link", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as SharingTestWindow).sharingCopies))
    .toEqual(["http://127.0.0.1:8081/#access=fixture-secret"]);
  await expect(link).toContainText("browser on this machine");
  expect(fixture.calls.filter((path) => path.endsWith("/grants"))).toHaveLength(1);
});

test("internet one-time links are forgotten on origin change and stay hidden after recovery", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  publishInternet(fixture);
  await page.goto("/sharing");
  await page.getByLabel("Key channel").selectOption("internet");
  await page.getByLabel("Key label", { exact: true }).fill("Visitor");
  await page.getByRole("button", { name: "Create client link", exact: true }).click();
  const link = page.getByRole("region", { name: "New client link", exact: true });
  await expect(link).toBeVisible();
  fixture.state.internet!.publicUrl = "https://another-fixture.trycloudflare.com";
  await refreshAccess(page);
  await expect(link).toHaveCount(0);
  fixture.state.internet!.publicUrl = publicOrigin;
  await refreshAccess(page);
  await expect(link).toHaveCount(0);
  expect(await page.evaluate(() => (window as SharingTestWindow).sharingCopies)).toEqual([]);
});

test("legacy grants stay local and an older gateway never enables internet start", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  publishLocal(fixture);
  fixture.state.internet = undefined;
  fixture.state.grants.push(grant());
  await page.goto("/sharing");
  await expect(page.getByRole("region", { name: "Access keys", exact: true })).toContainText(
    "Local preview",
  );
  await expect(
    page.getByText("Internet sharing is not available in this gateway", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start internet sharing", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("Key channel").locator('option[value="internet"]')).toHaveJSProperty(
    "disabled",
    true,
  );
  expect(fixture.calls).toEqual([]);
});

for (const inviteUrl of [
  publicOrigin,
  `${publicOrigin}/#access=wrong-key`,
  "http://127.0.0.1:8081/#access=fixture-secret",
]) {
  test(`an internet grant never offers an invalid credential link ${inviteUrl}`, async ({
    page,
  }) => {
    const fixture = await accessFixture(page);
    publishInternet(fixture);
    fixture.response.inviteUrl = inviteUrl;
    await page.goto("/sharing");
    await page.getByLabel("Key channel").selectOption("internet");
    await page.getByLabel("Key label", { exact: true }).fill("Visitor");
    await page.getByRole("button", { name: "Create client link", exact: true }).click();
    await expect(page.getByRole("button", { name: "Revoke Visitor", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "New client link", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Copy client link", exact: true })).toHaveCount(
      0,
    );
    expect(await page.evaluate(() => (window as SharingTestWindow).sharingCopies)).toEqual([]);
  });
}

test("a failed internet connection requires an explicit retry and cannot issue internet keys", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  publishLocal(fixture);
  Object.assign(fixture.state.internet!, {
    state: "failed",
    error: "The public connection could not be started.",
  });
  await page.clock.install();
  await page.goto("/sharing");
  await expect(page.getByText("Internet sharing failed", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("public connection could not be started");
  await expect(page.getByLabel("Key channel").locator('option[value="internet"]')).toHaveJSProperty(
    "disabled",
    true,
  );
  await page.clock.runFor(5_000);
  expect(fixture.calls).toEqual([]);
  await page.getByRole("button", { name: "Start internet sharing", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Temporary internet sharing", exact: true })
      .getByRole("status"),
  ).toHaveText("Starting internet sharing…");
  expect(fixture.calls).toEqual(["/api/sharing/internet/start"]);
});

test("missing connector blocks start with installation guidance and controls wrap on mobile", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  publishLocal(fixture);
  fixture.state.internet!.available = false;
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/sharing");
  await expect(
    page.getByRole("button", { name: "Start internet sharing", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("link", { name: "official installation instructions", exact: true }),
  ).toHaveAttribute(
    "href",
    "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/",
  );
  await expect(page.getByText(/then restart the gateway and refresh access/)).toBeVisible();
  expect(fixture.calls).toEqual([]);
  fixture.state.internet!.available = true;
  publishInternet(fixture);
  fixture.state.internet!.publicUrl = `https://${"long-name-".repeat(5)}fixture.trycloudflare.com`;
  await refreshAccess(page);
  await page.getByLabel("Key channel").selectOption("internet");
  await page.getByLabel("Key label", { exact: true }).fill("A".repeat(80));
  await page.getByRole("button", { name: "Create client link", exact: true }).click();
  await expect(page.getByRole("region", { name: "New client link", exact: true })).toBeVisible();
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      await page.locator("main button, main select, main input").evaluateAll((elements) =>
        elements.every((element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.width === 0 || (rect.left >= 0 && rect.right <= innerWidth && rect.height >= 44)
          );
        }),
      ),
    ).toBe(true);
    await page.screenshot({ path: `test-results/sharing-internet-${width}.png`, fullPage: true });
  }
  const copy = page.getByRole("button", { name: "Copy client link", exact: true });
  await copy.focus();
  await copy.press("Enter");
  await expect
    .poll(() => page.evaluate(() => (window as SharingTestWindow).sharingCopies.length))
    .toBe(1);
});

test("stale GET disables internet link copying while emergency internet stop remains usable", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  publishInternet(fixture);
  await page.goto("/sharing");
  await page.getByLabel("Key channel").selectOption("internet");
  await page.getByLabel("Key label", { exact: true }).fill("Visitor");
  await page.getByRole("button", { name: "Create client link", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copy client link", exact: true })).toBeEnabled();
  fixture.failRead();
  await refreshAccess(page);
  await expect(page.getByRole("alert")).toContainText("Saved access status may be out of date");
  await expect(page.getByRole("button", { name: "Copy client link", exact: true })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Stop internet sharing", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Stop internet sharing", exact: true }).click();
  await expect(page.getByRole("region", { name: "New client link", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop client access", exact: true })).toBeEnabled();
  expect(fixture.calls).toEqual(["/api/sharing/grants", "/api/sharing/internet/stop"]);
});

test("stopping all client access also stops internet and never restarts it with local access", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  publishInternet(fixture);
  await page.goto("/sharing");
  await page.getByRole("button", { name: "Stop client access", exact: true }).click();
  await expect(page.getByText("Internet sharing is off", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start local client access", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Local client access is on", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Internet sharing is off", { exact: true })).toBeVisible();
  expect(fixture.calls).toEqual(["/api/sharing/stop", "/api/sharing/start"]);
});

test("status polling pauses while hidden and checks again on return", async ({ page }) => {
  const fixture = await accessFixture(page);
  publishInternet(fixture);
  await page.clock.install();
  await page.goto("/sharing");
  await expect(page.getByText("Internet sharing is live", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const reads = fixture.reads();
  await page.clock.runFor(10_000);
  expect(fixture.reads()).toBe(reads);
  Object.assign(fixture.state.internet!, { state: "interrupted", publicUrl: null });
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByText("Internet sharing is interrupted", { exact: true })).toBeVisible();
  expect(fixture.reads()).toBe(reads + 1);
});

test("a cleanup failure explains restart and disables tunnel actions that cannot succeed", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  publishLocal(fixture);
  Object.assign(fixture.state.internet!, {
    state: "failed",
    restartRequired: true,
    error: "Internet requests are blocked, but cleanup failed. Restart the gateway.",
  });
  await page.goto("/sharing");
  await expect(page.getByRole("alert")).toContainText("Restart the gateway");
  await expect(
    page.getByRole("button", { name: "Start internet sharing", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Stop internet sharing", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "Stop client access", exact: true })).toBeEnabled();
  expect(fixture.calls).toEqual([]);
});

test("a local key cannot be copied with an address for another listener", async ({ page }) => {
  const fixture = await accessFixture(page);
  publishLocal(fixture);
  fixture.response.inviteUrl = "http://127.0.0.1:9081/#access=fixture-secret";
  await page.goto("/sharing");
  await page.getByLabel("Key label", { exact: true }).fill("Visitor");
  await page.getByRole("button", { name: "Create client link", exact: true }).click();
  await expect(page.getByRole("button", { name: "Revoke Visitor", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy client link", exact: true })).toHaveCount(0);
});

test("verification feedback explains the current check while keeping Stop available", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  publishLocal(fixture);
  Object.assign(fixture.state.internet!, {
    state: "verifying",
    error: "Waiting for public DNS. Internet access remains blocked.",
  });
  await page.goto("/sharing");
  await expect(
    page.getByText("Waiting for public DNS. Internet access remains blocked.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Stop internet sharing", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Start internet sharing", exact: true }),
  ).toBeDisabled();
  expect(fixture.calls).toEqual([]);
});

test("expired one-time keys cannot be copied even before the next status poll", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  publishInternet(fixture);
  await page.clock.install();
  await page.goto("/sharing");
  await page.getByLabel("Key channel").selectOption("internet");
  await page.getByLabel("Key label", { exact: true }).fill("Visitor");
  await page.getByRole("button", { name: "Create client link", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copy client link", exact: true })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  });
  await page.clock.fastForward(3_600_001);
  await expect(page.getByRole("button", { name: "Copy client link", exact: true })).toHaveCount(0);
  expect(fixture.calls).toEqual(["/api/sharing/grants"]);
});

test("real owner link connects a guest and revocation ends an active response", async ({
  page,
  context,
}) => {
  test.skip(
    process.env.HOSTAI_INTEGRATION !== "1" || !process.env.HOSTAI_GUEST_TEST_URL,
    "Requires temporary access storage and the explicit isolated Ollama fixture.",
  );
  await page.goto("/sharing?model=test-model%3Asmall");
  const status = await (await page.request.get("/api/sharing")).json();
  if (status.state === "local")
    await page.getByRole("button", { name: "Stop client access", exact: true }).click();
  await page.getByRole("button", { name: "Start local client access", exact: true }).click();
  await page.getByLabel("Key label", { exact: true }).fill("Integration visitor");
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/sharing/grants") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create client link", exact: true }).click();
  const invite = await (await created).json();
  expect(new URL(invite.inviteUrl).origin).toBe(new URL(process.env.HOSTAI_GUEST_TEST_URL!).origin);
  const guest = await context.newPage();
  try {
    await guest.goto(invite.inviteUrl);
    await expect(
      guest.getByText("Access was available at the last check.", { exact: true }),
    ).toBeVisible();
    expect(new URL(guest.url()).hash).toBe("");
    await guest.getByLabel("Message", { exact: true }).fill("Guest integration");
    await guest.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(
      guest.getByText("Hello from the isolated test runtime. Stream complete.", { exact: true }),
    ).toBeVisible();
    await guest.getByLabel("Message", { exact: true }).fill("Revoke during generation");
    await guest.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(
      guest
        .getByRole("article", { name: "Exchange 2" })
        .getByText("Hello from the isolated test runtime.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Revoke Integration visitor", exact: true }).click();
    await expect(guest.getByRole("alert")).toContainText("The response ended before completion");
    await expect(guest.getByLabel("Message", { exact: true })).toHaveValue(
      "Revoke during generation",
    );
    await guest.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(guest.getByRole("alert")).toContainText("invalid, expired, or revoked");
    await expect(guest.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
    await expect
      .poll(async () => (await (await page.request.get("/api/status")).json()).activeRequests)
      .toBe(0);
    await guest.screenshot({ path: "test-results/guest-integration-revoked.png", fullPage: true });
  } finally {
    await guest.close();
    await page.request.post(`/api/sharing/grants/${invite.grant.id}/revoke`, { data: {} });
    await page.request.post("/api/sharing/stop", { data: {} });
  }
});
