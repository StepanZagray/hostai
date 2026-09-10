import { expect, test, type Page } from "@playwright/test";
import {
  accessFixture,
  grant,
  publishLocal,
  publishInternet,
  publicOrigin,
} from "./support/sharing-fixture";

const cleanupButton = (page: Page) =>
  page.getByRole("button", { name: "Remove expired and revoked keys", exact: true });
const cleanupGroup = (page: Page) =>
  page.getByRole("group", { name: "Key storage cleanup", exact: true });
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
  const create = page.getByRole("button", { name: "Create client link", exact: true });
  await expect(create).toBeDisabled();
  await expect(page.getByRole("region", { name: "Create client key", exact: true })).toContainText(
    "Remove expired and revoked keys in Access keys below",
  );
  await cleanupButton(page).click();
  await expect(cleanupGroup(page).getByRole("status")).toContainText("Removed 100");
  await expect(create).toBeEnabled();
  expect(fixture.calls).toEqual(["/api/sharing/grants/cleanup"]);
  await expect(page.getByLabel("Key label", { exact: true })).toHaveValue("Next invited guest");
  await create.click();
  await expect(page.getByRole("button", { name: "Copy client link", exact: true })).toBeEnabled();
  expect(fixture.calls).toEqual(["/api/sharing/grants/cleanup", "/api/sharing/grants"]);
});

test("stopped sharing can be cleaned without starting client access or internet sharing", async ({
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

test("cleanup keeps a valid one-time internet invitation available", async ({ page }) => {
  const fixture = await accessFixture(page);
  publishInternet(fixture);
  fixture.cleanup.enabled = true;
  fixture.state.grants = [mixedKeys()[3]];
  await page.goto("/sharing");
  await page.getByLabel("Key label", { exact: true }).fill("Keep this invite");
  await page.getByLabel("Key channel").selectOption("internet");
  await page.getByRole("button", { name: "Create client link", exact: true }).click();
  await cleanupButton(page).click();
  await expect(cleanupGroup(page).getByRole("status")).toContainText("Removed 1");
  await page.getByRole("button", { name: "Show link for manual copy", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Client link for manual copy", exact: true }),
  ).toHaveValue(`${publicOrigin}/#access=fixture-secret`);
  expect(fixture.state.grants).toHaveLength(1);
  expect(fixture.state.grants[0].label).toBe("Keep this invite");
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
      "Client access is stopped because key storage failed; local chat still works.";
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
