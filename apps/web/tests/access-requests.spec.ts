import { expect, test, type Page } from "@playwright/test";
import { hostFixture } from "./support/host-fixture";

test.skip(!process.env.HOSTAI_GUEST_TEST_URL, "Requires the isolated guest bundle server");
test.afterEach(async ({ page }) => {
  // A reload can still be fetching fonts after the last UI assertion. Finish the
  // fixture's asset handlers before Playwright disposes their API responses.
  await page.unrouteAll({ behavior: "wait" });
});
const id = "6317a5a4-563c-4e36-944c-ea57139051bf";
const intakeId = "73264113-f496-4532-bbd9-944b05337189";
const grantId = "07de6449-095f-42fd-b334-4236cb779d1c";
const model = "fixture-model:small";
const row = () => ({
  version: 1,
  id,
  state: "pending",
  code: "ABC123",
  name: "Fixture guest",
  model,
  channel: "internet",
  expiresInSeconds: 590,
  grantId: null as string | null,
  grantExpiresAt: null as string | null,
  requestedAt: new Date().toISOString(),
});

async function guestFixture(page: Page) {
  const origin = "https://access-request-fixture.example.invalid";
  const source = new URL(process.env.HOSTAI_GUEST_TEST_URL!).origin;
  const state = {
    hello: true,
    row: row(),
    lostSubmit: false,
    submissions: [] as { auth: string; body: Record<string, string> }[],
    cancelCount: 0,
    sessions: 0,
    sessionStatus: 200,
  };
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/" || path.startsWith("/assets/")) {
      // Real built guest assets; only these paths may reach the private bundle server.
      return route.fulfill({ response: await page.request.get(source + path) });
    }
    if (path === "/guest/v1/hello")
      return route.fulfill({
        json: {
          version: 1,
          scope: "temporary-internet",
          requestsAccepted: state.hello,
          intakeId: state.hello ? intakeId : null,
          model: state.hello ? model : null,
          hostLabel: state.hello ? "Fixture host" : null,
        },
      });
    if (path === "/guest/v1/requests") {
      state.submissions.push({
        auth: route.request().headers().authorization,
        body: route.request().postDataJSON(),
      });
      if (state.lostSubmit) {
        state.lostSubmit = false;
        return route.abort("failed");
      }
      return route.fulfill({ json: state.row });
    }
    if (path === "/guest/v1/requests/self") return route.fulfill({ json: state.row });
    if (path === "/guest/v1/requests/self/cancel") {
      state.cancelCount++;
      state.row.state = "cancelled";
      return route.fulfill({ json: state.row });
    }
    if (path === "/guest/v1/session") {
      state.sessions++;
      return route.fulfill({
        status: state.sessionStatus,
        json: {
          hostLabel: "Fixture host",
          model,
          scope: "temporary-internet",
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          available: true,
          unavailableReason: null,
          maxConcurrentGuests: 1,
          maxTokens: 1024,
          requestsPerMinute: 6,
        },
      });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  return { state, origin };
}

