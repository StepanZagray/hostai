import { expect, test, type Page } from "@playwright/test";

// The owner baseURL is deliberately never used by these tests. The main runner
// supplies the Java guest listener URL and proves the private display separately.
test.skip(
  !process.env.HOSTAI_GUEST_TEST_URL,
  "HOSTAI_GUEST_TEST_URL must name the isolated guest listener",
);

const access = "fixture-access-key";
const model = "fixture-model:small";
const session = () => ({
  hostLabel: "A host's chosen name",
  model,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  available: true,
  unavailableReason: null as string | null,
  maxConcurrentGuests: 1,
  maxTokens: 1024,
  requestsPerMinute: 6,
  scope: "local-preview",
});
type ChatBody = {
  model: string;
  messages: { role: string; content: string }[];
  temperature: number;
  maxTokens: number;
};
type Chunk = { content: string; done: boolean; error?: string };
type GuestTestWindow = typeof window & {
  guestTest: {
    hashes: string[];
    cspViolations: string[];
    aborts: number;
    push?: (chunk: Chunk) => void;
    copied?: string;
  };
};

async function fixture(page: Page) {
  const state = {
    metadata: session(),
    sessionStatus: 200,
    sessionRequests: [] as string[],
    chatStatus: 200,
    chatRequests: [] as ChatBody[],
    chatKeys: [] as string[],
    retryAfter: "0",
    stream: false,
    chunks: [{ content: "A fixture answer.", done: true }] as Chunk[],
    unexpected: [] as string[],
    socketUrls: [] as string[],
    socketClosed: 0,
    httpChats: 0,
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
      status: state.sessionStatus,
      headers: { "Retry-After": state.retryAfter },
      json: state.sessionStatus === 200 ? state.metadata : { error: `Do not echo ${access}` },
    });
  });
  await page.route("**/guest/v1/chat", (route) => {
    state.httpChats++;
    state.chatRequests.push(route.request().postDataJSON());
    state.chatKeys.push(route.request().headers().authorization || "");
    return route.fulfill({
      status: state.chatStatus,
      headers: {
        "Content-Type": "application/x-ndjson",
        "Retry-After": state.retryAfter,
        ...(state.stream ? { "X-Guest-Fixture-Stream": "1" } : {}),
      },
      body:
        state.chatStatus === 200
          ? state.chunks.map((chunk) => JSON.stringify(chunk) + "\n").join("")
          : JSON.stringify({ error: `Do not echo ${access}` }),
    });
  });
  await page.routeWebSocket("**/guest/v1/chat-stream", (socket) => {
    state.socketUrls.push(socket.url());
    socket.onClose(() => {
      state.socketClosed++;
    });
    socket.onMessage((message) => {
      const envelope = JSON.parse(String(message));
      state.chatRequests.push(envelope.request);
      state.chatKeys.push(`Bearer ${envelope.key}`);
      if (state.chatStatus !== 200) {
        socket.send(
          JSON.stringify({
            type: "error",
            status: state.chatStatus,
            retryAfter: Number(state.retryAfter),
          }),
        );
        socket.close();
      } else {
        for (const chunk of state.chunks) socket.send(JSON.stringify(chunk));
      }
    });
  });
  await page.addInitScript(() => {
    const state: GuestTestWindow["guestTest"] = { hashes: [], cspViolations: [], aborts: 0 };
    (window as GuestTestWindow).guestTest = state;
    document.addEventListener("securitypolicyviolation", (event) => {
      state.cspViolations.push(event.violatedDirective);
    });
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          state.copied = text;
        },
      },
    });
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.pathname.startsWith("/guest/v1/")) state.hashes.push(location.hash);
      const response = await original(input, init);
      if (!response.ok || response.headers.get("X-Guest-Fixture-Stream") !== "1") return response;
      // Playwright route.fulfill buffers its body. Replace only our routed fixture
      // response with a controllable stream to exercise real readChatStream/abort.
      await response.body?.cancel();
      let removeAbort = () => {};
      return new Response(
        new ReadableStream({
          start(controller) {
            const abort = () => {
              state.aborts++;
              state.push = undefined;
              controller.error(new DOMException("Stopped", "AbortError"));
              removeAbort();
            };
            removeAbort = () => init?.signal?.removeEventListener("abort", abort);
            state.push = (chunk) => {
              controller.enqueue(new TextEncoder().encode(JSON.stringify(chunk) + "\n"));
              if (chunk.done) {
                controller.close();
                state.push = undefined;
                removeAbort();
              }
            };
            init?.signal?.addEventListener("abort", abort, { once: true });
            if (init?.signal?.aborted) abort();
          },
          cancel() {
            state.push = undefined;
            removeAbort();
          },
        }),
        { headers: { "Content-Type": "application/x-ndjson" } },
      );
    };
  });
  return state;
}

async function openGuest(page: Page, key?: string) {
  if (key === undefined) await page.goto(process.env.HOSTAI_GUEST_TEST_URL!);
  else await page.goto(process.env.HOSTAI_GUEST_TEST_URL! + "#access=" + encodeURIComponent(key));
}
async function connected(page: Page) {
  await openGuest(page, access);
  await expect(
    page.getByText("Access was available at the last check.", { exact: true }),
  ).toBeVisible();
}
async function send(page: Page, text: string) {
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
}
async function push(page: Page, content: string, done = false, error?: string) {
  await page.waitForFunction(() => !!(window as GuestTestWindow).guestTest.push);
  await page.evaluate((chunk) => (window as GuestTestWindow).guestTest.push!(chunk), {
    content,
    done,
    ...(error ? { error } : {}),
  });
}

