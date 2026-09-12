import { expect, test, type Page } from "@playwright/test";
import {
  accessFixture,
  grant,
  keyToken,
  publishLocal,
  publishInternet,
} from "./support/sharing-fixture";

const cleanupButton = (page: Page) =>
  page.getByRole("button", { name: "Remove expired and revoked keys", exact: true });
const cleanupGroup = (page: Page) =>
  page.getByRole("group", { name: "Key storage cleanup", exact: true });
/** A stored key stays masked until the host asks for it, so reading one takes a click. */
const keyField = (page: Page, label: string) =>
  page.getByRole("textbox", { name: `Access key for ${label}, visible`, exact: true });
const maskedKey = (page: Page, label: string) =>
  page.getByRole("group", { name: `Access key for ${label}`, exact: true }).locator("p");
const masked = "•".repeat(24);
const showKey = (page: Page, label: string) =>
  page.getByRole("button", { name: `Show key ${label}`, exact: true });
function mixedKeys() {
  return [
    { ...grant("local"), id: crypto.randomUUID(), label: "Active local guest" },
    { ...grant("internet"), id: crypto.randomUUID(), label: "Paused remote guest" },
    {
      ...grant("local"),
      id: crypto.randomUUID(),
      label: "Old guest",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    },
    {
      ...grant("internet"),
      id: crypto.randomUUID(),
      label: "Revoked guest",
      revokedAt: new Date().toISOString(),
    },
  ];
}

for (const width of [320, 768, 1024, 1440]) {
  test(`explicit key cleanup preserves active and paused permissions at ${width}px`, async ({
    page,
  }) => {
    const fixture = await accessFixture(page);
    publishLocal(fixture);
    fixture.cleanup.enabled = true;
    fixture.state.grants = mixedKeys();
    await page.setViewportSize({ width, height: 1100 });
    await page.goto("/sharing");
    await expect(cleanupGroup(page)).toContainText("2 expired or revoked keys can be removed");
    expect(fixture.calls).toEqual([]);
    await cleanupButton(page).focus();
    await cleanupButton(page).press("Enter");
    await expect(cleanupGroup(page).getByRole("status")).toHaveText(
      "Removed 2 expired or revoked keys. Active keys were kept.",
    );
    await expect(cleanupGroup(page)).toBeFocused();
    await expect(cleanupButton(page)).toBeDisabled();
    await expect(page.getByRole("heading", { name: "Old guest", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Revoked guest", exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Active local guest", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Paused remote guest", exact: true }),
    ).toBeVisible();
    expect(fixture.state.grants.map((key) => key.label)).toEqual([
      "Active local guest",
      "Paused remote guest",
    ]);
    expect(fixture.calls).toEqual(["/api/sharing/grants/cleanup"]);
    expect(fixture.bodies).toEqual([{}]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page
      .getByRole("region", { name: "Access keys", exact: true })
      .screenshot({ path: `test-results/key-cleanup-${width}.png` });
  });
}

test("cleanup frees a full key store and enables an explicitly requested new invitation", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  publishLocal(fixture);
  fixture.cleanup.enabled = true;
  fixture.state.grants = Array.from({ length: 100 }, (_, index) => ({
    ...grant("local"),
    id: crypto.randomUUID(),
    label: `Old guest ${index}`,
    revokedAt: new Date().toISOString(),
  }));
  await page.goto("/sharing");
  await page.getByLabel("Key label", { exact: true }).fill("Next invited guest");
  const create = page.getByRole("button", { name: "Create key", exact: true });
  await expect(create).toBeDisabled();
  await expect(page.getByRole("region", { name: "Access keys", exact: true })).toContainText(
    "All 100 key slots are in use, including expired and revoked keys. Remove expired and revoked keys below; keys that still grant access must be revoked first.",
  );
  await cleanupButton(page).click();
  await expect(cleanupGroup(page).getByRole("status")).toContainText("Removed 100");
  await expect(create).toBeEnabled();
  expect(fixture.calls).toEqual(["/api/sharing/grants/cleanup"]);
  await expect(page.getByLabel("Key label", { exact: true })).toHaveValue("Next invited guest");
  await create.click();
  await expect(maskedKey(page, "Next invited guest")).toHaveText(masked);
  await expect(keyField(page, "Next invited guest")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Copy key Next invited guest", exact: true }),
  ).toBeEnabled();
  await showKey(page, "Next invited guest").click();
  await expect(keyField(page, "Next invited guest")).toHaveValue(keyToken());
  expect(fixture.calls).toEqual([
    "/api/sharing/grants/cleanup",
    "/api/sharing/grants",
    `/api/sharing/grants/${grant().id}/key`,
  ]);
});

test("stopped sharing can be cleaned without starting guest access or internet sharing", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  fixture.cleanup.enabled = true;
  fixture.state.grants = mixedKeys();
  await page.goto("/sharing");
  await cleanupButton(page).click();
  await expect(cleanupGroup(page).getByRole("status")).toContainText("Removed 2");
  expect(fixture.state.state).toBe("stopped");
  expect(fixture.state.internet?.state).toBe("off");
  expect(fixture.calls).toEqual(["/api/sharing/grants/cleanup"]);
});

test("gateway eligibility controls cleanup even when the browser thinks a key expired", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  publishLocal(fixture);
  fixture.cleanup.enabled = true;
  fixture.state.grants = [grant("local")];
  await page.clock.setFixedTime(new Date(Date.now() + 86_400_000));
  await page.goto("/sharing");
  await expect(page.getByText("Expired", { exact: true })).toBeVisible();
  await expect(cleanupGroup(page)).toContainText("No expired or revoked keys to remove");
  await expect(cleanupButton(page)).toBeDisabled();
  expect(fixture.calls).toEqual([]);
});

