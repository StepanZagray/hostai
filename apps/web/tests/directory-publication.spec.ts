import { expect, test, type Page } from "@playwright/test";
import { hostFixture } from "./support/host-fixture";
async function fixture(page: Page) {
  await hostFixture(page);
  const state = {
    state: "off",
    configured: true,
    registryUrl: "https://directory.example/",
    enabled: false,
    canPublish: true,
    identityId: null as string | null,
    updatedAt: null as number | null,
    expiresAt: null as number | null,
    error: null as string | null,
  };
  const sharing = {
    state: "local",
    hostLabel: "Fixture host",
    model: "fixture-model:small",
    guestUrl: "http://127.0.0.1:8081",
    error: null,
    grants: [],
    internet: {
      state: "live",
      provider: "cloudflare-quick",
      available: true,
      publicUrl: "https://fixture-host.trycloudflare.com",
      checkedAt: new Date().toISOString(),
      error: null,
    },
  };
  const calls: string[] = [];
  let loseStart = false,
    failRead = false;
  await page.route("**/api/sharing**", (route) => {
    if (route.request().method() !== "GET") calls.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: sharing });
  });
  await page.route("**/api/directory**", (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() === "GET")
      return route.fulfill({
        status: failRead ? 503 : 200,
        json: failRead ? { detail: "private-registry-error" } : state,
      });
    calls.push(path);
    expect(request.postDataJSON()).toEqual({});
    if (path.endsWith("/start")) {
      Object.assign(state, {
        state: "listed",
        enabled: true,
        identityId: "a".repeat(64),
        updatedAt: Date.now(),
        expiresAt: Date.now() + 90000,
      });
      if (loseStart) {
        failRead = true;
        return route.abort();
      }
    }
    if (path.endsWith("/stop")) Object.assign(state, { state: "off", enabled: false, error: null });
    return route.fulfill({ json: state });
  });
  return {
    state,
    calls,
    sharing,
    loseStart: () => {
      loseStart = true;
    },
    failRead: () => {
      failRead = true;
    },
  };
}
test("listing is explicit and removal leaves the tunnel and client keys alone", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/sharing");
  const section = page.getByRole("region", { name: "Public directory listing" });
  await expect(section.getByText("Not listed", { exact: true })).toBeVisible();
  expect(state.calls).toEqual([]);
  await expect(section).toContainText("visible to everyone");
  await section.getByRole("button", { name: "Publish listing", exact: true }).click();
  await expect(section.getByText("Listed in the directory", { exact: true })).toBeVisible();
  await section.getByRole("button", { name: "Remove listing", exact: true }).click();
  await expect(section.getByText("Not listed", { exact: true })).toBeVisible();
  expect(state.calls).toEqual(["/api/directory/start", "/api/directory/stop"]);
  expect(state.sharing.internet.state).toBe("live");
  await page.screenshot({ path: "test-results/directory-owner-controls.png", fullPage: true });
});
test("unconfigured or unverified internet cannot publish a listing", async ({ page }) => {
  const state = await fixture(page);
  state.state.canPublish = false;
  await page.goto("/sharing");
  const section = page.getByRole("region", { name: "Public directory listing" });
  await expect(
    section.getByRole("button", { name: "Publish listing", exact: true }),
  ).toBeDisabled();
  await expect(section).toContainText("wait for its public connection check");
  Object.assign(state.state, { configured: false, registryUrl: null });
  await page.reload();
  await expect(section).toContainText("No directory is configured");
  await expect(section.getByRole("button", { name: "Publish listing", exact: true })).toHaveCount(
    0,
  );
  expect(state.calls).toEqual([]);
});
test("an uncertain publish response leaves explicit removal available without resending", async ({
  page,
}) => {
  const state = await fixture(page);
  state.loseStart();
  await page.goto("/sharing");
  const section = page.getByRole("region", { name: "Public directory listing" });
  await section.getByRole("button", { name: "Publish listing", exact: true }).click();
  await expect(section.getByRole("alert")).toContainText("could not be confirmed");
  await expect(
    section.getByRole("button", { name: "Publish listing", exact: true }),
  ).toBeDisabled();
  await expect(section.getByRole("button", { name: "Remove listing", exact: true })).toBeEnabled();
  await section.getByRole("button", { name: "Remove listing", exact: true }).click();
  expect(state.calls).toEqual(["/api/directory/start", "/api/directory/stop"]);
  expect(await page.content()).not.toContain("private-registry-error");
});
test("stale directory status disables publishing but keeps removing a known listing possible", async ({
  page,
}) => {
  const state = await fixture(page);
  Object.assign(state.state, { state: "listed", enabled: true, identityId: "a".repeat(64) });
  await page.clock.install();
  await page.goto("/sharing");
  const section = page.getByRole("region", { name: "Public directory listing" });
  await expect(section.getByText("Listed in the directory", { exact: true })).toBeVisible();
  state.failRead();
  await page.clock.fastForward(3100);
  await expect(section.getByRole("alert")).toContainText("could not be checked");
  await expect(
    section.getByRole("button", { name: "Publish listing", exact: true }),
  ).toBeDisabled();
  await expect(section.getByRole("button", { name: "Remove listing", exact: true })).toBeEnabled();
});
