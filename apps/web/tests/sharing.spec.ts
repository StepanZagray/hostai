import { expect, test, type Page } from "@playwright/test";
import {
  model,
  grant,
  derivedGrant,
  keyToken,
  secret,
  publicOrigin,
  accessFixture,
  publishLocal,
  publishInternet,
  type SharingTestWindow,
} from "./support/sharing-fixture";

const hostingRegion = (page: Page) =>
  page.getByRole("region", { name: "Internet hosting", exact: true });
const keysRegion = (page: Page) => page.getByRole("region", { name: "Access keys", exact: true });
/** The hosting state sentence: the first thing the hosting panel says. */
const hostingStatus = (page: Page) => hostingRegion(page).getByRole("status").first();
/** The whole key control: label, the masked stand-in or the revealed field, and its buttons. */
const keyGroup = (page: Page, label: string) =>
  page.getByRole("group", { name: `Access key for ${label}`, exact: true });
/** The readonly field only exists between Show key and Hide key. */
const keyField = (page: Page, label: string) =>
  page.getByRole("textbox", { name: `Access key for ${label}, visible`, exact: true });
/** What stands in for the key the rest of the time. */
const maskedKey = (page: Page, label: string) => keyGroup(page, label).locator("p");
const masked = "•".repeat(24);
const copyKey = (page: Page, label: string) =>
  page.getByRole("button", { name: `Copy key ${label}`, exact: true });
const copyStatus = (page: Page, label: string) => keyGroup(page, label).getByRole("status");
const showKey = (page: Page, label: string) =>
  page.getByRole("button", { name: `Show key ${label}`, exact: true });
const hideKey = (page: Page, label: string) =>
  page.getByRole("button", { name: `Hide key ${label}`, exact: true });
/** Every stored key is masked until asked for, so the field is absent and the buttons are not. */
async function expectMasked(page: Page, label: string) {
  await expect(keyField(page, label)).toHaveCount(0);
  await expect(maskedKey(page, label)).toHaveText(masked);
  await expect(copyKey(page, label)).toBeVisible();
  await expect(showKey(page, label)).toHaveAttribute("aria-pressed", "false");
  expect(await keyOnScreen(page)).toEqual(keyHidden);
}
const addressQr = (page: Page) =>
  page.getByRole("img", { name: "QR code for the guest page address", exact: true });
const connectQr = (page: Page, label: string) =>
  page.getByRole("img", {
    name: `QR code that opens the guest page with the key for ${label}`,
    exact: true,
  });

async function refreshAccess(page: Page) {
  await page.getByRole("button", { name: "Refresh access", exact: true }).click();
  await expect(page.getByRole("button", { name: "Refresh access", exact: true })).toBeEnabled();
}

/**
 * Server-rendered controls look interactive before React attaches, and anything typed into them
 * until then is silently discarded. The opening status line only clears once the client has taken
 * over and read the gateway, so it is the gate every interaction waits behind.
 */
async function attached(page: Page) {
  await expect(page.getByText("Checking guest access\u2026", { exact: true })).toHaveCount(0);
}
async function openSharing(page: Page, url = "/sharing") {
  await page.goto(url);
  await attached(page);
}

/**
 * A revealed key is deliberately on screen, so screen presence is asserted explicitly.
 * Everything here must stay false whether or not the host asked to see a key.
 */
async function keyLeaks(page: Page) {
  return page.evaluate(
    (needle) => ({
      url: location.href.includes(needle),
      title: document.title.includes(needle),
      localStorage: JSON.stringify({ ...localStorage }).includes(needle),
      sessionStorage: JSON.stringify({ ...sessionStorage }).includes(needle),
    }),
    secret,
  );
}
const noLeak = { url: false, title: false, localStorage: false, sessionStorage: false };

/** Where a key legitimately appears once the host clicks Show key, and nowhere before that. */
async function keyOnScreen(page: Page) {
  return page.evaluate(
    (needle) => ({
      markup: document.documentElement.outerHTML.includes(needle),
      fields: [...document.querySelectorAll("input, textarea")].some((element) =>
        (element as HTMLInputElement).value.includes(needle),
      ),
    }),
    secret,
  );
}
const keyHidden = { markup: false, fields: false };

test("the model library leads to hosting, a readable key and a durable revoke", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  await page.goto("/models");
  await page.getByRole("link", { name: "Set up guest access", exact: true }).click();
  await attached(page);
  await expect(page.getByLabel("Model for guests")).toHaveValue(model);
  expect(await keyOnScreen(page)).toEqual(keyHidden);
  await page.getByRole("button", { name: "Start hosting", exact: true }).click();
  await expect(hostingStatus(page)).toHaveText("Starting hosting…");
  publishInternet(fixture);
  await refreshAccess(page);
  await expect(hostingStatus(page)).toHaveText("Hosting is live");
  await page.getByLabel("Key label", { exact: true }).fill("Visitor");
  await page.getByRole("button", { name: "Create key", exact: true }).click();
  // Creating a key does not reveal it; it joins the list masked like every other key.
  await expectMasked(page, "Visitor");
  await expect(page.getByLabel("Key label", { exact: true })).toHaveValue("");
  await showKey(page, "Visitor").click();
  await expect(keyField(page, "Visitor")).toHaveValue(keyToken());
  expect((await keyOnScreen(page)).fields).toBe(true);
  expect(await keyLeaks(page)).toEqual(noLeak);
  await page.screenshot({ path: "test-results/sharing-live-key.png", fullPage: true });
  await page.getByRole("button", { name: "Revoke Visitor", exact: true }).click();
  await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
  await expect(keyField(page, "Visitor")).toHaveCount(0);
  await expect(keyGroup(page, "Visitor")).toHaveCount(0);
  expect(await keyOnScreen(page)).toEqual(keyHidden);
  expect(fixture.calls).toEqual([
    "/api/sharing/start",
    "/api/sharing/internet/start",
    "/api/sharing/grants",
    `/api/sharing/grants/${grant().id}/key`,
    `/api/sharing/grants/${grant().id}/revoke`,
  ]);
  await page.getByRole("button", { name: "Stop hosting", exact: true }).click();
  await expect(hostingStatus(page)).toHaveText("Hosting is off");
  await page.reload();
  await attached(page);
  await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
  expect(await keyOnScreen(page)).toEqual(keyHidden);
  expect(await keyLeaks(page)).toEqual(noLeak);
});