test("direct invite connects without discovery and is removed before requests under self-only CSP", async ({
  page,
}) => {
  const state = await fixture(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await connected(page);
  expect(new URL(page.url()).hash).toBe("");
  expect(state.sessionRequests).toEqual([`Bearer ${access}`]);
  await expect(page.getByRole("link", { name: "Find a host", exact: true })).toHaveCount(0);
  expect(state.chatRequests).toHaveLength(0);
  expect(await page.evaluate(() => (window as GuestTestWindow).guestTest.hashes)).toEqual([""]);
  expect(await page.content()).not.toContain(access);
  expect(await page.title()).not.toContain(access);
  await expect(page.locator("input[type=password]")).toHaveCount(0);
  await expect(page.locator("script:not([src]), style, [style]")).toHaveCount(0);
  const assets = await page
    .locator("script[src], link[rel=stylesheet]")
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("src") || element.getAttribute("href")),
    );
  expect(assets.length).toBeGreaterThan(1);
  expect(assets.every((path) => /^\/assets\/.+-[\w-]+\.(js|css)$/.test(path || ""))).toBe(true);
  await expect(
    page.getByText("Host-provided name · not a verified identity", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Messages go to the operator of this host/)).toBeVisible();
  await expect(page.getByText(/local-only, with no internet sharing/)).toBeVisible();
  const expectedExpiry = await page.evaluate(
    (value) =>
      new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "long" }).format(
        new Date(value),
      ),
    state.metadata.expiresAt,
  );
  await expect(page.locator("time")).toHaveText(expectedExpiry);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  expect(await page.evaluate(() => (window as GuestTestWindow).guestTest.cspViolations)).toEqual(
    [],
  );
  expect(
    await page.evaluate(() => getComputedStyle(document.documentElement).fontFamily),
  ).toContain("Manrope");
  expect(state.unexpected).toEqual([]);
  expect(errors).toEqual([]);
  await expect(page.getByLabel("Message", { exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: "test-results/guest-connected.png", fullPage: true });
});

test("invalid key has a uniform safe error and no automatic retries", async ({ page }) => {
  const state = await fixture(page);
  state.sessionStatus = 401;
  await openGuest(page);
  expect(state.sessionRequests).toHaveLength(0);
  await expect(page.getByText(/Messages go to the operator of this host/)).toBeVisible();
  await expect(page.getByText(/transport may use a Cloudflare relay/)).toBeVisible();
  await expect(page.getByText(/Cloudflare can see messages and access keys/)).toBeVisible();
  await expect(page.getByText(/local-only, with no internet sharing/)).toHaveCount(0);
  const input = page.getByLabel("Access key", { exact: true });
  await expect(input).toHaveAttribute("type", "password");
  await expect(input).toBeFocused();
  await input.fill(access);
  await input.press("Enter");
  await expect(page.getByRole("alert")).toContainText("A valid access key is required");
  await expect(input).toHaveValue("");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toHaveCount(0);
  expect(await page.content()).not.toContain(access);
  expect(state.sessionRequests).toHaveLength(1);
  expect(state.chatRequests).toHaveLength(0);
  await page.screenshot({ path: "test-results/guest-invalid-key.png", fullPage: true });
});

