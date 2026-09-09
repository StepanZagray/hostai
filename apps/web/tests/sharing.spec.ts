import { expect, test, type Page } from "@playwright/test";
import { hostFixture } from "./support/host-fixture";

const model = "fixture-model:small";
const grant = () => ({
  id: "b475df22-52e7-4f2d-89f2-b7b655cae056",
  label: "Visitor",
  model,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  revokedAt: null as string | null,
});
async function accessFixture(page: Page) {
  await hostFixture(page);
  const state = {
    state: "stopped",
    hostLabel: "Local host",
    model: null as string | null,
    guestUrl: null as string | null,
    error: null as string | null,
    grants: [] as ReturnType<typeof grant>[],
  };
  const calls: string[] = [];
  let failRead = false;
  await page.route("**/api/sharing**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "GET")
      return route.fulfill({
        status: failRead ? 503 : 200,
        json: failRead ? { detail: "The gateway is unavailable." } : state,
      });
    calls.push(path);
    if (path.endsWith("/start")) {
      Object.assign(state, route.request().postDataJSON(), {
        state: "local",
        guestUrl: "http://127.0.0.1:8081",
      });
    } else if (path.endsWith("/stop")) state.state = "stopped";
    else if (path.endsWith("/revoke")) state.grants[0].revokedAt = new Date().toISOString();
    else if (path.endsWith("/grants")) {
      const item = grant();
      state.grants.push(item);
      return route.fulfill({
        json: {
          grant: item,
          token: "fixture-secret",
          inviteUrl: "http://127.0.0.1:8081/#access=fixture-secret",
        },
      });
    }
    return route.fulfill({ json: state });
  });
  return {
    state,
    calls,
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
      guest.getByText("Guest access checked. You can send a message.", { exact: true }),
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
