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
        : { version: 1, servedAt: state.servedAt, listings: state.entries },
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
  await page.screenshot({ path: "test-results/directory-unconfigured.png", fullPage: true });
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
  await expect(page.getByText("An invitation is still required.")).toBeVisible();
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
  await page.screenshot({ path: "test-results/directory-refresh-failed.png", fullPage: true });
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
    await expect(page.getByLabel("Include expired listings")).toBeFocused();
    await page.screenshot({ path: `test-results/directory-${width}.png`, fullPage: true });
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
    const challenge = await request.post(`${origin}/registry/v1/challenges`, {
      data: { publicKey },
    });
    expect(challenge.status()).toBe(200);
    const payload = Buffer.from(
      JSON.stringify({
        version: 1,
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
              },
      }),
    );
    const result = await request.post(`${origin}/registry/v1/listings`, {
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
    }
    await page.goto(origin);
    await expect(
      page.getByRole("heading", { name: "Find a model host", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCount(0);
    await expect(page.getByText("An invitation is still required.")).toBeVisible();
    await page.getByLabel("Search model or host").fill("directory-browser");
    await expect(
      page.getByRole("heading", { name: "directory-browser:small", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open guest chat for Directory browser fixture" }),
    ).toHaveAttribute("href", "https://directory-browser-fixture.trycloudflare.com/");
    await page.screenshot({ path: "test-results/directory-standalone.png", fullPage: true });
    await mutate("withdraw");
    await page.getByRole("button", { name: "Refresh listings", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "directory-browser:small", exact: true }),
    ).toHaveCount(0);
  } finally {
    await mutate("withdraw");
  }
});