test("temporary internet metadata enables chat with Cloudflare and host identity disclosures", async ({
  page,
}) => {
  const state = await fixture(page);
  state.metadata.scope = "temporary-internet";
  await page.setViewportSize({ width: 320, height: 900 });
  await openGuest(page);
  await expect(page.getByText(/transport may use a Cloudflare relay/)).toBeVisible();
  await expect(page.getByText("Local preview", { exact: true })).toHaveCount(0);
  await page.getByLabel("Access key", { exact: true }).fill(` ${access} `);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    page.getByText("Access was available at the last check.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Temporary internet access", { exact: true })).toBeVisible();
  const disclosure = page.locator("#guest-disclosure");
  await expect(disclosure).toContainText("This connection uses a Cloudflare relay");
  await expect(disclosure).toContainText(
    "Cloudflare terminates TLS and can see messages and access keys",
  );
  await expect(disclosure).toContainText("host’s name is self-asserted, not a verified identity");
  await expect(
    page.getByText("Host-provided name · not a verified identity", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/local-only, with no internet sharing/)).toHaveCount(0);
  expect(state.chatRequests).toHaveLength(0);
  await send(page, "Hello through the fixture relay");
  await expect(page.getByText("Response complete.", { exact: true })).toBeVisible();
  expect(state.sessionRequests).toEqual([`Bearer ${access}`]);
  expect(state.chatKeys).toEqual([`Bearer ${access}`]);
  expect(state.httpChats).toBe(0);
  expect(state.socketUrls).toHaveLength(1);
  expect(state.socketUrls[0]).not.toContain(access);
  expect(new URL(state.socketUrls[0]).protocol).toBe("wss:");
  expect(await page.content()).not.toContain(access);
  expect(await page.title()).not.toContain(access);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(state.unexpected).toEqual([]);
  await page.screenshot({ path: "test-results/guest-internet-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByText("Temporary internet access", { exact: true })).toHaveCount(0);
  await expect(disclosure).toContainText("transport may use a Cloudflare relay");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toHaveCount(0);
});

test("internet Stop closes its socket, retains the draft and never resubmits automatically", async ({
  page,
}) => {
  const state = await fixture(page);
  state.metadata.scope = "temporary-internet";
  state.chunks = [{ content: "A partial public answer", done: false }];
  await openGuest(page, access);
  await expect(page.getByText("Temporary internet access", { exact: true })).toBeVisible();
  await send(page, "A public prompt");
  await expect(page.getByText("A partial public answer", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => state.socketClosed).toBe(1);
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("A public prompt");
  expect(state.chatRequests).toHaveLength(1);
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  state.chunks = [{ content: "A completed retry", done: true }];
  await send(page, "Edited public prompt");
  await expect(page.getByText("Response complete.", { exact: true })).toBeVisible();
  expect(state.chatRequests[1].messages).toEqual([
    { role: "user", content: "Edited public prompt" },
  ]);
  expect(state.httpChats).toBe(0);
  expect(state.unexpected).toEqual([]);
  await page.screenshot({ path: "test-results/guest-internet-stop.png", fullPage: true });
});

test("internet admission errors preserve the prompt and honor the retry delay", async ({
  page,
}) => {
  const state = await fixture(page);
  state.metadata.scope = "temporary-internet";
  state.chatStatus = 429;
  state.retryAfter = "12";
  await page.clock.install();
  await openGuest(page, access);
  await expect(page.getByText("Temporary internet access", { exact: true })).toBeVisible();
  await send(page, "Retry this public prompt");
  await expect(page.getByRole("alert")).toContainText("busy or the request limit");
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Retry this public prompt");
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeDisabled();
  await page.clock.runFor(12_001);
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeEnabled();
  expect(state.chatRequests).toHaveLength(1);
  expect(state.httpChats).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test("an invite handshake never claims a local transport before metadata arrives", async ({
  page,
}) => {
  const state = await fixture(page);
  state.metadata.scope = "temporary-internet";
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route("**/guest/v1/session", async (route) => {
    requested = true;
    await gate;
    await route.fulfill({ json: state.metadata });
  });
  try {
    await openGuest(page, access);
    await expect.poll(() => requested).toBe(true);
    await expect(page.getByText("Checking guest access…", { exact: true })).toBeVisible();
    await expect(page.getByText(/transport may use a Cloudflare relay/)).toBeVisible();
    await expect(page.getByText(/local-only, with no internet sharing/)).toHaveCount(0);
    expect(new URL(page.url()).hash).toBe("");
    expect(await page.content()).not.toContain(access);
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toHaveCount(0);
    release();
    await expect(page.getByText("Temporary internet access", { exact: true })).toBeVisible();
    expect(state.chatRequests).toHaveLength(0);
    expect(state.unexpected).toEqual([]);
  } finally {
    release();
  }
});

for (const scope of [
  "temporary-internet-extra",
  "Temporary-Internet",
  "local-preview ",
  "",
  "unsupported-scope",
]) {
  test(`unknown guest scope ${JSON.stringify(scope)} fails closed on the initial handshake`, async ({
    page,
  }) => {
    const state = await fixture(page);
    state.metadata.scope = scope;
    await openGuest(page, access);
    await expect(page.getByRole("alert")).toContainText("Could not check guest access");
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toHaveCount(0);
    await expect(page.getByText("Temporary internet access", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Local preview", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/transport may use a Cloudflare relay/)).toBeVisible();
    expect(state.sessionRequests).toHaveLength(1);
    expect(state.chatRequests).toHaveLength(0);
    expect(await page.content()).not.toContain(access);
  });
}

test("oversized invite is scrubbed and rejected locally without guessing token syntax", async ({
  page,
}) => {
  const state = await fixture(page);
  await openGuest(page, "x".repeat(257));
  await expect(page.getByRole("alert")).toContainText("1–256 characters");
  expect(new URL(page.url()).hash).toBe("");
  expect(state.sessionRequests).toHaveLength(0);
  await page.getByLabel("Access key", { exact: true }).fill("fixture+/=key:opaque");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect.poll(() => state.sessionRequests).toEqual(["Bearer fixture+/=key:opaque"]);
});

test("streamed Markdown copies correctly and completed exchanges become context", async ({
  page,
}) => {
  const state = await fixture(page);
  state.stream = true;
  await connected(page);
  await send(page, "# Literal prompt");
  await push(page, "A **streamed** answer.\n\n");
  await expect(page.getByText("# Literal prompt", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Literal prompt", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  const code = "```js\nconst value = 42;\n```";
  await push(page, code, true);
  await expect(page.getByLabel("js code", { exact: true })).toContainText("const value = 42;");
  await page.getByRole("button", { name: "Copy response", exact: true }).click();
  expect(await page.evaluate(() => (window as GuestTestWindow).guestTest.copied)).toBe(
    "A **streamed** answer.\n\n" + code,
  );
  await send(page, "Follow up");
  await push(page, "Finished.", true);
  expect(state.chatRequests[1]).toEqual({
    model,
    temperature: 0.7,
    maxTokens: 512,
    messages: [
      { role: "user", content: "# Literal prompt" },
      { role: "assistant", content: "A **streamed** answer.\n\n" + code },
      { role: "user", content: "Follow up" },
    ],
  });
  expect(state.chatKeys).toEqual([`Bearer ${access}`, `Bearer ${access}`]);
  expect(state.unexpected).toEqual([]);
  await page.screenshot({ path: "test-results/guest-streamed-answer.png", fullPage: true });
});

test("Stop aborts, preserves partial output, and manual retry does not duplicate context", async ({
  page,
}) => {
  const state = await fixture(page);
  state.stream = true;
  await connected(page);
  await send(page, "Try this question");
  await push(page, "An unfinished thought");
  await expect(page.getByText("An unfinished thought", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByText(/Incomplete exchange ·/)).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Try this question");
  await expect(page.getByLabel("Message", { exact: true })).toBeFocused();
  expect(await page.evaluate(() => (window as GuestTestWindow).guestTest.aborts)).toBe(1);
  expect(state.chatRequests).toHaveLength(1);
  await page.getByRole("button", { name: "Copy partial response", exact: true }).click();
  expect(await page.evaluate(() => (window as GuestTestWindow).guestTest.copied)).toBe(
    "An unfinished thought",
  );
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await push(page, "A complete answer", true);
  expect(state.chatRequests[1].messages).toEqual([{ role: "user", content: "Try this question" }]);
  await page.screenshot({ path: "test-results/guest-stopped.png", fullPage: true });
});

test("terminal access error keeps partial transcript and next draft; reconnect never sends", async ({
  page,
}) => {
  const state = await fixture(page);
  await connected(page);
  await send(page, "Completed question");
  await expect(page.getByText("Response complete.", { exact: true })).toBeVisible();
  state.stream = true;
  await send(page, "Failed question");
  await push(page, "Partial answer");
  await expect(page.getByText("Partial answer", { exact: true })).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("An independently typed draft");
  await push(page, "", true, `Access ended. Never echo ${access}`);
  await expect(page.getByRole("alert")).toContainText("response ended before completion");
  await expect(page.getByText("Partial answer", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
    "An independently typed draft",
  );
  await page.getByRole("button", { name: "Copy question", exact: true }).click();
  expect(await page.evaluate(() => (window as GuestTestWindow).guestTest.copied)).toBe(
    "Failed question",
  );
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
    "An independently typed draft",
  );
  expect(await page.content()).not.toContain(access);
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect.poll(() => state.sessionRequests.length).toBe(2);
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  expect(state.chatRequests).toHaveLength(2);
  await send(page, "Failed question");
  await push(page, "Retried answer", true);
  expect(state.chatRequests[2].messages).toEqual([
    { role: "user", content: "Completed question" },
    { role: "assistant", content: "A fixture answer." },
    { role: "user", content: "Failed question" },
  ]);
  await page.screenshot({ path: "test-results/guest-reconnected.png", fullPage: true });
});

for (const scope of ["local-preview", "temporary-internet"]) {
  test(`${scope} empty replies restore the question without claiming completion or replaying it`, async ({
    page,
  }) => {
    const state = await fixture(page);
    state.metadata.scope = scope;
    await connected(page);
    await send(page, "Earlier question");
    await expect(page.getByText("Response complete.", { exact: true })).toBeVisible();
    state.chunks = [{ content: " \n\t", done: true }];
    await send(page, "Unanswered question");
    await expect(page.getByText("The host returned no answer.", { exact: false })).toBeVisible();
    await expect(page.getByText("Response complete.", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Unanswered question");
    await expect(page.getByText(/Incomplete exchange ·/)).toBeVisible();
    await expect(page.getByText("No response received.", { exact: true })).toBeVisible();
    expect(state.chatRequests).toHaveLength(2);
    expect(state.sessionRequests).toHaveLength(1);
    await page.screenshot({
      path: `test-results/guest-empty-${scope}.png`,
      fullPage: true,
      animations: "disabled",
    });
    state.chunks = [{ content: "Recovered answer.", done: true }];
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByText("Recovered answer.", { exact: true })).toBeVisible();
    expect(state.chatRequests[2].messages).toEqual([
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "A fixture answer." },
      { role: "user", content: "Unanswered question" },
    ]);
    expect(state.unexpected).toEqual([]);
  });
}

test("an empty streamed reply preserves a newer draft and exposes its original question", async ({
  page,
}) => {
  const state = await fixture(page);
  state.stream = true;
  await page.setViewportSize({ width: 320, height: 1000 });
  await connected(page);
  await send(page, "Original unanswered question");
  await page.getByLabel("Message", { exact: true }).fill("Keep my next question");
  await push(page, "", true);
  await expect(page.getByText("The host returned no answer.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Copy question", exact: true }).click();
  expect(await page.evaluate(() => (window as GuestTestWindow).guestTest.copied)).toBe(
    "Original unanswered question",
  );
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keep my next question");
  await expect(
    page.getByRole("button", { name: "Copy partial response", exact: true }),
  ).toHaveCount(0);
  expect(state.chatRequests).toHaveLength(1);
  expect(state.unexpected).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/guest-empty-new-draft-320.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("a truncated transport is incomplete and restores the draft", async ({ page }) => {
  const state = await fixture(page);
  state.chunks = [{ content: "Transport cut off", done: false }];
  await connected(page);
  await send(page, "Keep my question");
  await expect(page.getByRole("alert")).toContainText("response ended before completion");
  await expect(page.getByText("Transport cut off", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keep my question");
  expect(state.chatRequests).toHaveLength(1);
});

for (const [status, message] of [
  [401, "A valid access key is required"],
  [403, "does not permit the selected model"],
  [408, "message upload timed out"],
  [429, "host is busy or the request limit"],
  [503, "stopped or the host is offline"],
] as const) {
  test(`chat ${status} preserves the question and requires a manual recheck`, async ({ page }) => {
    const state = await fixture(page);
    if (status === 408) state.metadata.scope = "temporary-internet";
    state.chatStatus = status;
    state.retryAfter = "2";
    await connected(page);
    await send(page, "Keep this failed request");
    await expect(page.getByRole("alert")).toContainText(message);
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
      "Keep this failed request",
    );
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
    expect(await page.content()).not.toContain(access);
    if (status === 429) {
      await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeDisabled();
      await expect(page.getByText(/Try reconnecting in/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeEnabled({
        timeout: 5000,
      });
    }
    if (status === 401) await expect(page.getByLabel("Access key", { exact: true })).toBeVisible();
    expect(state.chatRequests).toHaveLength(1);
    expect(state.sessionRequests).toHaveLength(1);
    if (status === 408)
      await page.screenshot({
        path: "test-results/guest-internet-upload-timeout.png",
        fullPage: true,
      });
  });
}

test("same-key metadata errors and busy checks retain conversation and draft", async ({ page }) => {
  const state = await fixture(page);
  await connected(page);
  await send(page, "A remembered question");
  await expect(page.getByText("Response complete.", { exact: true })).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("An unsent draft");
  for (const status of [500, 429, 503, 401]) {
    state.sessionStatus = status;
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByText("A fixture answer.", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("An unsent draft");
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  }
  state.sessionStatus = 200;
  await page.getByLabel("Access key", { exact: true }).fill(access);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("An unsent draft");
  expect(state.chatRequests).toHaveLength(1);
});

for (const outcome of ["ready", "failed"] as const) {
  test(`Enter during a pending same-key reconnect explains the draft was not sent (${outcome})`, async ({
    page,
  }) => {
    const state = await fixture(page);
    await connected(page);
    await send(page, "A remembered question");
    await expect(page.getByText("Response complete.", { exact: true })).toBeVisible();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested = false;
    await page.route("**/guest/v1/session", async (route) => {
      requested = true;
      await gate;
      if (outcome === "failed") state.sessionStatus = 503;
      await route.fallback();
    });

    const reconnect = page.getByRole("button", { name: "Reconnect", exact: true });
    const composer = page.getByLabel("Message", { exact: true });
    try {
      await reconnect.click();
      await expect.poll(() => requested).toBe(true);
      await expect(page.getByText("Checking guest access…", { exact: true })).toBeVisible();

      await composer.fill("Keep this draft while access is checked");
      await composer.press("Enter");
      await expect(
        page.getByText("Message not sent. Access is being checked.", { exact: false }),
      ).toBeVisible();
      await expect(composer).toHaveValue("Keep this draft while access is checked");
      await expect(composer).toBeFocused();
      await expect(page.getByText("A fixture answer.", { exact: true })).toBeVisible();
      expect(state.chatRequests).toHaveLength(1);
      for (const width of [320, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.getByRole("form", { name: "Message composer", exact: true }).screenshot({
          path: `test-results/guest-pending-reconnect-${outcome}-${width}.png`,
          animations: "disabled",
        });
      }

      release();
      if (outcome === "ready") {
        await expect(
          page.getByText("Access was available at the last check.", { exact: true }),
        ).toBeVisible();
        await expect(
          page.getByText("Message not sent. Access is available again.", { exact: false }),
        ).toBeVisible();
        await expect(composer).toHaveValue("Keep this draft while access is checked");
        await expect(composer).toBeFocused();
        await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
        expect(state.chatRequests).toHaveLength(1);

        await composer.press("Enter");
        await expect.poll(() => state.chatRequests.length).toBe(2);
      } else {
        await expect(page.getByRole("alert")).toContainText("stopped or the host is offline");
        await expect(
          page.getByText("Message not sent. Reconnect with usable access", { exact: false }),
        ).toBeVisible();
        await expect(composer).toHaveValue("Keep this draft while access is checked");
        await expect(composer).toBeFocused();
        await expect(
          page.getByRole("button", { name: "Send message", exact: true }),
        ).toBeDisabled();
        await expect(reconnect).toBeEnabled();
        expect(state.chatRequests).toHaveLength(1);
      }
      expect(state.sessionRequests).toHaveLength(2);
    } finally {
      release();
    }
  });
}

test("re-entering the current key during cooldown explains the wait and preserves work", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.clock.install();
  await connected(page);
  await send(page, "Earlier permission question");
  await expect(page.getByText("Response complete.", { exact: true })).toBeVisible();

  state.chatStatus = 429;
  state.retryAfter = "4";
  await send(page, "Keep this request during cooldown");
  await expect(page.getByRole("alert")).toContainText("request limit");
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
    "Keep this request during cooldown",
  );
  expect(state.sessionRequests).toHaveLength(1);
  expect(state.chatRequests).toHaveLength(2);

  await page.getByRole("button", { name: "Use another key", exact: true }).click();
  const input = page.getByLabel("Access key", { exact: true });
  await input.fill(` ${access} `);
  await input.press("Enter");
  await expect(page.getByRole("alert")).toHaveText(/Wait for the reconnect delay/i);
  await expect(page.getByText("Earlier permission question", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
    "Keep this request during cooldown",
  );
  await expect(page.getByText(/Try reconnecting in/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeDisabled();
  expect(state.sessionRequests).toHaveLength(1);
  expect(state.chatRequests).toHaveLength(2);
  expect(await page.content()).not.toContain(access);

  await page.clock.runFor(3_001);
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeDisabled();
  await input.fill("different-fixture-key");
  await input.press("Enter");
  await expect(
    page.getByText("Access was available at the last check.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
  await expect(page.getByText(/Message not sent/i)).toHaveCount(0);
  expect(state.sessionRequests).toHaveLength(2);
  expect(state.chatRequests).toHaveLength(2);
  expect(await page.content()).not.toContain(access);
  expect(await page.content()).not.toContain("different-fixture-key");
});

test("Enter during a busy generation does not duplicate work or report a failed send", async ({
  page,
}) => {
  const state = await fixture(page);
  state.stream = true;
  await connected(page);
  await send(page, "The active question");
  await push(page, "A partial answer");
  await expect(page.getByText("A partial answer", { exact: true })).toBeVisible();

  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("A draft for after the active answer");
  await composer.press("Enter");
  await expect(composer).toHaveValue("A draft for after the active answer");
  await expect(page.getByText(/Message not sent/i)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(state.chatRequests).toHaveLength(1);

  await push(page, " complete", true);
  await expect(page.getByText("Response complete.", { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("A draft for after the active answer");
  expect(state.chatRequests).toHaveLength(1);
});

test("failed replacement preserves the conversation until that key connects; disconnect clears", async ({
  page,
}) => {
  const state = await fixture(page);
  await connected(page);
  await send(page, "Old key's question");
  await expect(page.getByText("Response complete.", { exact: true })).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("Old key's draft");
  await page.getByRole("button", { name: "Use another key", exact: true }).click();
  await expect(page.getByLabel("Access key", { exact: true })).toBeFocused();
  state.sessionStatus = 401;
  await page.getByLabel("Access key", { exact: true }).fill("different-fixture-key");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("A valid access key is required");
  await expect(page.getByRole("article")).toHaveCount(1);
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Old key's draft");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  expect(state.chatRequests).toHaveLength(1);
  state.sessionStatus = 200;
  state.stream = true;
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(
    page.getByText("Access was available at the last check.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
  await send(page, "New key's question");
  expect(state.chatRequests[1].messages).toEqual([{ role: "user", content: "New key's question" }]);
  expect(state.chatKeys[1]).toBe("Bearer different-fixture-key");
  await push(page, "New partial output");
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(page.getByLabel("Message", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Access key", { exact: true })).toHaveValue("");
  expect(await page.evaluate(() => (window as GuestTestWindow).guestTest.aborts)).toBe(1);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test("unavailable metadata and host-rejected expired keys never enable sending", async ({
  page,
}) => {
  const state = await fixture(page);
  state.metadata.available = false;
  state.metadata.unavailableReason = `Do not echo ${access}`;
  await openGuest(page, access);
  await expect(page.getByRole("alert")).toContainText("not accepting guest messages");
  await page.getByLabel("Message", { exact: true }).fill("Draft while waiting");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  state.metadata.available = true;
  state.sessionStatus = 401;
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("A valid access key is required");
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Draft while waiting");
  expect(state.chatRequests).toHaveLength(0);
  expect(await page.content()).not.toContain(access);
});

test("disconnect during a pending handshake cannot restore access or echo the key", async ({
  page,
}) => {
  await fixture(page);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  let settled = false;
  await page.route("**/guest/v1/session", async (route) => {
    requested = true;
    await gate;
    // Disconnect may have already cancelled this routed request.
    await route.fulfill({ json: session() }).catch(() => {});
    settled = true;
  });
  try {
    await openGuest(page, access);
    await expect.poll(() => requested).toBe(true);
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    release();
    await expect.poll(() => settled).toBe(true);
    await expect(page.getByLabel("Access key", { exact: true })).toHaveValue("");
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toHaveCount(0);
    await expect(page.locator("time")).toHaveCount(0);
    expect(await page.content()).not.toContain(access);
  } finally {
    release();
  }
});

test("metadata transport failure retains the draft; an unsupported scope fails closed", async ({
  page,
}) => {
  const state = await fixture(page);
  await connected(page);
  await page.getByLabel("Message", { exact: true }).fill("Keep this metadata draft");
  await page.route("**/guest/v1/session", (route) => route.abort(), { times: 1 });
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not check guest access");
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keep this metadata draft");
  state.metadata.scope = "unsupported-scope";
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not check guest access");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  expect(state.chatRequests).toHaveLength(0);
});

for (const hours of [-48, 48]) {
  test(`a guest clock ${hours} hours off cannot overrule host authentication`, async ({ page }) => {
    const state = await fixture(page);
    await page.clock.setFixedTime(new Date(Date.now() + hours * 3_600_000));
    await connected(page);
    await send(page, "A question from a device with the wrong clock");
    await expect(page.getByText("Response complete.", { exact: true })).toBeVisible();
    expect(state.sessionRequests).toHaveLength(1);
    expect(state.chatRequests).toHaveLength(1);
    await expect(page.getByText(/Host-reported expiry:/)).toBeVisible();
    if (hours > 0) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: "test-results/guest-clock-skew.png",
        fullPage: true,
        animations: "disabled",
      });
    }
  });
}

test("clock changes cannot interrupt a stream; host expiry preserves partial output and draft focus", async ({
  page,
}) => {
  const state = await fixture(page);
  state.stream = true;
  await page.clock.install();
  await connected(page);
  await send(page, "A question near expiry");
  await push(page, "Output before expiry");
  await page.getByLabel("Message", { exact: true }).fill("Keep typing here");
  // Move far beyond the displayed expiry, then back. No local date can prove
  // expiry, including after a device resumes. Only a host response ends access.
  await page.clock.setFixedTime(new Date(Date.now() + 48 * 3_600_000));
  await page.clock.runFor(1500);
  await push(page, " still streaming");
  await expect(
    page.getByText("Output before expiry still streaming", { exact: true }),
  ).toBeVisible();
  await page.clock.setFixedTime(new Date(Date.now() - 48 * 3_600_000));
  await page.clock.runFor(1500);
  await push(page, " after clock correction");
  expect(await page.evaluate(() => (window as GuestTestWindow).guestTest.aborts)).toBe(0);
  expect(state.sessionRequests).toHaveLength(1);
  await expect(page.getByLabel("Message", { exact: true })).toBeFocused();
  await push(page, "", true, "Access ended");
  await expect(page.getByRole("alert")).toContainText("Access may have ended");
  await expect(
    page.getByText("Output before expiry still streaming after clock correction", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Incomplete exchange ·/)).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toBeFocused();
  await page.keyboard.type(" after expiry");
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
    "Keep typing here after expiry",
  );
  // Rechecking gets the host's authoritative 401 without generating another answer.
  state.sessionStatus = 401;
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("A valid access key is required");
  await expect(page.getByLabel("Access key", { exact: true })).toHaveValue("");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/guest-expired-draft-focus.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(state.chatRequests).toHaveLength(1);
});

test("wall-clock changes cannot bypass or extend a host cooldown", async ({ page }) => {
  const state = await fixture(page);
  await page.clock.install();
  await connected(page);
  state.chatStatus = 429;
  state.retryAfter = "2";
  await send(page, "Wait for host capacity");
  await expect(page.getByRole("alert")).toContainText("request limit");
  const reconnect = page.getByRole("button", { name: "Reconnect", exact: true });
  await page.clock.setFixedTime(new Date(Date.now() + 48 * 3_600_000));
  await expect(reconnect).toBeDisabled();
  await page.clock.setFixedTime(new Date(Date.now() - 48 * 3_600_000));
  await page.clock.runFor(3000);
  await expect(reconnect).toBeEnabled();
  expect(state.sessionRequests).toHaveLength(1);
  expect(state.chatRequests).toHaveLength(1);
});

test("reconnect refreshes model permissions and leaves earlier-model exchanges out of context", async ({
  page,
}) => {
  const state = await fixture(page);
  await connected(page);
  await send(page, "First model's question");
  await expect(page.getByText("Response complete.", { exact: true })).toBeVisible();
  state.metadata.model = "different-fixture:small";
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page.getByText("different-fixture:small", { exact: true })).toBeVisible();
  expect(state.chatRequests).toHaveLength(1);
  await send(page, "Second model's question");
  await expect.poll(() => state.chatRequests.length).toBe(2);
  expect(state.chatRequests[1].model).toBe("different-fixture:small");
  expect(state.chatRequests[1].messages).toEqual([
    { role: "user", content: "Second model's question" },
  ]);
});

test("oversized prompt is validated before clearing; keyboard newline and send work", async ({
  page,
}) => {
  const state = await fixture(page);
  await connected(page);
  const composer = page.getByLabel("Message", { exact: true });
  const oversized = "x".repeat(16_385);
  await composer.fill(oversized);
  await composer.press("Enter");
  await expect(page.getByRole("alert")).toContainText("message is too long");
  await expect(composer).toHaveValue(oversized);
  expect(state.chatRequests).toHaveLength(0);
  await composer.fill("Line one");
  await composer.press("End");
  await composer.press("Shift+Enter");
  await composer.press("a");
  await expect(composer).toHaveValue("Line one\na");
  expect(state.chatRequests).toHaveLength(0);
  await composer.press("Enter");
  await expect.poll(() => state.chatRequests.length).toBe(1);
  expect(state.chatRequests[0].messages).toEqual([{ role: "user", content: "Line one\na" }]);
});

test("320px and 1440px keep long answers and composer bounded with keyboard scroll controls", async ({
  page,
}) => {
  const state = await fixture(page);
  state.stream = true;
  await page.setViewportSize({ width: 320, height: 900 });
  await connected(page);
  await send(page, "A long answer");
  const long = Array.from(
    { length: 100 },
    (_, i) => `Paragraph ${i + 1}: A thought worth reading.\n\n`,
  ).join("");
  await push(page, "```text\n" + "wide_code_".repeat(50) + "\n```\n\n" + long);
  const pane = page.getByRole("region", { name: "Conversation messages", exact: true });
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(300);
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await pane.focus();
    await pane.press("Home");
    await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBe(0);
    await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toBeVisible();
    await push(page, `More text at ${width}px.\n\n`);
    await expect(pane).toContainText(`More text at ${width}px.`);
    await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      await pane.evaluate(
        (element) => element.clientHeight <= 560 && element.scrollHeight > element.clientHeight,
      ),
    ).toBe(true);
    await page.screenshot({ path: `test-results/guest-${width}-reading.png`, fullPage: true });
    const jump = page.getByRole("button", { name: "Jump to latest", exact: true });
    await jump.focus();
    await jump.press("Enter");
    await expect(pane).toBeFocused();
    await expect(jump).toHaveCount(0);
  }
  await push(page, "Done.", true);
  await page.getByLabel("Message", { exact: true }).fill("Draft line\n".repeat(80));
  const composer = page.getByLabel("Message", { exact: true });
  expect(
    await composer.evaluate(
      (element) => element.clientHeight <= 240 && element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  await page.reload();
  await expect(page.getByLabel("Access key", { exact: true })).toBeVisible();
  await expect(composer).toHaveCount(0);
  await expect(page.getByRole("article")).toHaveCount(0);
  expect(state.sessionRequests).toHaveLength(1);
  expect(state.unexpected).toEqual([]);
});

test("a stalled access check times out and reconnect remains manual", async ({ page }) => {
  const state = await fixture(page);
  await page.clock.install();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/guest/v1/session", async (route) => {
    await held;
    await route.abort();
  });
  try {
    await openGuest(page, access);
    await expect(page.getByText("Checking guest access…", { exact: true })).toBeVisible();
    await page.clock.fastForward(12_001);
    await expect(page.getByRole("alert")).toContainText("Could not check guest access");
    await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toHaveCount(0);
    expect(state.chatRequests).toEqual([]);
  } finally {
    release();
  }
});

for (const width of [320, 768, 1024, 1440]) {
  test(`failed replacement keeps editable work and keyboard recovery at ${width}px`, async ({
    page,
  }) => {
    const state = await fixture(page);
    await page.setViewportSize({ width, height: 1100 });
    await connected(page);
    await send(page, "Keep my earlier question");
    await expect(page.getByText("Response complete.", { exact: true })).toBeVisible();
    await page.getByLabel("Message", { exact: true }).fill("Keep my unsent draft");
    await page.getByRole("button", { name: "Use another key", exact: true }).click();
    const input = page.getByLabel("Access key", { exact: true });
    await input.fill("rejected-replacement");
    state.sessionStatus = 401;
    await input.press("Enter");
    await expect(page.getByRole("alert")).toContainText("A valid access key is required");
    await expect(input).toBeFocused();
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keep my unsent draft");
    await expect(page.getByText("A fixture answer.", { exact: true })).toBeVisible();
    await expect(page.getByText(/Previous conversation retained/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
    expect(state.chatRequests).toHaveLength(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `test-results/guest-key-handoff-${width}.png`, fullPage: true });
  });
}

test("returning to the previous key restores its retained context without an automatic send", async ({
  page,
}) => {
  const state = await fixture(page);
  await connected(page);
  await send(page, "Earlier permission question");
  await expect(page.getByText("Response complete.", { exact: true })).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("Return to my draft");
  await page.getByRole("button", { name: "Use another key", exact: true }).click();
  state.sessionStatus = 401;
  await page.getByLabel("Access key", { exact: true }).fill("invalid-other-key");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  state.sessionStatus = 200;
  await page.getByLabel("Access key", { exact: true }).fill(access);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Return to my draft");
  await expect(page.getByText(/Previous conversation retained/)).toHaveCount(0);
  expect(state.chatRequests).toHaveLength(1);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => state.chatRequests.length).toBe(2);
  expect(state.chatKeys[1]).toBe(`Bearer ${access}`);
  expect(state.chatRequests[1].messages).toEqual([
    { role: "user", content: "Earlier permission question" },
    { role: "assistant", content: "A fixture answer." },
    { role: "user", content: "Return to my draft" },
  ]);
});

for (const kind of ["unavailable", "malformed", "transport"] as const) {
  test(`${kind} replacement does not relabel retained work as the new permission`, async ({
    page,
  }) => {
    const state = await fixture(page);
    const originalModel = state.metadata.model;
    await connected(page);
    await send(page, "Keep this private context");
    await expect(page.getByText("Response complete.", { exact: true })).toBeVisible();
    await page.getByLabel("Message", { exact: true }).fill("A draft for the first permission");
    await page.getByRole("button", { name: "Use another key", exact: true }).click();
    state.metadata.model = "replacement-model:small";
    state.metadata.available = false;
    if (kind === "malformed") state.metadata.scope = "unsupported-scope";
    if (kind === "transport") await page.route("**/guest/v1/session", (route) => route.abort());
    await page.getByLabel("Access key", { exact: true }).fill("replacement-key");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByText(originalModel, { exact: true })).toBeVisible();
    await expect(page.getByText("replacement-model:small", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
      "A draft for the first permission",
    );
    await page.getByLabel("Message", { exact: true }).press("Enter");
    expect(state.chatRequests).toHaveLength(1);
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  });
}

test("initially unavailable access keeps its draft when the same key becomes available", async ({
  page,
}) => {
  const state = await fixture(page);
  state.metadata.available = false;
  await openGuest(page, access);
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("Write while waiting for this model");
  state.metadata.available = true;
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
    "Write while waiting for this model",
  );
  expect(state.chatRequests).toEqual([]);
});

test("manual key check keeps its field mounted and does not steal focus after a failed reply", async ({
  page,
}) => {
  await fixture(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/guest/v1/session", async (route) => {
    await gate;
    await route.fulfill({ status: 401, json: {} });
  });
  await openGuest(page);
  const input = page.getByLabel("Access key", { exact: true });
  try {
    await input.fill("incorrect-key");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute("readonly", "");
    await expect(input).toHaveAttribute("aria-busy", "true");
    const disconnect = page.getByRole("button", { name: "Disconnect", exact: true });
    await disconnect.focus();
    await expect(disconnect).toBeFocused();
    release();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(input).toBeEditable();
    await expect(disconnect).toBeFocused();
  } finally {
    release();
  }
});
