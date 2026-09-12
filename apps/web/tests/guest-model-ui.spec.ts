import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

// Like guest.spec.ts: the owner baseURL is never used. The runner supplies the
// isolated guest bundle URL and proves the private display separately.
test.skip(
  !process.env.HOSTAI_GUEST_TEST_URL,
  "HOSTAI_GUEST_TEST_URL must name the isolated guest listener",
);

const access = "fixture-access-key";
const model = "pebby:latest";

// The real bridge script, so the guest host side is exercised against the shipped frame side.
const bridge = readFileSync(
  fileURLToPath(
    new URL("../../../backend/src/main/resources/hostai/hostai-bridge.js", import.meta.url),
  ),
  "utf8",
);

const stubPage = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Stub interface</title>
    <script src="hostai-bridge.js"></script>
  </head>
  <body>
    <h1>Stub runtime interface</h1>
    <p id="hello">waiting</p>
    <p id="result">none</p>
    <script>
      hostai.ready().then(function (hello) {
        document.getElementById("hello").textContent =
          hello.model + " " + hello.scope + " " + hello.theme;
        return hostai.infer({ ping: 1 });
      }).then(function (events) {
        document.getElementById("result").textContent = "pong " + JSON.stringify(events);
      }, function (error) {
        document.getElementById("result").textContent = "error " + error.message;
      });
    </script>
  </body>
</html>`;

type GuestTestWindow = typeof window & { guestTest: { cspViolations: string[] } };

async function fixture(page: Page, scope: "local-preview" | "temporary-internet") {
  const state = {
    sessionRequests: [] as string[],
    inferBodies: [] as unknown[],
    inferKeys: [] as string[],
    inferHeaders: [] as Record<string, string>[],
    socketUrls: [] as string[],
    socketEnvelopes: [] as Record<string, unknown>[],
    httpInfers: 0,
    unexpected: [] as string[],
  };
  const origin = new URL(process.env.HOSTAI_GUEST_TEST_URL!).origin;
  // Fail closed: unrecognized API calls can never reach an owner app or a model.
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (
      url.origin === origin &&
      (route.request().isNavigationRequest() ||
        url.pathname.startsWith("/assets/") ||
        url.pathname === "/favicon.ico")
    )
      return route.continue();
    state.unexpected.push(url.pathname);
    return route.abort();
  });
  await page.route("**/guest/v1/session", (route) => {
    state.sessionRequests.push(route.request().headers().authorization || "");
    return route.fulfill({
      json: {
        hostLabel: "A host's chosen name",
        model,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        available: true,
        unavailableReason: null,
        maxConcurrentGuests: 1,
        maxTokens: 1024,
        requestsPerMinute: 6,
        scope,
        ui: { runtime: "stub", entry: "ui/index.html" },
      },
    });
  });
  await page.route("**/guest/v1/model-ui/stub/ui/index.html", (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: stubPage }),
  );
  await page.route("**/guest/v1/model-ui/stub/ui/hostai-bridge.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: bridge }),
  );
  await page.route("**/guest/v1/infer", (route) => {
    state.httpInfers++;
    state.inferBodies.push(route.request().postDataJSON());
    state.inferHeaders.push(route.request().headers());
    state.inferKeys.push(route.request().headers().authorization || "");
    return route.fulfill({
      contentType: "application/x-ndjson",
      body: '{"event":{"pong":1},"done":false}\n{"done":true}\n',
    });
  });
  await page.routeWebSocket("**/guest/v1/chat-stream", (socket) => {
    state.socketUrls.push(socket.url());
    socket.onMessage((message) => {
      const envelope = JSON.parse(String(message)) as Record<string, unknown>;
      state.socketEnvelopes.push(envelope);
      socket.send(JSON.stringify({ event: { pong: 1 }, done: false }));
      socket.send(JSON.stringify({ done: true }));
    });
  });
  await page.addInitScript(() => {
    const state: GuestTestWindow["guestTest"] = { cspViolations: [] };
    (window as GuestTestWindow).guestTest = state;
    document.addEventListener("securitypolicyviolation", (event) => {
      state.cspViolations.push(event.violatedDirective);
    });
  });
  return state;
}

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

async function expectFrameWorks(page: Page) {
  await expect(page.locator("#guest-access-status")).toHaveText(
    "Access was available at the last check.",
  );
  await expect(page.getByRole("heading", { name: "Model interface", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Conversation", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Message", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toHaveCount(0);
  await expect(page.locator("form[aria-label='Message composer']")).toHaveCount(0);
  await expect(page.getByText(/512 output tokens/)).toHaveCount(0);
  await expect(page.getByText(/Interface provided by the stub runtime/)).toBeVisible();
  await expect(page.locator("#guest-retention")).toContainText(
    "model interface keeps its own state in this tab and HostAI does not store it",
  );
  const frame = page.locator(`iframe[title='${model} interface']`);
  await expect(frame).toHaveCount(1);
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(frame).toHaveAttribute("src", "/guest/v1/model-ui/stub/ui/index.html");
  const inner = page.frameLocator(`iframe[title='${model} interface']`);
  await expect(inner.locator("#hello")).toHaveText(`${model} guest light`);
  await expect(inner.locator("#result")).toHaveText('pong [{"pong":1}]');
}

test("a runtime interface replaces the guest composer and reaches /guest/v1/infer with the bearer key", async ({
  page,
}) => {
  const state = await fixture(page, "local-preview");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.env.HOSTAI_GUEST_TEST_URL! + "#access=" + encodeURIComponent(access));
  await expectFrameWorks(page);

  expect(state.sessionRequests).toEqual([`Bearer ${access}`]);
  expect(state.httpInfers).toBe(1);
  expect(state.inferKeys).toEqual([`Bearer ${access}`]);
  expect(state.inferBodies).toEqual([{ model, input: { ping: 1 } }]);
  expect(state.inferHeaders[0]["content-type"]).toBe("application/json");
  expect(state.socketUrls).toEqual([]);
  // The key never reaches the frame or the document.
  expect(await page.content()).not.toContain(access);
  expect(await page.frame({ url: /model-ui/ })!.content()).not.toContain(access);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  expect(await page.evaluate(() => (window as GuestTestWindow).guestTest.cspViolations)).toEqual(
    [],
  );
  expect(state.unexpected).toEqual([]);
  expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/guest-model-ui.png", fullPage: true });

  // Disconnecting drops the frame; the key form returns and nothing else is requested.
  await useGuestMenu(page, "Disconnect");
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.getByLabel("Access key", { exact: true })).toBeVisible();
  expect(state.httpInfers).toBe(1);
});

test("temporary internet access sends the infer envelope as the first WebSocket message", async ({
  page,
}) => {
  const state = await fixture(page, "temporary-internet");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.env.HOSTAI_GUEST_TEST_URL!);
  await page.getByLabel("Access key", { exact: true }).fill(access);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expectFrameWorks(page);

  expect(state.httpInfers).toBe(0);
  expect(state.socketUrls).toHaveLength(1);
  expect(state.socketUrls[0]).not.toContain(access);
  expect(new URL(state.socketUrls[0]).protocol).toBe("wss:");
  expect(state.socketEnvelopes).toEqual([{ key: access, infer: { model, input: { ping: 1 } } }]);
  expect(Object.keys(state.socketEnvelopes[0])).toEqual(["key", "infer"]);
  expect(await page.content()).not.toContain(access);
  expect(await page.evaluate(() => (window as GuestTestWindow).guestTest.cspViolations)).toEqual(
    [],
  );
  expect(state.unexpected).toEqual([]);
  expect(errors).toEqual([]);
});
