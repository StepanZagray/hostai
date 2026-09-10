import { expect, test, type Page } from "@playwright/test";
import { hostFixture } from "./support/host-fixture";

const publication = () => ({
  state: "off",
  configured: true,
  registryUrl: "https://directory.example/",
  enabled: false,
  canPublish: true,
  identityId: null as string | null,
  updatedAt: null as number | null,
  expiresAt: null as number | null,
  error: null as string | null,
});
const now = 1_800_000_000_000;
const host = (id = "a", model = "fixture-model:small") => ({
  id: id.repeat(64),
  hostLabel: "Alice’s shared model",
  model,
  guestUrl: "https://alice-fixture.trycloudflare.com/",
  updatedAt: now,
  expiresAt: now + 90000,
  invitationRequired: true,
  requestsAccepted: null as boolean | null,
});
async function directory(page: Page) {
  await hostFixture(page);
  const state = {
    config: publication(),
    entries: [host()],
    servedAt: now,
    fail: false,
    requests: 0,
    unexpected: [] as string[],
  };
  await page.route("**/api/directory", (route) => route.fulfill({ json: state.config }));
  await page.route("**/api/directory/listings", (route) => {
    state.requests++;
    return route.fulfill({
      status: state.fail ? 503 : 200,
      json: state.fail
        ? { detail: "private provider text" }
        : {
            version: 2,
            registryUrl: state.config.registryUrl,
            servedAt: state.servedAt,
            listings: state.entries,
          },
    });
  });
  await page.route("https://*.trycloudflare.com/**", (route) => {
    state.unexpected.push(route.request().url());
    return route.abort();
  });
  return state;
}
test("directory setup is distinct from an empty registry and needs no automatic registration", async ({
  page,
}) => {
  const state = await directory(page);
  Object.assign(state.config, { configured: false, registryUrl: null });
  await page.goto("/hosts");
  await expect(page.getByRole("heading", { name: "Choose a shared directory" })).toBeVisible();
  expect(state.requests).toBe(0);
  expect(state.unexpected).toEqual([]);
  await page.screenshot({
    path: "test-results/directory-unconfigured.png",
    fullPage: true,
    animations: "disabled",
  });
});
test("model and host search keeps invitation and identity limits visible without probing hosts", async ({
  page,
}) => {
  const state = await directory(page);
  state.entries.push({
    ...host("b", "another-model:large"),
    hostLabel: "Bob’s host",
    guestUrl: "https://bob-fixture.trycloudflare.com/",
  });
  await page.goto("/hosts");
  await expect(
    page.getByRole("heading", { name: "fixture-model:small", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("The host must approve access.")).toBeVisible();
  await page.getByLabel("Search model or host").fill("BOB");
  await expect(
    page.getByRole("heading", { name: "another-model:large", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "fixture-model:small", exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  const link = page.getByRole("link", { name: "Open guest chat for Alice’s shared model" });
  await expect(link).toHaveAttribute("href", host().guestUrl);
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(state.requests).toBe(1);
  expect(state.unexpected).toEqual([]);
  await page.getByLabel("Search model or host").fill("missing");
  await expect(page.getByRole("heading", { name: "No matching hosts" })).toBeVisible();
  expect(state.requests).toBe(1);
});
test("expiry disables the link using registry time even with a different browser wall clock", async ({
  page,
}) => {
  const state = await directory(page);
  state.servedAt = now + 89000;
  await page.goto("/hosts");
  await expect(page.getByRole("link", { name: /Open guest chat for/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No recently updated hosts" })).toBeVisible({
    timeout: 4000,
  });
  await page.getByLabel("Include expired listings").check();
  await expect(page.getByText("Listing expired", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Awaiting host update" })).toBeDisabled();
  expect(state.unexpected).toEqual([]);
});
test("refresh failure retains rows but disables opening; recovery preserves the search", async ({
  page,
}) => {
  const state = await directory(page);
  await page.goto("/hosts");
  await expect(page.getByRole("link", { name: /Open guest chat for/ })).toBeVisible();
  await page.getByLabel("Search model or host").fill("Alice");
  state.fail = true;
  await page.getByRole("button", { name: "Refresh listings", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Previous listings are shown");
  await expect(page.getByRole("link", { name: /Open guest chat for/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh before opening" })).toBeDisabled();
  expect(await page.content()).not.toContain("private provider text");
  await page.screenshot({
    path: "test-results/directory-refresh-failed.png",
    fullPage: true,
    animations: "disabled",
  });
  state.fail = false;
  await page.getByRole("button", { name: "Refresh listings", exact: true }).click();
  await expect(page.getByRole("link", { name: /Open guest chat for/ })).toBeVisible();
  await expect(page.getByLabel("Search model or host")).toHaveValue("Alice");
});

test("opening rechecks elapsed time before the next refresh after a browser resumes", async ({
  page,
}) => {
  const state = await directory(page);
  await page.goto("/hosts");
  await expect(page.getByRole("link", { name: /Open guest chat for/ })).toBeVisible();
  await page.evaluate(() => {
    const original = Date.now;
    Date.now = () => original() + 3_600_000;
    // Advance wall time with no monotonic wait, then click in the same task so
    // the interval cannot hide the link before its own final freshness check.
    document
      .querySelector<HTMLAnchorElement>('a[aria-label="Open guest chat for Alice’s shared model"]')!
      .click();
  });
  await expect(page.getByRole("heading", { name: "No recently updated hosts" })).toBeVisible();
  expect(state.unexpected).toEqual([]);
});
test("empty and invalid directories never look like an available host", async ({ page }) => {
  const state = await directory(page);
  state.entries = [];
  await page.goto("/hosts");
  await expect(page.getByRole("heading", { name: "No hosts are listed yet" })).toBeVisible();
  state.entries = [
    { ...host(), guestUrl: "https://alice-fixture.trycloudflare.com/#access=private-key" },
  ];
  await page.getByRole("button", { name: "Refresh listings", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(await page.content()).not.toContain("private-key");
  expect(state.unexpected).toEqual([]);
});
test("listing polling pauses while hidden and reloads when visible", async ({ page }) => {
  const state = await directory(page);
  await page.clock.install();
  await page.goto("/hosts");
  await expect(page.getByRole("link", { name: /Open guest chat for/ })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const before = state.requests;
  await page.clock.fastForward(20000);
  expect(state.requests).toBe(before);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => state.requests).toBe(before + 1);
});
for (const width of [320, 768, 1024, 1440])
  test(`directory long labels fit ${width}px and keyboard navigation works`, async ({ page }) => {
    const state = await directory(page);
    state.entries = [
      { ...host(), hostLabel: "A".repeat(80), model: "long-model-name".repeat(12) + ":small" },
    ];
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/hosts");
    await expect(page.getByRole("link", { name: /Open guest chat for/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByLabel("Search model or host").focus();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Requests reported open", { exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Include expired listings")).toBeFocused();
    await page.screenshot({
      path: `test-results/directory-${width}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.getByRole("button", { name: /^Save host / }).click();
    await page.getByRole("button", { name: "Saved hosts (1)", exact: true }).click();
    state.entries = [];
    await page.getByRole("button", { name: "Refresh listings", exact: true }).click();
    await expect(page.getByText("Not currently listed", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    // Reset capture scroll so Chromium does not paint off-screen fixed elements
    // into a full-page screenshot at the previous scroll offset.
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    expect(
      await page
        .getByRole("link", { name: "Skip to content", exact: true })
        .evaluate((link) => link.getBoundingClientRect().bottom),
    ).toBeLessThanOrEqual(0);
    await page.screenshot({
      path: `test-results/saved-host-${width}.png`,
      fullPage: true,
      animations: "disabled",
    });
  });
test("standalone directory serves its own client surface", async ({ page, request }) => {
  test.skip(!process.env.HOSTAI_DIRECTORY_TEST_URL, "Explicit isolated directory required");
  const origin = new URL(process.env.HOSTAI_DIRECTORY_TEST_URL!).origin;
  expect(new URL(origin).hostname).toBe("127.0.0.1");
  expect(new URL(origin).protocol).toBe("http:");
  const { generateKeyPairSync, sign } = await import("node:crypto");
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  async function mutate(operation: "publish" | "withdraw") {
    const challenge = await request.post(`${origin}/registry/v2/challenges`, {
      data: { publicKey },
    });
    expect(challenge.status()).toBe(200);
    const payload = Buffer.from(
      JSON.stringify({
        version: 2,
        audience: origin,
        nonce: (await challenge.json()).nonce,
        operation,
        listing:
          operation === "withdraw"
            ? null
            : {
                hostLabel: "Directory browser fixture",
                model: "directory-browser:small",
                guestUrl: "https://directory-browser-fixture.trycloudflare.com/",
                invitationRequired: true,
                requestsAccepted: true,
              },
      }),
    );
    const result = await request.post(`${origin}/registry/v2/listings`, {
      data: {
        publicKey,
        payload: payload.toString("base64url"),
        signature: sign(null, payload, pair.privateKey).toString("base64url"),
      },
    });
    expect(result.status()).toBe(200);
  }
  await mutate("publish");
  try {
    if (process.env.HOSTAI_INTEGRATION === "1") {
      expect(
        (
          await page.request.get("/api/directory/listings", {
            headers: { "Sec-Fetch-Site": "cross-site" },
          })
        ).status(),
      ).toBe(403);
      await page.goto("/hosts");
      const status = await (await page.request.get("/api/directory")).json();
      expect(status.configured).toBe(true);
      expect(new URL(status.registryUrl).origin).toBe(origin);
      await expect(
        page.getByRole("heading", { name: "directory-browser:small", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Save host Directory browser fixture", exact: true })
        .click();
    }
    await page.goto(origin);
    await expect(
      page.getByRole("heading", { name: "Find a model host", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCount(0);
    await expect(page.getByText("The host must approve access.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Saved hosts (0)", exact: true })).toBeVisible();
    await page.getByLabel("Requests reported open", { exact: true }).check();
    await page.getByLabel("Search model or host").fill("directory-browser");
    await expect(
      page.getByRole("heading", { name: "directory-browser:small", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open guest chat for Directory browser fixture" }),
    ).toHaveAttribute("href", "https://directory-browser-fixture.trycloudflare.com/");
    await page.screenshot({
      path: "test-results/directory-standalone.png",
      fullPage: true,
      animations: "disabled",
    });
    await page
      .getByRole("button", { name: "Save host Directory browser fixture", exact: true })
      .click();
    await page.getByRole("button", { name: "Saved hosts (1)", exact: true }).click();
    await mutate("withdraw");
    await page.getByLabel("Requests reported open", { exact: true }).uncheck();
    await page.getByRole("button", { name: "Refresh listings", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "directory-browser:small", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Not currently listed", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: /Open guest chat for/ })).toHaveCount(0);
  } finally {
    await mutate("withdraw");
  }
});

test("saved hosts survive reload, remain visible when absent, and support undo without storing URLs", async ({
  page,
}) => {
  const state = await directory(page);
  await page.goto("/hosts");
  await page.getByRole("button", { name: "Save host Alice’s shared model", exact: true }).click();
  await page.getByRole("button", { name: "Saved hosts (1)", exact: true }).click();
  await expect(page.getByRole("link", { name: /Open guest chat for/ })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Saved hosts (1)", exact: true }).click();
  state.entries = [];
  await page.getByRole("button", { name: "Refresh listings", exact: true }).click();
  await expect(page.getByText("Not currently listed", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Open guest chat for/ })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "fixture-model:small", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/saved-host-absent.png",
    fullPage: true,
    animations: "disabled",
  });
  const data = await page.evaluate(() => ({ ...localStorage }));
  expect(Object.keys(data)).toHaveLength(1);
  expect(JSON.parse(Object.values(data)[0])).toEqual({
    id: host().id,
    hostLabel: host().hostLabel,
    model: host().model,
  });
  expect(JSON.stringify(data)).not.toMatch(/trycloudflare|access|guestUrl/);
  await page
    .getByRole("button", { name: "Remove saved host Alice’s shared model", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "No saved hosts yet" })).toBeVisible();
  await expect(page.getByText("Last removal:", { exact: false })).toContainText(
    "Alice’s shared model",
  );
  await page.screenshot({
    path: "test-results/saved-host-undo.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Undo remove", exact: true }).click();
  await expect(page.getByText("Not currently listed", { exact: true })).toBeVisible();
  expect(state.unexpected).toEqual([]);
});

test("saved model changes require acknowledgement and only current fresh addresses can open", async ({
  page,
}) => {
  const state = await directory(page);
  await page.goto("/hosts");
  await page.getByRole("button", { name: "Save host Alice’s shared model", exact: true }).click();
  await page.getByRole("button", { name: "Saved hosts (1)", exact: true }).click();
  state.entries = [
    { ...host("a", "changed-model:large"), guestUrl: "https://changed-fixture.trycloudflare.com/" },
  ];
  await page.getByRole("button", { name: "Refresh listings", exact: true }).click();
  await expect(page.getByText(/Model changed. Saved model: fixture-model:small/)).toBeVisible();
  await expect(page.getByRole("link", { name: /Open guest chat for/ })).toHaveCount(0);
  await page.screenshot({
    path: "test-results/saved-host-model-changed.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Use current model", exact: true }).click();
  await expect(page.getByRole("link", { name: /Open guest chat for/ })).toHaveAttribute(
    "href",
    "https://changed-fixture.trycloudflare.com/",
  );
  await page.evaluate(() => {
    const now = Date.now;
    Date.now = () => now() + 3600000;
    document
      .querySelector<HTMLAnchorElement>('a[aria-label="Open guest chat for Alice’s shared model"]')!
      .click();
  });
  await expect(page.getByText("Listing expired", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Open guest chat for/ })).toHaveCount(0);
  expect(state.unexpected).toEqual([]);
});

test("saved views reject failed checks and wrong-registry provenance and isolate changed configuration", async ({
  page,
}) => {
  const state = await directory(page);
  await page.goto("/hosts");
  await page.getByRole("button", { name: "Save host Alice’s shared model", exact: true }).click();
  await page.getByRole("button", { name: "Saved hosts (1)", exact: true }).click();
  state.fail = true;
  await page.reload();
  await page.getByRole("button", { name: "Saved hosts (1)", exact: true }).click();
  await expect(page.getByText("1 saved host.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh listings", exact: true }).click();
  await expect(page.getByText("Check unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Open guest chat for/ })).toHaveCount(0);
  state.fail = false;
  let mismatched = true;
  await page.route("**/api/directory/listings", (route) =>
    mismatched
      ? route.fulfill({
          json: {
            version: 2,
            registryUrl: "https://other.example",
            servedAt: now,
            listings: [host()],
          },
        })
      : route.fallback(),
  );
  await page.getByRole("button", { name: "Refresh listings", exact: true }).click();
  await expect(page.getByText("Check unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Open guest chat for/ })).toHaveCount(0);
  mismatched = false;
  state.config.registryUrl = "https://other.example/";
  await expect(page.getByRole("button", { name: "Saved hosts (0)", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Saved hosts (0)", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No saved hosts yet" })).toBeVisible();
  state.config.registryUrl = "https://directory.example/";
  await expect(page.getByRole("button", { name: "Saved hosts (1)", exact: true })).toBeVisible();
  expect(state.unexpected).toEqual([]);
});

test("storage failures are visible and corrupt saved data is never overwritten", async ({
  page,
}) => {
  const state = await directory(page);
  await page.addInitScript(() => {
    Reflect.set(window, "blockHostSaves", true);
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("hostai.saved-host.") && Reflect.get(window, "blockHostSaves"))
        throw new Error("private storage failure");
      original.call(this, key, value);
    };
  });
  await page.goto("/hosts");
  await page.getByRole("button", { name: "Save host Alice’s shared model", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("This change could not be saved");
  await expect(page.getByRole("button", { name: "Saved hosts", exact: true })).toBeVisible();
  expect(await page.content()).not.toContain("private storage failure");
  await page.evaluate(() => Reflect.set(window, "blockHostSaves", false));
  await page.getByRole("button", { name: "Check saved hosts", exact: true }).click();
  await page.getByRole("button", { name: "Save host Alice’s shared model", exact: true }).click();
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) => key.startsWith("hostai.saved-host."))!;
    localStorage.setItem(key, "{damaged");
  });
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("Saved hosts could not be read");
  expect(await page.evaluate(() => Object.values(localStorage))).toEqual(["{damaged"]);
  await page.getByRole("button", { name: "Saved hosts", exact: true }).click();
  await expect(page.getByText("Saved host count unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Saved hosts unavailable" })).toBeVisible();
  await page.screenshot({
    path: "test-results/saved-host-storage-error.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "All listings", exact: true }).click();
  await expect(page.getByRole("link", { name: /Open guest chat for/ })).toBeVisible();
  expect(state.unexpected).toEqual([]);
});

test("a saved write followed by a failed reread is reported honestly and recovers", async ({
  page,
}) => {
  const state = await directory(page);
  await page.goto("/hosts");
  await expect(page.getByRole("button", { name: "Saved hosts (0)", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    const get = Storage.prototype.getItem;
    Storage.prototype.setItem = function (key, value) {
      set.call(this, key, value);
      Reflect.set(window, "failSavedRead", true);
    };
    Storage.prototype.getItem = function (key) {
      if (key.startsWith("hostai.saved-host.") && Reflect.get(window, "failSavedRead"))
        throw new Error("private read failure");
      return get.call(this, key);
    };
  });
  await page.getByRole("button", { name: "Save host Alice’s shared model", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("The change reached browser storage");
  expect(await page.evaluate(() => localStorage.length)).toBe(1);
  await page.evaluate(() => Reflect.set(window, "failSavedRead", false));
  await page.getByRole("button", { name: "Check saved hosts", exact: true }).click();
  await expect(page.getByRole("button", { name: "Saved hosts (1)", exact: true })).toBeVisible();
  state.entries = [{ ...host(), model: "changed:large" }];
  await page.getByRole("button", { name: "Refresh listings", exact: true }).click();
  await page.getByRole("button", { name: "Use current model", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("The change reached browser storage");
  await expect(page.getByRole("link", { name: /Open guest chat for/ })).toBeVisible();
  await expect(page.getByText(/Current model reviewed for this view/)).toBeVisible();
  await page.screenshot({
    path: "test-results/saved-host-model-recovery.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.evaluate(() => Reflect.set(window, "failSavedRead", false));
  await page.getByRole("button", { name: "Check saved model", exact: true }).click();
  await expect(page.getByRole("link", { name: /Open guest chat for/ })).toBeVisible();
  expect(state.unexpected).toEqual([]);
});

test("saved-host changes synchronize between tabs without dropping other hosts", async ({
  page,
  context,
}) => {
  const state = await directory(page);
  state.entries.push({ ...host("b"), hostLabel: "Bob’s host" });
  await page.goto("/hosts");
  const other = await context.newPage();
  try {
    const second = await directory(other);
    second.entries = state.entries;
    await other.goto("/hosts");
    await page.getByRole("button", { name: "Save host Alice’s shared model", exact: true }).click();
    await expect(other.getByRole("button", { name: "Saved hosts (1)", exact: true })).toBeVisible();
    await other.getByRole("button", { name: "Save host Bob’s host", exact: true }).click();
    await expect(page.getByRole("button", { name: "Saved hosts (2)", exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "Remove saved host Alice’s shared model", exact: true })
      .click();
    await expect(other.getByRole("button", { name: "Saved hosts (1)", exact: true })).toBeVisible();
    expect(second.unexpected).toEqual([]);
  } finally {
    await other.close();
  }
  expect(state.unexpected).toEqual([]);
});

test("a delayed storage event cannot turn Save into an unintended removal", async ({ page }) => {
  const state = await directory(page);
  await page.goto("/hosts");
  const save = page.getByRole("button", { name: "Save host Alice’s shared model", exact: true });
  await expect(save).toBeEnabled();
  const remembered = { id: host().id, hostLabel: host().hostLabel, model: "previous:small" };
  // Same-page storage writes do not dispatch an event: this models another tab's
  // write reaching storage before its event reaches this rendered control.
  await page.evaluate(
    (entry) =>
      localStorage.setItem(
        `hostai.saved-host.v1:${encodeURIComponent("https://directory.example")}:${entry.id}`,
        JSON.stringify(entry),
      ),
    remembered,
  );
  await save.click();
  expect(
    await page.evaluate(() => Object.values(localStorage).map((value) => JSON.parse(value))),
  ).toEqual([remembered]);
  await expect(page.getByRole("button", { name: "Use current model", exact: true })).toBeVisible();
  await page.evaluate(() => localStorage.clear());
  await page
    .getByRole("button", { name: "Remove saved host Alice’s shared model", exact: true })
    .click();
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test("request availability filters informed choices without contacting hosts and follows refreshed reports", async ({
  page,
}) => {
  const state = await directory(page);
  state.entries[0].requestsAccepted = true;
  state.entries.push({
    ...host("b", "closed-model:small"),
    hostLabel: "Closed host",
    requestsAccepted: false,
  });
  state.entries.push({ ...host("c", "legacy-model:small"), hostLabel: "Legacy host" });
  await page.goto("/hosts");
  const rows = page.getByRole("region", { name: "Host listings" }).getByRole("listitem");
  await expect(rows).toHaveCount(3);
  await expect(page.getByText("Requests reported closed · existing key needed")).toBeVisible();
  await expect(page.getByText("Request availability not reported")).toBeVisible();
  await rows.last().scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "test-results/directory-request-report-desktop.png",
    animations: "disabled",
  });
  await page.getByLabel("Requests reported open", { exact: true }).check();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Alice’s shared model");
  await page.getByRole("button", { name: "Save host Alice’s shared model", exact: true }).click();
  await page.getByRole("button", { name: "Saved hosts (1)", exact: true }).click();
  await expect(rows).toHaveCount(1);
  state.entries[0].requestsAccepted = false;
  await page.getByRole("button", { name: "Refresh listings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No matching saved hosts", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Requests reported open", { exact: true }).uncheck();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Requests reported closed");
  await expect(page.getByRole("link", { name: /Open guest chat for/ })).toBeVisible();
  expect(state.unexpected).toEqual([]);
});

test("request report filter explains empty results and remains usable on a narrow screen", async ({
  page,
}) => {
  const state = await directory(page);
  await page.setViewportSize({ width: 320, height: 1100 });
  await page.goto("/hosts");
  await page.getByLabel("Requests reported open", { exact: true }).check();
  await expect(
    page.getByRole("heading", { name: "No matching hosts report requests open" }),
  ).toBeVisible();
  await expect(page.getByText(/Existing invitation keys may still work/)).toBeVisible();
  await page.getByLabel("Requests reported open", { exact: true }).uncheck();
  await expect(page.getByText("Request availability not reported")).toBeVisible();
  await page.getByRole("region", { name: "Host listings" }).scrollIntoViewIfNeeded();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: "test-results/directory-request-report-mobile.png",
    animations: "disabled",
  });
  expect(state.unexpected).toEqual([]);
});

test("requests-open filter excludes expired reports in both all and saved views", async ({
  page,
}) => {
  const state = await directory(page);
  state.entries[0].requestsAccepted = true;
  state.entries[0].updatedAt = now - 95000;
  state.entries[0].expiresAt = now - 5000;
  state.entries.push({
    ...host("b", "fresh-model:small"),
    hostLabel: "Fresh host",
    requestsAccepted: true,
  });
  await page.goto("/hosts");
  await page.getByLabel("Include expired listings").check();
  await page.getByRole("button", { name: "Save host Alice’s shared model", exact: true }).click();
  await page.getByLabel("Requests reported open", { exact: true }).check();
  await expect(page.getByRole("heading", { name: "fresh-model:small", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "fixture-model:small", exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Saved hosts (1)", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No matching saved hosts", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Requests reported open", { exact: true }).uncheck();
  await expect(page.getByText("Listing expired", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Open guest chat for/ })).toHaveCount(0);
  expect(state.unexpected).toEqual([]);
});

for (const width of [320, 1440]) {
  test(`model review remains usable with failed storage at ${width}px and never accepts a later change`, async ({
    page,
  }) => {
    const state = await directory(page);
    await page.setViewportSize({ width, height: 1100 });
    await page.goto("/hosts");
    await page.getByRole("button", { name: "Save host Alice’s shared model", exact: true }).click();
    await page.getByRole("button", { name: "Saved hosts (1)", exact: true }).click();
    await page.evaluate(() => {
      const set = Storage.prototype.setItem;
      Reflect.set(window, "blockedSaveAttempts", 0);
      Reflect.set(window, "blockHostSaves", true);
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith("hostai.saved-host.") && Reflect.get(window, "blockHostSaves")) {
          Reflect.set(
            window,
            "blockedSaveAttempts",
            Reflect.get(window, "blockedSaveAttempts") + 1,
          );
          throw new Error("private quota failure");
        }
        set.call(this, key, value);
      };
    });
    const refresh = page.getByRole("button", { name: "Refresh listings", exact: true });
    const review = page.getByRole("button", { name: "Use current model", exact: true });
    const open = page.getByRole("link", {
      name: "Open guest chat for Alice’s shared model",
      exact: true,
    });
    state.entries = [host("a", "second-model:small")];
    await refresh.click();
    await review.focus();
    await page.keyboard.press("Enter");
    await expect(open).toBeFocused();
    await expect(page.getByRole("alert")).toContainText("This change could not be saved");
    await expect(page.getByText(/Current model reviewed for this view/)).toBeVisible();
    await expect(open).toHaveAccessibleDescription(
      /Saved details have not been confirmed as updated/,
    );
    expect(
      await page.evaluate(
        () =>
          JSON.parse(
            localStorage.getItem(
              Object.keys(localStorage).find((key) => key.startsWith("hostai.saved-host."))!,
            )!,
          ).model,
      ),
    ).toBe("fixture-model:small");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    // A viewport capture preserves the narrow layout and fixed header without
    // Chromium's full-page scrollbar/capture reflow. Include the recovery controls.
    await page
      .getByRole("button", { name: "Check saved model", exact: true })
      .evaluate((element) => element.scrollIntoView({ block: "end" }));
    await page.screenshot({
      path: `test-results/saved-model-review-${width}.png`,
      animations: "disabled",
    });

    // A review of one model must not authorize the next, even with writes already blocked.
    state.entries = [host("a", "third-model:small")];
    await refresh.click();
    await expect(open).toHaveCount(0);
    await expect(review).toBeEnabled();
    await review.click();
    await expect(open).toBeFocused();
    expect(await page.evaluate(() => Reflect.get(window, "blockedSaveAttempts"))).toBe(1);
    state.entries = [host("a", "second-model:small")];
    await refresh.click();
    await expect(open).toHaveCount(0);
    await review.click();
    await expect(open).toBeVisible();

    // An unavailable directory still blocks opening after review.
    state.fail = true;
    await refresh.click();
    await expect(open).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Refresh before opening", exact: true }),
    ).toBeDisabled();
    state.fail = false;
    await refresh.click();
    await expect(open).toBeVisible();

    // Leaving the listing drops a temporary review; the old bookmark is preserved.
    await page.getByLabel("Search model or host").fill("no such host");
    await expect(open).toHaveCount(0);
    await page.getByRole("button", { name: "Clear search", exact: true }).click();
    await expect(review).toBeEnabled();
    await review.click();
    await expect(open).toBeFocused();
    await page.reload();
    await expect(open).toHaveCount(0);
    await expect(review).toBeEnabled();
    expect(state.unexpected).toEqual([]);
  });
}

test("checking storage after a failed model update does not claim a save and allows an explicit retry", async ({
  page,
}) => {
  const state = await directory(page);
  await page.goto("/hosts");
  await page.getByRole("button", { name: "Save host Alice’s shared model", exact: true }).click();
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    Reflect.set(window, "blockHostSaves", true);
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("hostai.saved-host.") && Reflect.get(window, "blockHostSaves"))
        throw new Error("quota");
      set.call(this, key, value);
    };
  });
  state.entries = [host("a", "new-model:small")];
  await page.getByRole("button", { name: "Refresh listings", exact: true }).click();
  await page.getByRole("button", { name: "Use current model", exact: true }).click();
  const open = page.getByRole("link", { name: /Open guest chat for/ });
  await expect(open).toBeFocused();
  await page.evaluate(() => Reflect.set(window, "blockHostSaves", false));
  await page.getByRole("button", { name: "Check saved model", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText(/Model changed. Saved model: fixture-model:small/)).toBeVisible();
  await expect(open).toBeVisible();
  state.fail = true;
  await page.getByRole("button", { name: "Refresh listings", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Update saved model", exact: true }),
  ).toBeDisabled();
  await expect(open).toHaveCount(0);
  state.fail = false;
  await page.getByRole("button", { name: "Refresh listings", exact: true }).click();
  await page.evaluate(() => Reflect.set(window, "blockHostSaves", true));
  await expect(page.getByRole("button", { name: "Update saved model", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Update saved model", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(open).toBeFocused();
  await expect(page.getByRole("alert")).toContainText("This change could not be saved");
  await expect(open).toHaveAccessibleDescription(
    /Saved details have not been confirmed as updated/,
  );
  await page.evaluate(() => Reflect.set(window, "blockHostSaves", false));
  await page.getByRole("button", { name: "Check saved model", exact: true }).click();
  await expect(page.getByRole("button", { name: "Update saved model", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Update saved model", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(open).toBeFocused();
  await expect(open).not.toHaveAttribute("aria-describedby");
  await expect(
    page.getByText("Saved model updated. Open guest chat when you are ready."),
  ).toBeVisible();
  await expect(page.getByText(/Model changed. Saved model:/)).toHaveCount(0);
  await page.reload();
  await expect(open).toBeVisible();
  expect(state.unexpected).toEqual([]);
});