test("a new key is never rendered, and copying hands over the key it never showed", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  publishInternet(fixture);
  await openSharing(page);
  await page.getByLabel("Key label", { exact: true }).fill("Never shown");
  await page.getByRole("button", { name: "Create key", exact: true }).click();
  const group = keyGroup(page, "Never shown");
  await expect(group).toBeVisible();
  await expect(group).toContainText("Access key");
  // The key exists but was never rendered: the stand-in echoes no part of it.
  await expectMasked(page, "Never shown");
  const placeholder = (await maskedKey(page, "Never shown").textContent()) ?? "";
  expect(placeholder).toBe(masked);
  expect(placeholder).not.toContain(secret);
  expect(placeholder).not.toContain(grant().id);
  expect(await page.evaluate(() => document.documentElement.outerHTML.includes("hga1."))).toBe(
    false,
  );
  await expect(connectQr(page, "Never shown")).toHaveCount(0);
  // Copying reads the real key over the wire and puts it only on the clipboard.
  await copyKey(page, "Never shown").click();
  await expect(copyStatus(page, "Never shown")).toHaveText("Copied");
  await expect
    .poll(() => page.evaluate(() => (window as SharingTestWindow).sharingCopies))
    .toEqual([keyToken()]);
  await expectMasked(page, "Never shown");
  await expect(connectQr(page, "Never shown")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.outerHTML.includes("hga1."))).toBe(
    false,
  );
  expect(await keyLeaks(page)).toEqual(noLeak);
  // Only an explicit unmask puts it in the document, and hiding takes it back out.
  await showKey(page, "Never shown").click();
  await expect(keyField(page, "Never shown")).toHaveValue(keyToken());
  await expect(maskedKey(page, "Never shown")).toHaveCount(0);
  expect((await keyOnScreen(page)).fields).toBe(true);
  await hideKey(page, "Never shown").click();
  await expectMasked(page, "Never shown");
  expect(await keyLeaks(page)).toEqual(noLeak);
  expect(fixture.calls).toEqual([
    "/api/sharing/grants",
    `/api/sharing/grants/${grant().id}/key`,
    `/api/sharing/grants/${grant().id}/key`,
  ]);
});

test("an existing key can be looked up again and hidden without leaving a trace", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  publishInternet(fixture);
  fixture.state.grants.push(grant("internet"));
  await openSharing(page);
  await expect(showKey(page, "Visitor")).toBeEnabled();
  await expectMasked(page, "Visitor");
  await showKey(page, "Visitor").click();
  await expect(keyField(page, "Visitor")).toHaveValue(keyToken());
  await expect(maskedKey(page, "Visitor")).toHaveCount(0);
  await expect(hideKey(page, "Visitor")).toHaveAttribute("aria-pressed", "true");
  await expect(keysRegion(page)).toContainText(
    "This image carries the key. It opens the guest page with the key already filled in, so a phone guest does not retype it.",
  );
  expect((await keyOnScreen(page)).fields).toBe(true);
  expect(await keyLeaks(page)).toEqual(noLeak);
  await hideKey(page, "Visitor").click();
  await expectMasked(page, "Visitor");
  await expect(showKey(page, "Visitor")).toBeVisible();
  // Hiding is local; only the explicit reveal reaches the gateway.
  expect(fixture.calls).toEqual([`/api/sharing/grants/${grant().id}/key`]);
});

test("a request-approved key can be revoked but never shown again", async ({ page }) => {
  const fixture = await accessFixture(page);
  publishInternet(fixture);
  fixture.state.grants.push(grant("internet"), derivedGrant());
  await openSharing(page);
  await expect(showKey(page, "Visitor")).toBeVisible();
  // A key the gateway never stored gets no key field at all: nothing to mask, copy or reveal.
  await expect(keyGroup(page, "Approved guest")).toHaveCount(0);
  await expect(copyKey(page, "Approved guest")).toHaveCount(0);
  await expect(showKey(page, "Approved guest")).toHaveCount(0);
  await expect(keysRegion(page)).toContainText(
    "This guest generated its own key after you approved the request, so the gateway never stored it. Revoke it to end its permission.",
  );
  const revoke = page.getByRole("button", { name: "Revoke Approved guest", exact: true });
  await expect(revoke).toBeEnabled();
  await revoke.click();
  await expect(revoke).toHaveCount(0);
  await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
  expect(await keyOnScreen(page)).toEqual(keyHidden);
  expect(fixture.calls).toEqual([`/api/sharing/grants/${derivedGrant().id}/revoke`]);
});

test("revoking a key that is on screen removes its text at once", async ({ page }) => {
  const fixture = await accessFixture(page);
  publishInternet(fixture);
  fixture.state.grants.push(grant("internet"));
  await openSharing(page);
  await showKey(page, "Visitor").click();
  await expect(keyField(page, "Visitor")).toHaveValue(keyToken());
  await expect(connectQr(page, "Visitor")).toBeVisible();
  await page.getByRole("button", { name: "Revoke Visitor", exact: true }).click();
  await expect(keyField(page, "Visitor")).toHaveCount(0);
  await expect(connectQr(page, "Visitor")).toHaveCount(0);
  await expect(keyGroup(page, "Visitor")).toHaveCount(0);
  await expect(copyKey(page, "Visitor")).toHaveCount(0);
  await expect(showKey(page, "Visitor")).toHaveCount(0);
  expect(await keyOnScreen(page)).toEqual(keyHidden);
  expect(fixture.calls).toEqual([
    `/api/sharing/grants/${grant().id}/key`,
    `/api/sharing/grants/${grant().id}/revoke`,
  ]);
});

test("a key the gateway cannot return is reported instead of half revealed", async ({ page }) => {
  const fixture = await accessFixture(page);
  publishInternet(fixture);
  fixture.state.grants.push(grant("internet"));
  fixture.response.token = "";
  await openSharing(page);
  await showKey(page, "Visitor").click();
  await expect(
    page.getByRole("alert").filter({ hasText: "That key could not be read" }),
  ).toContainText("That key could not be read. Refresh access and try again.");
  // A failed read leaves the mask exactly as it was rather than a half-filled field.
  await expectMasked(page, "Visitor");
  await expect(showKey(page, "Visitor")).toBeEnabled();
  expect(fixture.calls).toEqual([`/api/sharing/grants/${grant().id}/key`]);
});

test("a copy the gateway cannot serve reports failure without unmasking", async ({ page }) => {
  const fixture = await accessFixture(page);
  publishInternet(fixture);
  fixture.state.grants.push(grant("internet"));
  fixture.response.token = "";
  await openSharing(page);
  await copyKey(page, "Visitor").click();
  await expect(copyStatus(page, "Visitor")).toHaveText(
    "The key could not be read. Refresh access and try again.",
  );
  await expectMasked(page, "Visitor");
  expect(await page.evaluate(() => (window as SharingTestWindow).sharingCopies)).toEqual([]);
  expect(await keyLeaks(page)).toEqual(noLeak);
  expect(fixture.calls).toEqual([`/api/sharing/grants/${grant().id}/key`]);
});