test("a changed eligibility count reports the actual no-op without inventing removals", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  fixture.cleanup.enabled = true;
  fixture.state.grants = mixedKeys();
  await page.goto("/sharing");
  await expect(cleanupButton(page)).toBeEnabled();
  fixture.state.grants = fixture.state.grants.slice(0, 2);
  await cleanupButton(page).click();
  await expect(cleanupGroup(page).getByRole("status")).toHaveText(
    "No keys were removed. The gateway found no expired or revoked keys.",
  );
  expect(fixture.state.grants).toHaveLength(2);
  expect(fixture.calls).toEqual(["/api/sharing/grants/cleanup"]);
});

test("a lost cleanup reply refreshes saved keys without claiming success or retrying", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  fixture.cleanup.enabled = true;
  fixture.cleanup.loseResponse = true;
  fixture.state.grants = mixedKeys();
  await page.goto("/sharing");
  await cleanupButton(page).click();
  await expect(page.getByRole("alert")).toContainText("Key cleanup could not be confirmed");
  await expect(cleanupGroup(page).getByRole("status")).toBeEmpty();
  await expect(cleanupButton(page)).toBeDisabled();
  await expect(page.getByRole("heading", { name: "Old guest", exact: true })).toHaveCount(0);
  expect(fixture.state.grants).toHaveLength(2);
  expect(fixture.calls).toEqual(["/api/sharing/grants/cleanup"]);
});

test("cleanup never disturbs a key created moments earlier, which stays readable", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  publishInternet(fixture);
  fixture.cleanup.enabled = true;
  fixture.state.grants = [mixedKeys()[3]];
  await page.goto("/sharing");
  await page.getByLabel("Key label", { exact: true }).fill("Keep this key");
  await page.getByRole("button", { name: "Create key", exact: true }).click();
  const field = keyField(page, "Keep this key");
  await expect(maskedKey(page, "Keep this key")).toHaveText(masked);
  await expect(field).toHaveCount(0);
  await showKey(page, "Keep this key").click();
  await expect(field).toHaveValue(keyToken());
  await cleanupButton(page).click();
  await expect(cleanupGroup(page).getByRole("status")).toContainText("Removed 1");
  await expect(field).toHaveValue(keyToken());
  await page.getByRole("button", { name: "Hide key Keep this key", exact: true }).click();
  await expect(field).toHaveCount(0);
  await expect(maskedKey(page, "Keep this key")).toHaveText(masked);
  await showKey(page, "Keep this key").click();
  await expect(field).toHaveValue(keyToken());
  expect(fixture.state.grants).toHaveLength(1);
  expect(fixture.state.grants[0].label).toBe("Keep this key");
  expect(fixture.calls).toEqual([
    "/api/sharing/grants",
    `/api/sharing/grants/${grant().id}/key`,
    "/api/sharing/grants/cleanup",
    `/api/sharing/grants/${grant().id}/key`,
  ]);
});