test("guest retries an uncertain submission with the same credential and can cancel", async ({
  page,
}) => {
  const { state, origin } = await guestFixture(page);
  state.lostSubmit = true;
  await page.goto(origin);
  await page.getByLabel("Your name", { exact: true }).fill("Fixture guest");
  await page.getByRole("button", { name: "Request access", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry same request", exact: true })).toBeEnabled();
  await page.screenshot({
    path: "test-results/access-requests-guest-uncertain.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Retry same request", exact: true }).click();
  await expect(
    page.getByText("Waiting for the host to review your request.", { exact: true }),
  ).toBeVisible();
  expect(state.submissions).toHaveLength(2);
  expect(state.submissions[0]).toEqual(state.submissions[1]);
  expect(state.submissions[0].auth).toMatch(/^Bearer hgq1\.[A-Za-z0-9_-]{43}$/);
  expect(Object.keys(state.submissions[0].body).sort()).toEqual([
    "accessCommitment",
    "intakeId",
    "model",
    "name",
  ]);
  expect(state.submissions[0].body.accessCommitment).toMatch(/^[0-9a-f]{64}$/);
  await page.getByRole("button", { name: "Cancel request / access", exact: true }).click();
  await expect(
    page.getByText("The host confirmed cancellation. This request no longer permits access.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(state.cancelCount).toBe(1);
  await page.reload();
  expect(state.submissions).toHaveLength(2);
  await expect(page.getByLabel("Your name", { exact: true })).toHaveValue("");
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test("approved guest can connect after intake closes without silently cancelling permission", async ({
  page,
}) => {
  const { state, origin } = await guestFixture(page);
  await page.goto(origin);
  await page.getByLabel("Your name", { exact: true }).fill("Fixture guest");
  await page.getByRole("button", { name: "Request access", exact: true }).click();
  await expect(
    page.getByText("Waiting for the host to review your request.", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/guest-onboarding-pending.png", fullPage: true });
  state.row = {
    ...state.row,
    state: "approved",
    grantId,
    grantExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(page.getByRole("button", { name: "Connect to model", exact: true })).toBeEnabled();
  await page.screenshot({ path: "test-results/guest-onboarding-approved.png", fullPage: true });
  state.hello = false;
  await page.getByRole("button", { name: "Refresh host details", exact: true }).click();
  await expect(page.getByRole("button", { name: "Connect to model", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Connect to model", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeEnabled();
  expect(state.cancelCount).toBe(0);
  expect(state.submissions).toHaveLength(1);
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByRole("button", { name: "Connect to model", exact: true })).toHaveCount(0);
  expect(state.cancelCount).toBe(0);
});

test("host sees explicit permission choice, full capacity and recoverable status failure", async ({
  page,
}) => {
  await hostFixture(page);
  let failRead = false;
  const state = {
    state: "local",
    hostLabel: "Fixture host",
    model,
    guestUrl: "http://127.0.0.1:8081",
    error: null,
    grants: [],
    internet: {
      state: "live",
      provider: "cloudflare-quick",
      available: true,
      publicUrl: "https://fixture.trycloudflare.com",
      checkedAt: new Date().toISOString(),
      error: null,
    },
    requests: {
      enabled: true,
      available: true,
      intakeId,
      remainingGrantSlots: 100,
      remainingRequestSlots: 20,
      items: [row()],
    },
  };
  await page.route("**/api/sharing", (route) =>
    route.fulfill({
      status: failRead ? 503 : 200,
      json: failRead ? { detail: "Fixture status unavailable" } : state,
    }),
  );
  await page.goto("/sharing");
  const inbox = page.getByRole("region", { name: "Guest access requests", exact: true });
  await expect(inbox.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await inbox.getByLabel(/^Access duration for Fixture guest/).selectOption("24");
  await expect(inbox.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
  state.requests.available = false;
  state.requests.remainingGrantSlots = 0;
  await inbox.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(inbox.getByText(/The 100 retained key limit is reached/)).toBeVisible();
  await expect(inbox.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await expect(inbox.getByRole("button", { name: "Reject", exact: true })).toBeEnabled();
  await page.setViewportSize({ width: 320, height: 1100 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await inbox.screenshot({ path: "test-results/access-requests-owner-full-320.png" });
  failRead = true;
  await inbox.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(inbox.getByText("Request status needs attention", { exact: true })).toBeVisible();
  await expect(inbox.getByRole("button", { name: "Reject", exact: true })).toBeDisabled();
  await expect(inbox.getByRole("button", { name: "Stop requests", exact: true })).toBeEnabled();
  failRead = false;
  state.requests.items = [];
  state.requests.remainingGrantSlots = 100;
  state.requests.available = true;
  await inbox.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(inbox.getByText(/No pending requests/)).toBeVisible();
});

for (const width of [320, 768, 1024, 1440]) {
  test(`public onboarding at ${width}px prioritizes requests and supports keyboard key entry`, async ({
    page,
  }) => {
    const { state, origin } = await guestFixture(page);
    await page.setViewportSize({ width, height: 1100 });
    await page.goto(origin);
    const name = page.getByLabel("Your name", { exact: true });
    const key = page.getByLabel("Access key", { exact: true });
    await expect(name).toBeVisible();
    await expect(key).toBeHidden();
    await expect(
      page.locator("summary").filter({ hasText: "Have an access key?" }),
    ).toBeInViewport();
    await expect(page.getByRole("region", { name: "Conversation", exact: true })).toHaveCount(0);
    await expect(page.getByRole("form", { name: "Message composer" })).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
    await expect(page.locator("#guest-disclosure")).toContainText("name and request credentials");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `test-results/guest-onboarding-${width}.png`, fullPage: true });
    const alternate = page.locator("summary").filter({ hasText: "Have an access key?" });
    await alternate.focus();
    await alternate.press("Enter");
    await page.keyboard.press("Tab");
    await expect(key).toBeFocused();
    await key.fill("fixture-manual-key");
    await key.press("Enter");
    await expect(page.getByLabel("Message", { exact: true })).toBeFocused();
    await expect(
      page.getByText("Guest access checked. You can send a message.", { exact: true }),
    ).toBeVisible();
    expect(state.sessions).toBe(1);
    expect(state.submissions).toHaveLength(0);
    await page.getByRole("button", { name: "Use another key", exact: true }).click();
    await expect(key).toBeVisible();
    await expect(key).toBeFocused();
    await expect(name).toHaveCount(0);
  });
}

test("public host without request intake shows its key form directly", async ({ page }) => {
  const { state, origin } = await guestFixture(page);
  state.hello = false;
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(origin);
  await expect(page.getByText(/This host is not accepting access requests/)).toBeVisible();
  const key = page.getByLabel("Access key", { exact: true });
  await expect(key).toBeVisible();
  await expect(page.getByLabel("Your name", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("form", { name: "Message composer" })).toHaveCount(0);
  await key.fill("fixture-manual-key");
  await page.screenshot({ path: "test-results/guest-onboarding-invite-only.png", fullPage: true });
  await key.press("Enter");
  await expect(page.getByLabel("Message", { exact: true })).toBeFocused();
  expect(state.submissions).toHaveLength(0);
  expect(state.sessions).toBe(1);
});

test("host intake changes preserve a manually entered key without submitting it", async ({
  page,
}) => {
  const { state, origin } = await guestFixture(page);
  await page.goto(origin);
  await expect(page.getByLabel("Your name", { exact: true })).toBeVisible();
  await page.locator("summary").filter({ hasText: "Have an access key?" }).click();
  const key = page.getByLabel("Access key", { exact: true });
  await key.fill("fixture-key-in-progress");
  state.hello = false;
  await page.getByRole("button", { name: "Refresh host details", exact: true }).click();
  await expect(page.getByText(/This host is not accepting access requests/)).toBeVisible();
  await expect(key).toBeVisible();
  await expect(key).toHaveValue("fixture-key-in-progress");
  state.hello = true;
  await page.getByRole("button", { name: "Refresh host details", exact: true }).click();
  await expect(page.getByLabel("Your name", { exact: true })).toBeVisible();
  await expect(key).toBeVisible();
  await expect(key).toHaveValue("fixture-key-in-progress");
  expect(state.sessions).toBe(0);
  expect(state.submissions).toHaveLength(0);
});

test("rechecking an invalid public key keeps the request disclosure and recovery available", async ({
  page,
}) => {
  const { state, origin } = await guestFixture(page);
  await page.goto(origin + "#access=fixture-original-key");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("Keep my draft");
  state.sessionStatus = 401;
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("A valid access key is required");
  await expect(page.getByLabel("Your name", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Access key", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keep my draft");
  await expect(page.locator("#guest-disclosure")).toContainText("name and request credentials");
  expect(state.submissions).toHaveLength(0);
});