test("a key can be created and read while the public connection is down", async ({ page }) => {
  const fixture = await accessFixture(page);
  publishLocal(fixture);
  await openSharing(page);
  await expect(hostingStatus(page)).toHaveText("Hosting is off");
  await expect(page.getByText("Not reachable yet", { exact: true })).toBeVisible();
  await expect(hostingRegion(page)).toContainText(
    "This model is being served locally, but it is not reachable from the internet yet.",
  );
  await page.getByLabel("Key label", { exact: true }).fill("Offline visitor");
  await page.getByRole("button", { name: "Create key", exact: true }).click();
  await expectMasked(page, "Offline visitor");
  expect(fixture.bodies.at(-1)).toEqual({
    label: "Offline visitor",
    expiresInHours: 24,
    channel: "internet",
  });
  await showKey(page, "Offline visitor").click();
  await expect(keyField(page, "Offline visitor")).toHaveValue(keyToken());
  await expect(addressQr(page)).toHaveCount(0);
  await expect(connectQr(page, "Offline visitor")).toHaveCount(0);
  await expect(keysRegion(page)).toContainText(
    "Hosting is not reachable from the internet yet. Restore the public address before using this key.",
  );
  await page.getByRole("button", { name: "Try the public connection again", exact: true }).click();
  await expect(hostingStatus(page)).toHaveText("Starting hosting…");
  publishInternet(fixture);
  await refreshAccess(page);
  await expect(hostingStatus(page)).toHaveText("Hosting is live");
  // The key was minted without a tunnel and stays the same key once one exists.
  await expect(keyField(page, "Offline visitor")).toHaveValue(keyToken());
  await expect(connectQr(page, "Offline visitor")).toBeVisible();
  expect(await keyLeaks(page)).toEqual(noLeak);
  expect(fixture.calls).toEqual([
    "/api/sharing/grants",
    `/api/sharing/grants/${grant().id}/key`,
    "/api/sharing/internet/start",
  ]);
});

test("a revealed key outlives the address it was issued under", async ({ page }) => {
  const fixture = await accessFixture(page);
  publishInternet(fixture);
  fixture.state.grants.push(grant("internet"));
  await openSharing(page);
  await expectMasked(page, "Visitor");
  await showKey(page, "Visitor").click();
  await expect(keyField(page, "Visitor")).toHaveValue(keyToken());
  await expect(connectQr(page, "Visitor")).toBeVisible();
  Object.assign(fixture.state.internet!, { state: "interrupted", publicUrl: null });
  await refreshAccess(page);
  await expect(hostingStatus(page)).toHaveText("Hosting is interrupted");
  await expect(hostingRegion(page)).toContainText(
    "The address stays hidden while the connection is unverified.",
  );
  await expect(keyField(page, "Visitor")).toHaveValue(keyToken());
  await expect(connectQr(page, "Visitor")).toHaveCount(0);
  await expect(addressQr(page)).toHaveCount(0);
  await expect(page.getByText("Access paused", { exact: true })).toBeVisible();
  const second = "https://another-fixture.trycloudflare.com";
  Object.assign(fixture.state.internet!, {
    state: "live",
    publicUrl: second,
    checkedAt: new Date().toISOString(),
  });
  await refreshAccess(page);
  await expect(page.getByText(second, { exact: true })).toBeVisible();
  await expect(keyField(page, "Visitor")).toHaveValue(keyToken());
  await expect(connectQr(page, "Visitor")).toBeVisible();
  await expect(page.getByText("Permission active", { exact: true })).toBeVisible();
  expect(await keyLeaks(page)).toEqual(noLeak);
  expect(fixture.calls).toEqual([`/api/sharing/grants/${grant().id}/key`]);
});

test("QR codes appear only for a live address and a revealed key", async ({ page }) => {
  const fixture = await accessFixture(page);
  publishLocal(fixture);
  fixture.state.grants.push(grant("internet"));
  await openSharing(page);
  await expect(addressQr(page)).toHaveCount(0);
  await expect(page.getByText("Scan to open", { exact: true })).toHaveCount(0);
  publishInternet(fixture);
  await refreshAccess(page);
  await expect(page.getByText("Guest page address", { exact: true })).toBeVisible();
  await expect(page.getByText(publicOrigin, { exact: true })).toBeVisible();
  await expect(page.getByText("Scan to open", { exact: true })).toBeVisible();
  await expect(addressQr(page)).toBeVisible();
  expect(await addressQr(page).evaluate((element) => element.tagName.toLowerCase())).toBe("svg");
  // A live address alone does not publish a key: the QR waits for an explicit unmask.
  await expectMasked(page, "Visitor");
  await expect(connectQr(page, "Visitor")).toHaveCount(0);
  await expect(page.getByText("Scan to connect", { exact: true })).toHaveCount(0);
  await showKey(page, "Visitor").click();
  await expect(page.getByText("Scan to connect", { exact: true })).toBeVisible();
  await expect(connectQr(page, "Visitor")).toBeVisible();
  expect(
    await connectQr(page, "Visitor").evaluate((element) => element.tagName.toLowerCase()),
  ).toBe("svg");
  // The image carries the key; the markup around it must not spell it out beyond the field.
  expect((await keyOnScreen(page)).fields).toBe(true);
  await hideKey(page, "Visitor").click();
  await expect(connectQr(page, "Visitor")).toHaveCount(0);
  await expect(page.getByText("Scan to connect", { exact: true })).toHaveCount(0);
  await expectMasked(page, "Visitor");
  await page.getByRole("button", { name: "Copy guest address", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as SharingTestWindow).sharingCopies))
    .toEqual([publicOrigin]);
});

test("stopping and restarting preserves the server's model and host name", async ({ page }) => {
  const other = "another-model:medium";
  const fixture = await accessFixture(page, [model, other]);
  Object.assign(fixture.state, { state: "local", model: other, hostLabel: "My research host" });
  await openSharing(page);
  await expect(
    page.getByRole("link", { name: "Test the shared model", exact: true }),
  ).toHaveAttribute("href", /model=another-model/);
  await page.getByRole("button", { name: "Stop hosting", exact: true }).click();
  await expect(page.getByLabel("Model for guests")).toHaveValue(other);
  await expect(page.getByLabel("Host name shown to guests")).toHaveValue("My research host");
  await page.getByRole("button", { name: "Start hosting", exact: true }).click();
  await expect(hostingStatus(page)).toHaveText("Starting hosting\u2026");
  expect(fixture.bodies[1]).toEqual({ model: other, hostLabel: "My research host" });
  expect(fixture.calls).toEqual([
    "/api/sharing/stop",
    "/api/sharing/start",
    "/api/sharing/internet/start",
  ]);
});