for (const unsupported of [true, false]) {
  test(`${unsupported ? "legacy gateways" : "failed status reads"} cannot enable cleanup`, async ({
    page,
  }) => {
    const fixture = await accessFixture(page);
    fixture.state.grants = mixedKeys();
    if (!unsupported) {
      fixture.cleanup.enabled = true;
      fixture.failRead();
    }
    await page.goto("/sharing");
    await expect(cleanupGroup(page)).toContainText(
      unsupported
        ? "This gateway does not support key cleanup"
        : "Refresh access to check which keys can be removed",
    );
    await expect(cleanupButton(page)).toBeDisabled();
    expect(fixture.calls).toEqual([]);
  });
}

test("pending cleanup blocks duplicate actions and completion respects moved focus", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  fixture.cleanup.enabled = true;
  fixture.state.grants = mixedKeys();
  let release!: () => void;
  fixture.cleanup.wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.goto("/sharing");
  try {
    await cleanupButton(page).click();
    await expect(cleanupGroup(page)).toHaveAttribute("aria-busy", "true");
    await expect(
      page.getByRole("button", { name: "Removing ended keys…", exact: true }),
    ).toBeDisabled();
    await expect(cleanupGroup(page)).toBeFocused();
    await page.keyboard.press("Enter");
    const elsewhere = page.getByRole("link", { name: "Models", exact: true });
    await elsewhere.focus();
    await expect(elsewhere).toBeFocused();
    release();
    await expect(cleanupGroup(page).getByRole("status")).toContainText("Removed 2");
    await expect(elsewhere).toBeFocused();
    expect(fixture.calls).toEqual(["/api/sharing/grants/cleanup"]);
  } finally {
    release();
  }
});

test("storage failure disables cleanup without claiming that saved records were removed", async ({
  page,
}) => {
  const fixture = await accessFixture(page);
  fixture.cleanup.enabled = true;
  fixture.state.grants = mixedKeys();
  await page.route("**/api/sharing/grants/cleanup", async (route) => {
    fixture.state.state = "unavailable";
    fixture.state.error =
      "Guest access is stopped because key storage failed; local chat still works.";
    fixture.state.grants = [];
    await route.fulfill({ status: 503, json: { detail: "Key storage is unavailable." } });
  });
  await page.goto("/sharing");
  await cleanupButton(page).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Key cleanup could not be confirmed" }),
  ).toBeVisible();
  await expect(cleanupGroup(page).getByRole("status")).toBeEmpty();
  await expect(cleanupButton(page)).toBeDisabled();
  await expect(cleanupGroup(page)).toContainText("Refresh access to check");
});

test("malformed removal results never announce success", async ({ page }) => {
  const fixture = await accessFixture(page);
  fixture.cleanup.enabled = true;
  fixture.state.grants = mixedKeys();
  await page.route("**/api/sharing/grants/cleanup", (route) =>
    route.fulfill({
      json: { status: fixture.state, removedCount: 101 },
    }),
  );
  await page.goto("/sharing");
  await cleanupButton(page).click();
  await expect(page.getByRole("alert")).toContainText("Key cleanup could not be confirmed");
  await expect(cleanupGroup(page).getByRole("status")).toBeEmpty();
  await expect(page.getByRole("heading", { name: "Old guest", exact: true })).toBeVisible();
});

test("malformed gateway eligibility blocks cleanup", async ({ page }) => {
  const fixture = await accessFixture(page);
  fixture.state.grants = mixedKeys();
  fixture.state.removableKeys = 5;
  await page.goto("/sharing");
  await expect(cleanupGroup(page)).toContainText("Refresh access to check");
  await expect(cleanupButton(page)).toBeDisabled();
  expect(fixture.calls).toEqual([]);
});
