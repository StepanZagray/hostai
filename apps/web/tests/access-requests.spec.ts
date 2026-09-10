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
    lostCancel: false,
    cancelStatus: 200,
    cancelState: "cancelled",
    holdCancel: false,
    releaseCancel: null as (() => void) | null,
    submissions: [] as { auth: string; body: Record<string, string> }[],
    cancelCount: 0,
    sessions: 0,
    sessionKeys: [] as string[],
    sessionStatus: 200,
    chatKeys: [] as string[],
    socketClosed: 0,
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
      if (state.holdCancel)
        await new Promise<void>((resolve) => {
          state.releaseCancel = resolve;
        });
      if (state.lostCancel) {
        state.lostCancel = false;
        return route.abort("failed");
      }
      if (state.cancelStatus !== 200)
        return route.fulfill({ status: state.cancelStatus, json: {} });
      state.row.state = state.cancelState;
      return route.fulfill({ json: state.row });
    }
    if (path === "/guest/v1/session") {
      state.sessions++;
      state.sessionKeys.push(route.request().headers().authorization.slice(7));
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
  await page.routeWebSocket(
    `${origin.replace("https:", "wss:")}/guest/v1/chat-stream`,
    (socket) => {
      socket.onMessage((message) => {
        state.chatKeys.push(JSON.parse(String(message)).key);
        socket.send(JSON.stringify({ content: "An answer in progress", done: false }));
      });
      socket.onClose(() => {
        state.socketClosed++;
      });
    },
  );
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
  await expect(page.getByRole("button", { name: "Connect to model", exact: true })).toBeEnabled();
  expect(state.cancelCount).toBe(0);
  await page.getByRole("button", { name: "Cancel request / access", exact: true }).click();
  await expect(
    page.getByText("The host confirmed cancellation. This request no longer permits access.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(state.cancelCount).toBe(1);
  expect(state.submissions).toHaveLength(1);
});

async function requestedConnection(page: Page, seconds = 590) {
  const fixture = await guestFixture(page);
  fixture.state.row = {
    ...fixture.state.row,
    state: "approved",
    grantId,
    grantExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    expiresInSeconds: seconds,
  };
  await page.goto(fixture.origin);
  await page.getByLabel("Your name", { exact: true }).fill("Fixture guest");
  await page.getByRole("button", { name: "Request access", exact: true }).click();
  await page.getByRole("button", { name: "Connect to model", exact: true }).click();
  await expect(page.getByLabel("Message", { exact: true })).toBeEnabled();
  return fixture;
}

for (const width of [320, 1440])
  test(`connected cancellation preserves drafts and survives disconnect at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const { state } = await requestedConnection(page);
    await expect(page.locator("#guest-disclosure")).toContainText("name and request credentials");
    await page.getByLabel("Message", { exact: true }).fill("Draft before same-key check");
    await page.getByRole("button", { name: "Use another key", exact: true }).click();
    await page.getByLabel("Access key", { exact: true }).fill(` ${state.sessionKeys[0]} `);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
      "Draft before same-key check",
    );
    await page.getByLabel("Message", { exact: true }).fill("Question before cancellation");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByText("An answer in progress", { exact: true })).toBeVisible();
    await page.getByLabel("Message", { exact: true }).fill("Keep my next draft");
    await page.getByText("Manage access request", { exact: true }).focus();
    await page.keyboard.press("Enter");
    state.lostCancel = true;
    await page.getByRole("button", { name: "Cancel request / access", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Retry cancellation", exact: true }),
    ).toBeEnabled();
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeDisabled();
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keep my next draft");
    await expect(page.getByText("An answer in progress", { exact: true })).toBeVisible();
    await expect.poll(() => state.socketClosed).toBe(1);
    await page.getByRole("button", { name: "Use another key", exact: true }).click();
    await page.getByLabel("Access key", { exact: true }).fill(` ${state.chatKeys[0]} `);
    await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Keep current access", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Retry cancellation", exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: `test-results/guest-cancel-connected-${width}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(page.getByLabel("Message", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Retry cancellation", exact: true }),
    ).toBeEnabled();
    expect(state.cancelCount).toBe(1);
    await page.getByText("Have an access key?", { exact: true }).click();
    await page.getByLabel("Access key", { exact: true }).fill(` ${state.sessionKeys[0]} `);
    await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Retry cancellation", exact: true }).click();
    await expect(
      page.getByText("The host confirmed cancellation. This request no longer permits access.", {
        exact: true,
      }),
    ).toBeVisible();
    expect(state.cancelCount).toBe(2);
    expect(state.chatKeys).toHaveLength(1);
    expect(state.submissions).toHaveLength(1);
    expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  });

test("disconnect keeps an in-flight cancellation alive until its response arrives", async ({
  page,
}) => {
  const { state } = await requestedConnection(page);
  state.holdCancel = true;
  await page.getByText("Manage access request", { exact: true }).click();
  try {
    await page.getByRole("button", { name: "Cancel request / access", exact: true }).click();
    await expect.poll(() => !!state.releaseCancel).toBe(true);
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(
      page.getByText("Asking the host to cancel or revoke access…", { exact: true }),
    ).toBeVisible();
    state.releaseCancel!();
    await expect(
      page.getByText("The host confirmed cancellation. This request no longer permits access.", {
        exact: true,
      }),
    ).toBeVisible();
    expect(state.cancelCount).toBe(1);
    expect(state.sessions).toBe(1);
  } finally {
    state.releaseCancel?.();
  }
});

test("a missing recovery record never claims revocation or discards the request", async ({
  page,
}) => {
  const { state } = await requestedConnection(page, 1);
  await page.getByText("Manage access request", { exact: true }).click();
  await expect(page.getByText(/This browser’s request recovery timer has ended/)).toBeVisible();
  state.cancelStatus = 404;
  await page.getByRole("button", { name: "Try cancellation", exact: true }).click();
  await expect(
    page.getByText(/Cancellation could not be confirmed on this connection/),
  ).toBeVisible();
  await expect(page.getByText(/Ask the host to revoke this key in Access keys/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeDisabled();
  await page.screenshot({
    path: "test-results/guest-cancel-record-missing.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry cancellation", exact: true })).toBeVisible();
  expect(state.cancelCount).toBe(1);
  expect(state.submissions).toHaveLength(1);
});

test("cancelling an earlier request does not pause chat using a different key", async ({
  page,
}) => {
  const { state } = await requestedConnection(page);
  await page.getByRole("button", { name: "Use another key", exact: true }).click();
  await page.getByLabel("Access key", { exact: true }).fill("another-fixture-key");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByLabel("Message", { exact: true }).fill("Question using another key");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("An answer in progress", { exact: true })).toBeVisible();
  await page.getByText("Manage access request", { exact: true }).click();
  await expect(page.getByText(/Cancelling it does not revoke that other key/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel request / access", exact: true }).click();
  await expect(
    page.getByText("The host confirmed cancellation. This request no longer permits access.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  expect(state.socketClosed).toBe(0);
  expect(state.chatKeys).toEqual(["another-fixture-key"]);
  await page.getByText("Manage access request", { exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Last request status: cancelled" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
});

test("a failed cancellation outcome never claims the key was revoked", async ({ page }) => {
  const { state } = await requestedConnection(page);
  state.cancelState = "failed";
  await page.getByText("Manage access request", { exact: true }).click();
  await page.getByRole("button", { name: "Cancel request / access", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "The host could not confirm this request’s access",
  );
  await expect(page.getByText(/The host ended this request’s access/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Discard this request…", exact: true }).click();
  await expect(
    page.getByText(/The host has not confirmed that this request’s key was revoked/),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/guest-cancel-failed-discard.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Keep this request", exact: true }).click();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(
    page.getByText(/This failure does not confirm that the approved key was revoked/),
  ).toBeVisible();
  expect(state.cancelCount).toBe(1);
});

test("a replacement request cannot inherit the previous request’s chat-key association", async ({
  page,
}) => {
  const { state } = await requestedConnection(page);
  await page.getByLabel("Message", { exact: true }).fill("Draft belonging to the first key");
  await page.getByText("Manage access request", { exact: true }).click();
  await page.getByRole("button", { name: "Discard this request…", exact: true }).click();
  await page.getByRole("button", { name: "Discard and refresh details", exact: true }).click();
  state.sessionStatus = 401;
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page.getByLabel("Access key", { exact: true })).toBeVisible();
  state.row = { ...row(), id: "8437c606-1b63-4c9d-9e65-50d18f98acbd" };
  await page.getByLabel("Your name", { exact: true }).fill("Fixture guest");
  await page.getByRole("button", { name: "Request access", exact: true }).click();
  await expect(
    page.getByText("Waiting for the host to review your request.", { exact: true }),
  ).toBeVisible();
  state.row.state = "rejected";
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(page.getByText("The host declined this request.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Access key", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeEnabled();
  await expect(page.getByText(/The host ended this request’s access/)).toHaveCount(0);
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
    "Draft belonging to the first key",
  );
  await page.getByRole("button", { name: "Start another request", exact: true }).click();
  state.row = {
    ...row(),
    id: "8c79e7e3-18d0-4337-a7c9-037b5a5939b1",
    state: "approved",
    grantId: "f106c10b-efae-412c-a567-593550d2c138",
    grantExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  await page.getByLabel("Your name", { exact: true }).fill("Fixture guest");
  await page.getByRole("button", { name: "Request access", exact: true }).click();
  await expect(page.getByRole("button", { name: "Connect to model", exact: true })).toBeEnabled();
  state.sessionStatus = 200;
  await page.getByRole("button", { name: "Connect to model", exact: true }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
  await page.getByText("Manage access request", { exact: true }).click();
  await page.getByRole("button", { name: "Cancel request / access", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeDisabled();
  expect(state.submissions).toHaveLength(3);
  expect(state.cancelCount).toBe(1);
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