test("a different model handoff is explicit and earlier keys pause until their model returns", async ({
  page,
}) => {
  const other = "another-model:medium";
  const fixture = await accessFixture(page, [model, other]);
  publishInternet(fixture);
  fixture.state.hostLabel = "My research host";
  fixture.state.grants.push(grant("internet"));
  await openSharing(page, `/sharing?model=${encodeURIComponent(other)}`);
  await expect(page.getByText(/You selected another-model:medium to share/)).toBeVisible();
  await expect(page.getByText("Permission active", { exact: true })).toBeVisible();
  expect(fixture.calls).toEqual([]);
  await page.screenshot({
    path: "test-results/sharing-model-handoff.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Stop hosting", exact: true }).click();
  await expect(page.getByLabel("Model for guests")).toHaveValue(other);
  await expect(page.getByText("Access paused", { exact: true })).toBeVisible();
  await expect(keysRegion(page)).toContainText(
    "Hosting is off. This permission resumes when its model is hosted again.",
  );
  await page.getByRole("button", { name: "Start hosting", exact: true }).click();
  await expect(keysRegion(page)).toContainText(
    `This key permits ${model}; hosting currently serves ${other}.`,
  );
  await expect(page.getByText("Access paused", { exact: true })).toBeVisible();
  expect(fixture.state.grants[0].revokedAt).toBeNull();
  await page.setViewportSize({ width: 320, height: 900 });
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: "test-results/sharing-paused-model-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Stop hosting", exact: true }).click();
  await page.getByLabel("Model for guests").selectOption(model);
  await expect.poll(() => new URL(page.url()).searchParams.get("model")).toBe(model);
  await page.getByRole("button", { name: "Start hosting", exact: true }).click();
  await expect(hostingStatus(page)).toHaveText("Starting hosting…");
  publishInternet(fixture);
  await refreshAccess(page);
  await expect(page.getByText("Permission active", { exact: true })).toBeVisible();
  expect(fixture.calls).toEqual([
    "/api/sharing/stop",
    "/api/sharing/start",
    "/api/sharing/internet/start",
    "/api/sharing/stop",
    "/api/sharing/start",
    "/api/sharing/internet/start",
  ]);
});

test("first-time hosting requires a model choice and URL selection preserves an edited name", async ({
  page,
}) => {
  const other = "another-model:medium";
  const fixture = await accessFixture(page, [model, other]);
  await page.setViewportSize({ width: 320, height: 900 });
  await openSharing(page);
  const start = page.getByRole("button", { name: "Start hosting", exact: true });
  await expect(page.getByLabel("Model for guests")).toHaveValue("");
  await expect(page.getByText("Choose the model guests may use.", { exact: true })).toBeVisible();
  await expect(start).toBeDisabled();
  await page.getByLabel("Host name shown to guests").fill("A name I chose");
  const picker = page.getByLabel("Model for guests");
  await picker.evaluate((element) =>
    window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 100),
  );
  await picker.focus();
  const scrollBefore = await page.evaluate(() => window.scrollY);
  expect(scrollBefore).toBeGreaterThan(0);
  await picker.selectOption(other);
  await expect.poll(() => new URL(page.url()).searchParams.get("model")).toBe(other);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(picker).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  await expect(page.getByLabel("Host name shown to guests")).toHaveValue("A name I chose");
  await picker.selectOption(model);
  await expect.poll(() => new URL(page.url()).searchParams.get("model")).toBe(model);
  await expect(page.getByLabel("Host name shown to guests")).toHaveValue("A name I chose");
  await start.click();
  await expect.poll(() => fixture.bodies[0]).toEqual({ model, hostLabel: "A name I chose" });
});

