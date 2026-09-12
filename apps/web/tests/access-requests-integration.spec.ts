import { expect, test, type Page } from "@playwright/test";

// Explicit disposable backend/model fixture only. The public tunnel is real;
// No models are downloaded; guest access uses a directly shared link and host approval.
/**
 * The guest's connection controls live in the header's session menu, a native
 * <details> that starts closed. Guard against an already-open menu (clicking the
 * summary toggles), and close it afterwards so the sheet cannot cover the page.
 */
async function useGuestMenu(page: Page, name: string) {
  const summary = page.locator("#guest-session-menu");
  if (!(await summary.evaluate((node) => !!node.closest("details")?.open))) await summary.click();
  await page.getByRole("button", { name, exact: true }).click();
  await summary.evaluate((node) => {
    const details = node.closest("details");
    if (details?.open) details.open = false;
  });
}

test.skip(
  process.env.HOSTAI_INTEGRATION !== "1" || process.env.HOSTAI_PUBLIC_INTEGRATION !== "1",
  "Requires the isolated runtime and explicit opt-in to a real public tunnel",
);

test("public guest requests access, host chooses permission, and revocation ends chat", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(210_000);
  const post = async (path: string, data: object = {}) => {
    const response = await request.post(path, { data });
    expect(response.ok(), `${path}: ${response.status()}`).toBe(true);
    return response.json();
  };
  const guestContext = await browser.newContext({ viewport: { width: 768, height: 1100 } });
  const guest = await guestContext.newPage();
  const problems: string[] = [];
  guest.on("pageerror", (error) => problems.push(error.message));
  page.on("pageerror", (error) => problems.push(error.message));
  try {
    const before = await post("/api/sharing/stop");
    const initialKeys = before.grants.length;
    const initialRequests = (await (await request.get("/api/status")).json()).totalRequests;
    await post("/api/sharing/start", {
      model: "test-model:small",
      hostLabel: "Access request fixture",
    });
    await post("/api/sharing/internet/start");
    let status: { internet: { state: string; publicUrl: string | null } };
    await expect
      .poll(
        async () => {
          status = await (await request.get("/api/sharing")).json();
          return status.internet.state;
        },
        { timeout: 125_000, intervals: [1000, 2000, 3000] },
      )
      .toBe("live");
    const publicUrl = status!.internet.publicUrl!;
    expect(new URL(publicUrl).hostname).toMatch(/\.trycloudflare\.com$/);
    await page.goto("/sharing");
    const inbox = page.getByRole("region", { name: "Guest access requests", exact: true });
    await expect(inbox.getByText("Access requests are off", { exact: true })).toBeVisible();
    await inbox.getByRole("button", { name: "Allow access requests", exact: true }).click();
    await expect(inbox.getByText("Accepting access requests", { exact: true })).toBeVisible();

    await guest.goto(publicUrl);
    // The key form is the primary way in; asking the host waits behind its disclosure.
    await expect(guest.getByLabel("Access key", { exact: true })).toBeFocused();
    await guest.getByText("No key? Ask the host for access", { exact: true }).click();
    await guest.getByLabel("Your name", { exact: true }).fill("Fixture visitor");
    await guest.getByRole("button", { name: "Request access", exact: true }).click();
    await expect(
      guest.getByText("Waiting for the host to review your request.", { exact: true }),
    ).toBeVisible();
    await expect(inbox.getByRole("heading", { name: "Fixture visitor", exact: true })).toBeVisible({
      timeout: 12_000,
    });
    await expect(inbox.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
    expect((await (await request.get("/api/sharing")).json()).grants).toHaveLength(initialKeys);
    expect((await (await request.get("/api/status")).json()).totalRequests).toBe(initialRequests);
    const pending = (await (await request.get("/api/sharing")).json()).requests.items[0];
    await expect(
      guest.getByText(`${pending.code.slice(0, 3)}-${pending.code.slice(3)}`, { exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 320, height: 1100 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await inbox.screenshot({ path: "test-results/access-requests-owner-320.png" });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await inbox.screenshot({ path: "test-results/access-requests-owner-1440.png" });
    await guest.setViewportSize({ width: 320, height: 1100 });
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await guest.screenshot({
      path: "test-results/access-requests-guest-pending-320.png",
      fullPage: true,
    });
    await guest.setViewportSize({ width: 768, height: 1100 });

    await inbox.getByLabel(/^Access duration for Fixture visitor/).selectOption("1");
    await inbox.getByRole("button", { name: "Approve", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(guest.getByRole("button", { name: "Connect to model", exact: true })).toBeEnabled({
      timeout: 12_000,
    });
    await guest.screenshot({
      path: "test-results/access-requests-guest-approved.png",
      fullPage: true,
    });
    expect((await (await request.get("/api/status")).json()).totalRequests).toBe(initialRequests);
    expect(
      await guest.evaluate(() => ({
        hash: location.hash,
        local: localStorage.length,
        session: sessionStorage.length,
      })),
    ).toEqual({ hash: "", local: 0, session: 0 });
    await guest.getByRole("button", { name: "Connect to model", exact: true }).click();
    await expect(guest.getByRole("textbox", { name: "Message", exact: true })).toBeEnabled();
    expect((await (await request.get("/api/status")).json()).totalRequests).toBe(initialRequests);
    await guest.getByRole("textbox", { name: "Message", exact: true }).fill("Hello fixture");
    await guest.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(
      guest.getByText(/Hello from the isolated test runtime\. Stream complete\./),
    ).toBeVisible({ timeout: 15_000 });
    await guest
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Revoke during generation");
    await guest.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(guest.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
    await expect(
      guest.getByText("Hello from the isolated test runtime.", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => (await (await request.get("/api/status")).json()).activeRequests)
      .toBe(1);
    await page.getByRole("button", { name: /^Revoke Request · Fixture visitor/ }).click();
    await expect(guest.getByText(/invalid|expired|ended|revoked/i).first()).toBeVisible({
      timeout: 12_000,
    });
    await expect
      .poll(async () => (await (await request.get("/api/status")).json()).activeRequests)
      .toBe(0);
    // A midstream interruption cannot identify its cause until a new metadata check.
    // Reconnect is explicit and must reveal revocation without starting inference.
    await useGuestMenu(guest, "Reconnect");
    await expect(
      guest.getByText("The host revoked this request’s access.", { exact: true }),
    ).toBeVisible({ timeout: 12_000 });
    await expect(guest.getByRole("button", { name: "Connect to model", exact: true })).toHaveCount(
      0,
    );
    await guest.screenshot({
      path: "test-results/access-requests-guest-revoked.png",
      fullPage: true,
    });
    expect(problems).toEqual([]);
  } finally {
    await guestContext.close();
    await request.post("/api/sharing/stop", { data: {} });
  }
});