test("a missing linked model stays selected with a recovery path instead of a substitute", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  await openSharing(page, "/sharing?model=removed-model%3Asmall");
  await expect(page.getByLabel("Model for guests")).toHaveValue("removed-model:small");
  await expect(page.getByText(/The selected model is no longer in your library/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Open model library", exact: true })).toHaveAttribute(
    "href",
    "/models",
  );
  await expect(page.getByRole("button", { name: "Start hosting", exact: true })).toBeDisabled();
  await page.getByLabel("Host name shown to guests").press("Enter");
  expect(fixture.calls).toEqual([]);
  await page.screenshot({
    path: "test-results/sharing-missing-model.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByLabel("Model for guests").selectOption(model);
  await page.getByRole("button", { name: "Start hosting", exact: true }).click();
  await expect.poll(() => fixture.bodies[0]?.model).toBe(model);
});

test("an empty library and a failed discovery explain why hosting cannot start", async ({
  page,
}) => {
  const fixture = await accessFixture(page, []);
  await openSharing(page);
  await expect(page.getByText(/No model has a supported interface/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Start hosting", exact: true })).toBeDisabled();
  await page.route("**/api/models", (route) =>
    route.fulfill({ status: 503, json: { detail: "Unavailable" } }),
  );
  await page.getByRole("button", { name: "Check model library", exact: true }).click();
  await expect(page.getByText(/The runtime and model library could not be checked/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Start hosting", exact: true })).toBeDisabled();
  expect(fixture.calls).toEqual([]);
});

test("keys distinguish paused reachability from unconfirmed status", async ({ page }) => {
  const fixture = await accessFixture(page);
  publishInternet(fixture);
  fixture.state.grants.push(grant("internet"));
  await openSharing(page);
  await expect(page.getByText("Permission active", { exact: true })).toBeVisible();
  fixture.state.internet!.state = "interrupted";
  await refreshAccess(page);
  await expect(page.getByText("Access paused", { exact: true })).toBeVisible();
  await expect(keysRegion(page)).toContainText(
    "Hosting is not reachable from the internet yet. Restore the public address before using this key.",
  );
  fixture.failRead();
  await refreshAccess(page);
  await expect(page.getByText("Status unknown", { exact: true })).toBeVisible();
  await expect(page.getByText("Hosting status is out of date", { exact: true })).toBeVisible();
  await expect(keysRegion(page)).toContainText(
    "Refresh access to check this key’s current availability.",
  );
  await expect(page.getByRole("button", { name: "Revoke Visitor", exact: true })).toBeEnabled();
  await expect(showKey(page, "Visitor")).toBeDisabled();
  await expect(copyKey(page, "Visitor")).toBeDisabled();
  await expect(maskedKey(page, "Visitor")).toHaveText(masked);
  expect(fixture.calls).toEqual([]);
});

test("a host-name draft follows the model test round trip and evidence follows the conversation", async ({
  page,
}) => {
  const other = "another-model:medium";
  const fixture = await accessFixture(page, [model, other]);
  let chats = 0;
  await page.route("**/api/chat", (route) => {
    chats++;
    return route.fulfill({
      contentType: "application/x-ndjson",
      body: JSON.stringify({ content: "A completed test answer", done: true }) + "\n",
    });
  });
  await openSharing(page, `/sharing?model=${encodeURIComponent(model)}`);
  const start = page.getByRole("button", { name: "Start hosting", exact: true });
  await expect(start).toBeEnabled();
  await expect(
    page.getByText("No completed answer for this model in this tab.", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Host name shown to guests").fill("  My tested host  ");
  await page.getByRole("link", { name: "Test model in playground", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveValue(model);
  expect(chats).toBe(0);
  expect(fixture.calls).toEqual([]);
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Test this selected model");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("A completed test answer", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Set up guest access", exact: true }).click();
  await attached(page);
  await expect(page.getByLabel("Host name shown to guests")).toHaveValue("  My tested host  ");
  await expect(
    page.getByText("This model answered a prompt in this tab.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/does not prove current availability or memory fit/)).toBeVisible();
  expect(fixture.calls).toEqual([]);
  await hostingRegion(page).screenshot({
    path: "test-results/sharing-tested-draft.png",
    animations: "disabled",
  });
  await page.getByLabel("Model for guests").selectOption(other);
  await expect(
    page.getByText("No completed answer for this model in this tab.", { exact: true }),
  ).toBeVisible();
  await expect(start).toBeEnabled();
  await page.getByLabel("Model for guests").selectOption(model);
  await expect(
    page.getByText("This model answered a prompt in this tab.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Test model in playground", exact: true }).click();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await page.goBack();
  await attached(page);
  await expect(
    page.getByText("No completed answer for this model in this tab.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Host name shown to guests")).toHaveValue("  My tested host  ");
  await start.click();
  await expect(hostingStatus(page)).toHaveText("Starting hosting…");
  await expect(page.getByRole("button", { name: "Discard name draft", exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Stop hosting", exact: true }).click();
  await expect(page.getByLabel("Host name shown to guests")).toHaveValue("My tested host");
  fixture.state.hostLabel = "New server name";
  await refreshAccess(page);
  await expect(page.getByLabel("Host name shown to guests")).toHaveValue("New server name");
  expect(chats).toBe(1);
  expect(fixture.calls).toEqual([
    "/api/sharing/start",
    "/api/sharing/internet/start",
    "/api/sharing/stop",
  ]);
});

test("draft reset follows the latest server name, while empty edits survive navigation and reload clears them", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  await page.setViewportSize({ width: 320, height: 900 });
  await openSharing(page, `/sharing?model=${encodeURIComponent(model)}`);
  const name = page.getByLabel("Host name shown to guests");
  await name.fill("A private name draft");
  fixture.state.hostLabel = "Name changed elsewhere";
  await refreshAccess(page);
  await expect(name).toHaveValue("A private name draft");
  await page.getByRole("link", { name: "Test model in playground", exact: true }).click();
  await page.goBack();
  await attached(page);
  await expect(name).toHaveValue("A private name draft");
  await hostingRegion(page).screenshot({
    path: "test-results/sharing-name-draft-mobile.png",
    animations: "disabled",
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Discard name draft", exact: true }).click();
  await expect(name).toHaveValue("Name changed elsewhere");
  await expect(name).toBeFocused();
  await name.fill("");
  await page.getByRole("link", { name: "Test model in playground", exact: true }).click();
  await page.goBack();
  await attached(page);
  await expect(name).toHaveValue("");
  await expect(page.getByRole("button", { name: "Start hosting", exact: true })).toBeDisabled();
  await name.fill("A private name draft");
  expect(
    await page.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    ),
  ).not.toContain("A private name draft");
  await page.reload();
  await attached(page);
  await expect(name).toHaveValue("Name changed elsewhere");
  await expect(page.getByRole("button", { name: "Discard name draft", exact: true })).toHaveCount(
    0,
  );
  expect(fixture.calls).toEqual([]);
});

test("a rejected start keeps the draft for an explicit retry after navigation", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  let rejected = 0;
  await page.route(
    "**/api/sharing/start",
    (route) => {
      rejected++;
      return route.fulfill({ status: 409, json: { detail: "Fixture start was rejected." } });
    },
    { times: 1 },
  );
  await openSharing(page, `/sharing?model=${encodeURIComponent(model)}`);
  await page.getByLabel("Host name shown to guests").fill("Retry this name");
  await page.getByRole("button", { name: "Start hosting", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Fixture start was rejected");
  await page.getByRole("link", { name: "Test model in playground", exact: true }).click();
  await page.goBack();
  await attached(page);
  await expect(page.getByLabel("Host name shown to guests")).toHaveValue("Retry this name");
  // The public half is never attempted when serving the model failed.
  expect(fixture.calls).toEqual([]);
  expect(rejected).toBe(1);
  await page.getByRole("button", { name: "Start hosting", exact: true }).click();
  await expect(hostingStatus(page)).toHaveText("Starting hosting…");
  await expect(page.getByRole("button", { name: "Discard name draft", exact: true })).toHaveCount(
    0,
  );
  expect(fixture.state.hostLabel).toBe("Retry this name");
  expect(fixture.calls).toEqual(["/api/sharing/start", "/api/sharing/internet/start"]);
});

test("a lost start response and another running name cannot silently discard the draft", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  let attempts = 0;
  await page.route("**/api/sharing/start", (route) => {
    attempts++;
    Object.assign(fixture.state, { state: "local", model, hostLabel: "A different running name" });
    return route.abort();
  });
  await openSharing(page, `/sharing?model=${encodeURIComponent(model)}`);
  await page.getByLabel("Host name shown to guests").fill("Keep my intended name");
  await page.getByRole("button", { name: "Start hosting", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop hosting", exact: true })).toBeVisible();
  await expect(
    page.getByText(/Host-name draft kept in this tab: Keep my intended name/),
  ).toBeVisible();
  await page.getByRole("link", { name: "Test the shared model", exact: true }).click();
  await page.goBack();
  await attached(page);
  await expect(
    page.getByText(/Host-name draft kept in this tab: Keep my intended name/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop hosting", exact: true }).click();
  await expect(page.getByLabel("Host name shown to guests")).toHaveValue("Keep my intended name");
  await page.getByRole("button", { name: "Discard name draft", exact: true }).click();
  await expect(page.getByLabel("Host name shown to guests")).toHaveValue(
    "A different running name",
  );
  expect(attempts).toBe(1);
  expect(fixture.calls).toEqual(["/api/sharing/stop"]);
});

for (const outcome of ["empty", "failed"] as const) {
  test(`${outcome} model replies do not become test evidence on Guest access`, async ({ page }) => {
    const fixture = await accessFixture(page);
    let chats = 0;
    await page.route("**/api/chat", (route) => {
      chats++;
      const chunks =
        outcome === "empty"
          ? [{ content: "   ", done: true }]
          : [
              { content: "Partial output", done: false },
              { content: "", done: true, error: "Fixture failure" },
            ];
      return route.fulfill({
        contentType: "application/x-ndjson",
        body: chunks.map((chunk) => JSON.stringify(chunk) + "\n").join(""),
      });
    });
    await openSharing(page, `/sharing?model=${encodeURIComponent(model)}`);
    await page.getByRole("link", { name: "Test model in playground", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("A test that does not complete");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
    await page.goBack();
    await attached(page);
    await expect(
      page.getByText("No completed answer for this model in this tab.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Start hosting", exact: true })).toBeEnabled();
    expect(chats).toBe(1);
    expect(fixture.calls).toEqual([]);
  });
}

test("access storage failure blocks hosting and remains legible at 320px", async ({ page }) => {
  const fixture = await accessFixture(page);
  fixture.state.state = "unavailable";
  fixture.state.error =
    "Access storage is unavailable. Guest access is stopped; local chat still works.";
  await page.setViewportSize({ width: 320, height: 900 });
  await openSharing(page);
  await expect(page.getByRole("alert")).toContainText("Access storage is unavailable");
  await expect(hostingStatus(page)).toHaveText("Guest access is unavailable");
  await expect(page.getByRole("button", { name: "Start hosting", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Create key", exact: true })).toBeDisabled();
  await expect(page.getByText("No keys are recorded.", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/sharing-mobile-unavailable.png", fullPage: true });
  expect(fixture.calls).toEqual([]);
});

test("failed access refresh retains the emergency stop without claiming current status", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  publishLocal(fixture);
  await openSharing(page);
  await expect(page.getByRole("button", { name: "Stop hosting", exact: true })).toBeVisible();
  fixture.failRead();
  await page.getByRole("button", { name: "Refresh access", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Saved access status may be out of date");
  await expect(page.getByText("Hosting status is out of date", { exact: true })).toBeVisible();
  await expect(hostingStatus(page)).toHaveText("Last known status: Hosting is off");
  await expect(page.getByRole("button", { name: "Stop hosting", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Stop hosting", exact: true }).click();
  expect(fixture.calls).toEqual(["/api/sharing/stop"]);
});

for (const width of [320, 768, 1024, 1440]) {
  test(`invite-only hosting at ${width}px has no host discovery and still issues keys`, async ({
    page,
  }) => {
    const fixture = await accessFixture(page);
    publishInternet(fixture);
    const discoveryRequests: string[] = [];
    await page.route(/\/(?:api\/directory|registry)(?:\/|$)/, (route) => {
      discoveryRequests.push(route.request().url());
      return route.abort();
    });
    await page.setViewportSize({ width, height: 1100 });
    await openSharing(page);
    await expect(hostingRegion(page)).toContainText(
      "This address carries no key. Send it to your guest, then send them a key from Access keys below; they paste the key on the page.",
    );
    await expect(page.getByRole("link", { name: "Find a host", exact: true })).toHaveCount(0);
    await expect(page.locator('a[href="/hosts"]')).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Public directory listing" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Publish listing", exact: true })).toHaveCount(0);
    await page.getByLabel("Key label", { exact: true }).fill("Invited visitor");
    await page.getByRole("button", { name: "Create key", exact: true }).click();
    await expectMasked(page, "Invited visitor");
    // Handing the key over never puts it on screen, at any width.
    await copyKey(page, "Invited visitor").click();
    await expect(copyStatus(page, "Invited visitor")).toHaveText("Copied");
    await expect
      .poll(() => page.evaluate(() => (window as SharingTestWindow).sharingCopies))
      .toEqual([keyToken()]);
    await expectMasked(page, "Invited visitor");
    await expect(connectQr(page, "Invited visitor")).toHaveCount(0);
    await refreshAccess(page);
    expect(fixture.calls).toEqual(["/api/sharing/grants", `/api/sharing/grants/${grant().id}/key`]);
    expect(fixture.bodies).toEqual([
      { label: "Invited visitor", expiresInHours: 24, channel: "internet" },
      {},
    ]);
    expect(await keyLeaks(page)).toEqual(noLeak);
    expect(await keyOnScreen(page)).toEqual(keyHidden);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `test-results/invite-only-sharing-${width}.png`,
      fullPage: true,
    });
    await page.goto("/hosts");
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    expect(discoveryRequests).toEqual([]);
  });
}

test("one hosting action serves the model then publishes it, and stop ends both halves", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  await page.clock.install();
  await openSharing(page);
  const start = page.getByRole("button", { name: "Start hosting", exact: true });
  await expect(hostingStatus(page)).toHaveText("Hosting is off");
  await expect(page.getByText("Not hosting", { exact: true })).toBeVisible();
  await expect(hostingRegion(page)).toContainText(
    "Starting makes the guest page reachable through Cloudflare",
  );
  await expect(hostingRegion(page)).toContainText("Anyone with its address can open the page");
  await expect(hostingRegion(page)).toContainText("an access key is required for chat");
  await expect(hostingRegion(page)).toContainText(
    "Cloudflare terminates TLS and can see messages and access keys",
  );
  await expect(hostingRegion(page)).toContainText("The address changes on every start");
  await expect(hostingRegion(page)).toContainText("no uptime guarantee");
  await expect(hostingRegion(page)).toContainText("not production hosting");
  await expect(start).toBeDisabled();
  await page.getByLabel("Model for guests").selectOption(model);
  await expect(start).toBeEnabled();
  await start.click();
  await expect(hostingStatus(page)).toHaveText("Starting hosting…");
  expect(fixture.calls).toEqual(["/api/sharing/start", "/api/sharing/internet/start"]);
  expect(fixture.bodies).toEqual([{ model, hostLabel: "Local host" }, {}]);
  fixture.state.internet!.state = "verifying";
  await page.clock.runFor(2_000);
  await expect(hostingStatus(page)).toHaveText("Verifying the public address…");
  await expect(page.getByText(publicOrigin, { exact: true })).toHaveCount(0);
  await expect(page.getByText("Not reachable yet", { exact: true })).toBeVisible();
  publishInternet(fixture);
  await page.clock.runFor(2_000);
  await expect(hostingStatus(page)).toHaveText("Hosting is live");
  await expect(page.getByText("Reachable from the internet", { exact: true })).toBeVisible();
  await expect(page.getByText(publicOrigin, { exact: true })).toBeVisible();
  await page.getByLabel("Key label", { exact: true }).fill("Internet visitor");
  await page.getByRole("button", { name: "Create key", exact: true }).click();
  await expectMasked(page, "Internet visitor");
  expect(fixture.bodies[2]).toEqual({
    label: "Internet visitor",
    expiresInHours: 24,
    channel: "internet",
  });
  await showKey(page, "Internet visitor").click();
  await expect(keyField(page, "Internet visitor")).toHaveValue(keyToken());
  expect(await page.evaluate(() => (window as SharingTestWindow).sharingCopies)).toEqual([]);
  expect(await keyLeaks(page)).toEqual(noLeak);
  Object.assign(fixture.state.internet!, { state: "interrupted", publicUrl: null });
  await page.clock.runFor(5_000);
  await expect(hostingStatus(page)).toHaveText("Hosting is interrupted");
  await expect(page.getByText(publicOrigin, { exact: true })).toHaveCount(0);
  fixture.state.internet!.state = "stopping";
  await page.clock.runFor(2_000);
  await expect(hostingStatus(page)).toHaveText("Stopping hosting…");
  await page.getByRole("button", { name: "Stop hosting", exact: true }).click();
  await expect(hostingStatus(page)).toHaveText("Hosting is off");
  await expect(page.getByText("Not hosting", { exact: true })).toBeVisible();
  await expect(start).toBeEnabled();
  // Stopping pauses the key rather than revoking it, so the host's own copy stays readable.
  await expect(keyField(page, "Internet visitor")).toHaveValue(keyToken());
  await expect(keysRegion(page)).toContainText(
    "Hosting is off. This permission resumes when its model is hosted again.",
  );
  expect(await keyLeaks(page)).toEqual(noLeak);
  expect(fixture.calls).toEqual([
    "/api/sharing/start",
    "/api/sharing/internet/start",
    "/api/sharing/grants",
    `/api/sharing/grants/${grant().id}/key`,
    "/api/sharing/stop",
  ]);
});

test("stopping takes the public address offline and starting republishes it in one action", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  publishInternet(fixture);
  await openSharing(page);
  await expect(page.getByText("Reachable from the internet", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop hosting", exact: true }).click();
  await expect(hostingStatus(page)).toHaveText("Hosting is off");
  await expect(page.getByText(publicOrigin, { exact: true })).toHaveCount(0);
  await expect(addressQr(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Start hosting", exact: true }).click();
  await expect(hostingStatus(page)).toHaveText("Starting hosting…");
  expect(fixture.calls).toEqual([
    "/api/sharing/stop",
    "/api/sharing/start",
    "/api/sharing/internet/start",
  ]);
});

test("a gateway without hosting support keeps keys visible and never offers to publish", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  publishLocal(fixture);
  fixture.state.internet = undefined;
  fixture.state.grants.push(grant());
  await openSharing(page);
  await expect(hostingStatus(page)).toHaveText("Hosting is not available in this gateway");
  await expect(
    page.getByRole("button", { name: "Try the public connection again", exact: true }),
  ).toHaveCount(0);
  await expectMasked(page, "Visitor");
  await expect(showKey(page, "Visitor")).toBeEnabled();
  await expect(keysRegion(page)).toContainText(
    "Hosting is not reachable from the internet yet. Restore the public address before using this key.",
  );
  await page.getByRole("button", { name: "Stop hosting", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start hosting", exact: true })).toBeDisabled();
  expect(fixture.calls).toEqual(["/api/sharing/stop"]);
});

test("a failed public connection needs an explicit retry while keys stay issuable", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  publishLocal(fixture);
  Object.assign(fixture.state.internet!, {
    state: "failed",
    error: "The public connection could not be started.",
  });
  await page.clock.install();
  await openSharing(page);
  await expect(hostingStatus(page)).toHaveText("Hosting failed");
  await expect(page.getByRole("alert")).toContainText("public connection could not be started");
  await page.getByLabel("Key label", { exact: true }).fill("Waiting visitor");
  await expect(page.getByRole("button", { name: "Create key", exact: true })).toBeEnabled();
  await page.clock.runFor(5_000);
  expect(fixture.calls).toEqual([]);
  const retry = page.getByRole("button", { name: "Try the public connection again", exact: true });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(hostingStatus(page)).toHaveText("Starting hosting…");
  expect(fixture.calls).toEqual(["/api/sharing/internet/start"]);
});

test("missing connector blocks hosting with installation guidance and controls stay reachable", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  fixture.state.internet!.available = false;
  await page.setViewportSize({ width: 320, height: 900 });
  await openSharing(page);
  await page.getByLabel("Model for guests").selectOption(model);
  await expect(page.getByRole("button", { name: "Start hosting", exact: true })).toBeDisabled();
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
  await page.getByLabel("Key label", { exact: true }).fill("A".repeat(80));
  await page.getByRole("button", { name: "Create key", exact: true }).click();
  await expectMasked(page, "A".repeat(80));
  await showKey(page, "A".repeat(80)).click();
  await expect(keyField(page, "A".repeat(80))).toHaveValue(keyToken());
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      await page.locator("main button, main select, main input").evaluateAll((elements) =>
        elements
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && (rect.left < 0 || rect.right > innerWidth || rect.height < 44);
          })
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const name =
              element.getAttribute("aria-label") ||
              element.id ||
              element.textContent?.trim().slice(0, 40) ||
              element.tagName;
            return `${name} left=${Math.round(rect.left)} right=${Math.round(rect.right)} height=${Math.round(rect.height)} of ${innerWidth}`;
          }),
      ),
    ).toEqual([]);
    await page.screenshot({ path: `test-results/sharing-hosting-${width}.png`, fullPage: true });
  }
  const copy = copyKey(page, "A".repeat(80));
  await copy.focus();
  await copy.press("Enter");
  await expect
    .poll(() => page.evaluate(() => (window as SharingTestWindow).sharingCopies))
    .toEqual([keyToken()]);
});

test("a stale status keeps a revealed key legible, blocks new reads and keeps stop reachable", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  publishInternet(fixture);
  fixture.state.grants.push(grant("internet"));
  await page.clock.install();
  await openSharing(page);
  await showKey(page, "Visitor").click();
  await expect(keyField(page, "Visitor")).toHaveValue(keyToken());
  fixture.failRead();
  await refreshAccess(page);
  await expect(page.getByRole("alert")).toContainText("Saved access status may be out of date");
  await expect(page.getByRole("button", { name: "Create key", exact: true })).toBeDisabled();
  await expect(hideKey(page, "Visitor")).toBeDisabled();
  await expect(copyKey(page, "Visitor")).toBeDisabled();
  // The host already asked to see this key; a failed status read does not unsay it.
  await expect(keyField(page, "Visitor")).toHaveValue(keyToken());
  await expect(page.getByRole("button", { name: "Stop hosting", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Revoke Visitor", exact: true })).toBeEnabled();
  fixture.recoverRead();
  await refreshAccess(page);
  await expect(hideKey(page, "Visitor")).toBeEnabled();
  await expect(keyField(page, "Visitor")).toHaveValue(keyToken());
  fixture.state.grants[0].revokedAt = new Date().toISOString();
  await page.clock.runFor(5_000);
  await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
  await expect(keyField(page, "Visitor")).toHaveCount(0);
  expect(await keyOnScreen(page)).toEqual(keyHidden);
  expect(await keyLeaks(page)).toEqual(noLeak);
  expect(fixture.calls).toEqual([`/api/sharing/grants/${grant().id}/key`]);
});

test("status polling pauses while hidden and checks again on return", async ({ page }) => {
  const fixture = await accessFixture(page);
  publishInternet(fixture);
  await page.clock.install();
  await openSharing(page);
  await expect(hostingStatus(page)).toHaveText("Hosting is live");
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
  await expect(hostingStatus(page)).toHaveText("Hosting is interrupted");
  expect(fixture.reads()).toBe(reads + 1);
});

test("a connector that needs a restart disables retry while stop stays reachable", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  publishLocal(fixture);
  Object.assign(fixture.state.internet!, {
    state: "failed",
    restartRequired: true,
    error: "Internet requests are blocked, but cleanup failed. Restart the gateway.",
  });
  await openSharing(page);
  await expect(page.getByRole("alert")).toContainText("Restart the gateway");
  await expect(
    page.getByRole("button", { name: "Try the public connection again", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "Stop hosting", exact: true })).toBeEnabled();
  expect(fixture.calls).toEqual([]);
});

test("verification feedback explains the current check while keeping stop available", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  publishLocal(fixture);
  Object.assign(fixture.state.internet!, {
    state: "verifying",
    error: "Waiting for public DNS. Internet access remains blocked.",
  });
  await openSharing(page);
  await expect(hostingStatus(page)).toHaveText("Verifying the public address…");
  await expect(
    page.getByText("Waiting for public DNS. Internet access remains blocked.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop hosting", exact: true })).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Try the public connection again", exact: true }),
  ).toHaveCount(0);
  expect(fixture.calls).toEqual([]);
});

test("an expired key loses every control that could hand it out again", async ({ page }) => {
  const fixture = await accessFixture(page);
  publishInternet(fixture);
  await openSharing(page);
  await page.getByLabel("Key label", { exact: true }).fill("Visitor");
  await page.getByRole("button", { name: "Create key", exact: true }).click();
  await expectMasked(page, "Visitor");
  await showKey(page, "Visitor").click();
  await expect(keyField(page, "Visitor")).toHaveValue(keyToken());
  await hideKey(page, "Visitor").click();
  await expectMasked(page, "Visitor");
  await page.clock.setFixedTime(new Date(Date.now() + 3_600_001));
  await refreshAccess(page);
  await expect(page.getByText("Expired", { exact: true })).toBeVisible();
  await expect(keyGroup(page, "Visitor")).toHaveCount(0);
  await expect(copyKey(page, "Visitor")).toHaveCount(0);
  await expect(showKey(page, "Visitor")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Revoke Visitor", exact: true })).toHaveCount(0);
  expect(await keyOnScreen(page)).toEqual(keyHidden);
  expect(await keyLeaks(page)).toEqual(noLeak);
  expect(fixture.calls).toEqual(["/api/sharing/grants", `/api/sharing/grants/${grant().id}/key`]);
});

for (const width of [320, 768, 1024, 1440]) {
  test(`a failed key copy leaves a selectable key field at ${width}px`, async ({ page }) => {
    const fixture = await accessFixture(page);
    publishInternet(fixture);
    fixture.state.grants.push(grant("internet"));
    await page.setViewportSize({ width, height: 1100 });
    await openSharing(page);
    await page.evaluate(() => {
      (window as SharingTestWindow).sharingCopyFails = true;
    });
    await expectMasked(page, "Visitor");
    await copyKey(page, "Visitor").click();
    await expect(copyStatus(page, "Visitor")).toHaveText(
      "Copy failed. Show the key and copy it manually.",
    );
    // A refused clipboard is not a reason to unmask; the host is told to ask for it.
    await expectMasked(page, "Visitor");
    await showKey(page, "Visitor").click();
    const field = keyField(page, "Visitor");
    await expect(field).toHaveValue(keyToken());
    await expect(field).not.toBeEditable();
    await field.focus();
    expect(
      await field.evaluate((element) => {
        const input = element as HTMLInputElement;
        return input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0);
      }),
    ).toBe(keyToken());
    expect(await keyLeaks(page)).toEqual(noLeak);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await keysRegion(page).screenshot({ path: `test-results/key-manual-copy-${width}.png` });
    await hideKey(page, "Visitor").click();
    await expect(field).toHaveCount(0);
    await expectMasked(page, "Visitor");
    expect(fixture.calls).toEqual([
      `/api/sharing/grants/${grant().id}/key`,
      `/api/sharing/grants/${grant().id}/key`,
    ]);
  });
}

test("leaving the page drops a revealed key and copying never depends on the clipboard API", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  publishLocal(fixture);
  fixture.state.grants.push(grant("internet"));
  await openSharing(page);
  await page.evaluate(() => Reflect.deleteProperty(navigator.clipboard, "writeText"));
  await showKey(page, "Visitor").click();
  await expect(keyField(page, "Visitor")).toHaveValue(keyToken());
  await copyKey(page, "Visitor").click();
  await expect(copyStatus(page, "Visitor")).toHaveText(
    "Copy failed. Show the key and copy it manually.",
  );
  await expect(keyField(page, "Visitor")).toHaveValue(keyToken());
  const nav = page.getByRole("navigation", { name: "Main navigation", exact: true });
  await nav.getByRole("link", { name: "Connection", exact: true }).click();
  await nav.getByRole("link", { name: "Guest access", exact: true }).click();
  await attached(page);
  await expect(showKey(page, "Visitor")).toBeVisible();
  // Leaving the page drops the reveal; the row comes back masked.
  await expectMasked(page, "Visitor");
  expect(await keyLeaks(page)).toEqual(noLeak);
  expect(fixture.calls).toEqual([
    `/api/sharing/grants/${grant().id}/key`,
    `/api/sharing/grants/${grant().id}/key`,
  ]);
});

test("an unsettled clipboard request neither blocks manual copying nor hides the key", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  publishInternet(fixture);
  fixture.state.grants.push(grant("internet"));
  await openSharing(page);
  await page.evaluate(() => {
    navigator.clipboard.writeText = () => new Promise<void>(() => {});
  });
  await showKey(page, "Visitor").click();
  const field = keyField(page, "Visitor");
  await expect(field).toHaveValue(keyToken());
  await copyKey(page, "Visitor").click();
  await expect(copyKey(page, "Visitor")).toBeDisabled();
  await expect(copyStatus(page, "Visitor")).toHaveText("Copying…");
  await expect(field).toHaveValue(keyToken());
  await expect(hideKey(page, "Visitor")).toBeEnabled();
  expect(await page.evaluate(() => (window as SharingTestWindow).sharingCopies)).toEqual([]);
  expect(await keyLeaks(page)).toEqual(noLeak);
  expect(fixture.calls).toEqual([
    `/api/sharing/grants/${grant().id}/key`,
    `/api/sharing/grants/${grant().id}/key`,
  ]);
});

test("real hosting connects a guest and revocation ends an active response", async ({
  page,
  context,
}) => {
  test.skip(
    process.env.HOSTAI_INTEGRATION !== "1" || !process.env.HOSTAI_GUEST_TEST_URL,
    "Requires temporary access storage and the explicit isolated Ollama fixture.",
  );
  await openSharing(page, "/sharing?model=test-model%3Asmall");
  const status = await (await page.request.get("/api/sharing")).json();
  if (status.state === "local")
    await page.getByRole("button", { name: "Stop hosting", exact: true }).click();
  await page.getByRole("button", { name: "Start hosting", exact: true }).click();
  await page.getByLabel("Key label", { exact: true }).fill("Integration visitor");
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/sharing/grants") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create key", exact: true }).click();
  const issued = await (await created).json();
  await expect(maskedKey(page, "Integration visitor")).toHaveText(masked);
  await showKey(page, "Integration visitor").click();
  await expect(keyField(page, "Integration visitor")).toHaveValue(issued.token);
  const guest = await context.newPage();
  try {
    const guestOrigin = new URL(process.env.HOSTAI_GUEST_TEST_URL!).origin;
    await guest.goto(`${guestOrigin}/#access=${issued.token}`);
    await expect(guest.locator("#guest-access-status")).toHaveText(
      "Access was available at the last check.",
    );
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
    // The guest's connection controls live in the header's session menu, a native
    // <details> that starts closed.
    await guest.locator("#guest-session-menu").click();
    await guest.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(guest.getByRole("alert")).toContainText("invalid, expired, or revoked");
    await expect(guest.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
    await expect
      .poll(async () => (await (await page.request.get("/api/status")).json()).activeRequests)
      .toBe(0);
    await guest.screenshot({ path: "test-results/guest-integration-revoked.png", fullPage: true });
  } finally {
    await guest.close();
    await page.request.post(`/api/sharing/grants/${issued.grant.id}/revoke`, { data: {} });
    await page.request.post("/api/sharing/stop", { data: {} });
  }
});
