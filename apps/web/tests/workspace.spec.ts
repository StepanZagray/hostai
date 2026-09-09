import { expect, test } from "@playwright/test";
import { hostFixture } from "./support/host-fixture";

test("offline host has useful setup and disabled generation", async ({ page }) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 503,
      json: {
        detail: "The HostAI backend is unavailable. Start the Java service, then reconnect.",
      },
    }),
  );
  await page.goto("/");
  await expect(page.getByText("Gateway unavailable", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Connect your runtime" }).click();
  await expect(page.getByRole("heading", { name: "Connection & setup" })).toBeVisible();
  await page.getByRole("link", { name: "Playground", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
});

test("model search, navigation and streamed conversation", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await hostFixture(page);
  await page.route("**/api/chat", async (route) => {
    expect(route.request().postDataJSON().model).toBe("fixture-model:small");
    await route.fulfill({
      contentType: "application/x-ndjson",
      body: '{"content":"Hello from the test runtime.","done":false}\n{"content":"","done":true,"outputTokens":7}\n',
    });
  });
  await page.goto("/models");
  await page.getByRole("textbox", { name: "Search models" }).fill("missing");
  await expect(page.getByRole("heading", { name: "No matching models" })).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await page.getByRole("link", { name: "Try in playground" }).click();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Hello");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Hello from the test runtime.", { exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "7 output tokens" })).toBeVisible();
  await page.screenshot({ path: "test-results/playground-completed.png", fullPage: true });
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What’s on your mind?" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("stream failures are visible and allow another request", async ({ page }) => {
  await hostFixture(page);
  let attempts = 0;
  await page.route("**/api/chat", (route) => {
    if (++attempts === 1)
      return route.fulfill({ status: 429, json: { detail: "All generation slots are busy." } });
    expect(route.request().postDataJSON().messages).toEqual([
      { role: "user", content: "Hello" },
      { role: "user", content: "Try again" },
    ]);
    return route.fulfill({
      contentType: "application/x-ndjson",
      body: '{"content":"Recovered","done":true}\n',
    });
  });
  await page.goto("/playground");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Hello");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("alert")).toHaveText("All generation slots are busy.");
  await page.screenshot({ path: "test-results/playground-overloaded.png", fullPage: true });
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Try again");
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Recovered", { exact: true })).toBeVisible();
  await expect(page.getByText("Thinking…", { exact: true })).toHaveCount(0);
});

test("malformed streams show a readable error and allow retry", async ({ page }) => {
  await hostFixture(page);
  await page.route("**/api/chat", (route) =>
    route.fulfill({ contentType: "application/x-ndjson", body: "not JSON\n" }),
  );
  await page.goto("/playground");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Hello");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("alert")).toHaveText("The model returned an invalid stream.");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Try again");
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
  await page.screenshot({ path: "test-results/playground-invalid-stream.png", fullPage: true });
});

test("mobile navigation and layout fit the viewport", async ({ page }) => {
  await hostFixture(page, false);
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Host overview" })).toBeVisible();
    await expect(page.getByText("Gateway online", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    if (width === 320) {
      await page.getByRole("button", { name: "Open navigation" }).click();
      await page.getByRole("link", { name: "Models", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Your model library" })).toBeVisible();
      await page.screenshot({ path: "test-results/mobile-models.png", fullPage: true });
    }
  }
  await page.screenshot({ path: "test-results/desktop-overview.png", fullPage: true });
});

test("activity refresh failure keeps chat usable and recovers on retry", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await hostFixture(page);
  let failed = false;
  await page.route("**/api/requests", (route) =>
    failed
      ? route.fulfill({ status: 503, json: { detail: "Unavailable" } })
      : route.fulfill({
          json: {
            requests: [
              {
                id: "previous",
                model: "fixture-model:small",
                status: "completed",
                durationMs: 200,
                outputTokens: 7,
                startedAt: new Date().toISOString(),
              },
            ],
          },
        }),
  );
  await page.route("**/api/chat", (route) =>
    route.fulfill({
      contentType: "application/x-ndjson",
      body: '{"content":"Still working","done":true}\n',
    }),
  );
  await page.goto("/activity");
  await expect(page.getByRole("cell", { name: "completed", exact: true })).toBeVisible();
  failed = true;
  await page.getByRole("button", { name: "Refresh activity" }).click();
  await expect(page.getByRole("heading", { name: "Request activity unavailable" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "A quiet workspace" })).toHaveCount(0);
  await expect(page.getByText("Gateway online", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Playground", exact: true }).click();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Hello");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Still working", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Request activity could not be refreshed.");
  await page.screenshot({ path: "test-results/partial-refresh-playground.png", fullPage: true });
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  failed = false;
  const retry = page.getByRole("button", { name: "Retry refresh" });
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("link", { name: "Request activity", exact: true }).click();
  await expect(page.getByRole("cell", { name: "completed", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("failed model discovery is unavailable, not an empty library", async ({ page }) => {
  await hostFixture(page);
  await page.route("**/api/models", (route) =>
    route.fulfill({ status: 503, json: { detail: "Unavailable" } }),
  );
  await page.goto("/models");
  await expect(page.getByText("Gateway online", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Model discovery unavailable" })).toBeVisible();
  await expect(page.getByText("Model count unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No installed models yet" })).toHaveCount(0);
  await page.screenshot({ path: "test-results/models-unavailable.png", fullPage: true });
  await page.getByRole("link", { name: "Playground", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  await page.getByRole("link", { name: "Request activity", exact: true }).click();
  await expect(page.getByRole("heading", { name: "A quiet workspace" })).toBeVisible();
});

test("failed status refresh never claims readiness from a successful model fetch", async ({
  page,
}) => {
  await hostFixture(page);
  await page.route("**/api/status", (route) =>
    route.fulfill({ status: 503, json: { detail: "Unavailable" } }),
  );
  await page.goto("/models");
  await expect(page.getByText("Gateway unavailable", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "fixture-model:small", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Try in playground" }).click();
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("Gateway status could not be refreshed.");
  await page.route("**/api/models", (route) =>
    route.fulfill({ json: { models: [], connected: true } }),
  );
  await page.getByRole("button", { name: "Retry refresh" }).click();
  await page.getByRole("link", { name: "Models", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No installed models yet" })).toBeVisible();
});

test("model count stays unknown until discovery finishes", async ({ page }) => {
  await hostFixture(page);
  let finishDiscovery!: () => void;
  const discovery = new Promise<void>((resolve) => {
    finishDiscovery = resolve;
  });
  await page.route("**/api/models", async (route) => {
    await discovery;
    await route.fulfill({ json: { connected: true, models: [] } });
  });
  try {
    await page.goto("/models");
    await expect(page.getByText("Checking runtime models…", { exact: true })).toBeVisible();
    await expect(page.getByText("0 discovered models", { exact: true })).toHaveCount(0);
  } finally {
    finishDiscovery();
  }
  await expect(page.getByText("0 discovered models", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No installed models yet" })).toBeVisible();
});

test("failed responses stay visible but are excluded from the next prompt", async ({ page }) => {
  await hostFixture(page);
  const sent: { role: string; content: string }[][] = [];
  await page.route("**/api/chat", (route) => {
    sent.push(route.request().postDataJSON().messages);
    return route.fulfill({
      contentType: "application/x-ndjson",
      body:
        sent.length === 1
          ? '{"content":"Unfinished answer","done":false}\n{"content":"","done":true,"error":"Generation interrupted"}\n'
          : '{"content":"Finished answer","done":true}\n',
    });
  });
  await page.goto("/playground");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("First attempt");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("alert")).toHaveText("Generation interrupted");
  await expect(page.getByText("Unfinished answer", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Incomplete response · Not used in later prompts.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Try this instead");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Finished answer", { exact: true })).toBeVisible();
  expect(sent[1]).toEqual([
    { role: "user", content: "First attempt" },
    { role: "user", content: "Try this instead" },
  ]);
  await expect(page.getByText("Unfinished answer", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/interrupted-conversation.png", fullPage: true });
});

test("empty completed answers do not poison the next request", async ({ page }) => {
  await hostFixture(page);
  const sent: { role: string; content: string }[][] = [];
  await page.route("**/api/chat", (route) => {
    sent.push(route.request().postDataJSON().messages);
    return route.fulfill({
      contentType: "application/x-ndjson",
      body:
        sent.length === 1
          ? '{"content":"","done":true,"outputTokens":0}\n'
          : '{"content":"Now answered","done":true}\n',
    });
  });
  await page.goto("/playground");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("First question");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByText("Empty response · Not used in later prompts.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Please answer");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Now answered", { exact: true })).toBeVisible();
  expect(sent[1]).toEqual([
    { role: "user", content: "First question" },
    { role: "user", content: "Please answer" },
  ]);
});

test("model disappearance cannot silently switch an existing conversation", async ({ page }) => {
  await hostFixture(page);
  let removed = false;
  await page.route("**/api/models", (route) =>
    route.fulfill({
      json: {
        connected: true,
        models: [
          {
            name: removed ? "other-model:small" : "fixture-model:small",
            sizeBytes: 1,
            parameterSize: "",
            quantization: "",
            modifiedAt: "",
            chatUnavailableReason: null,
          },
        ],
      },
    }),
  );
  const sent: { model: string; messages: { role: string; content: string }[] }[] = [];
  await page.route("**/api/chat", (route) => {
    sent.push(route.request().postDataJSON());
    removed = true;
    return route.fulfill({
      contentType: "application/x-ndjson",
      body: '{"content":"Saved answer","done":true}\n',
    });
  });
  await page.goto("/playground");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Original model");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Saved answer", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveValue(
    "fixture-model:small",
  );
  await expect(
    page.getByRole("option", { name: "fixture-model:small (unavailable)", exact: true }),
  ).toBeAttached();
  await expect(
    page.getByRole("heading", { name: "fixture-model:small", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  await expect(page.getByText("Selected model unavailable", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "test-results/conversation-model-unavailable.png",
    fullPage: true,
  });
  await page
    .getByRole("combobox", { name: "Model", exact: true })
    .selectOption("other-model:small");
  await expect(page.getByText("Saved answer", { exact: true })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("New model");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Saved answer", { exact: true })).toBeVisible();
  expect(sent[1]).toMatchObject({
    model: "other-model:small",
    messages: [{ role: "user", content: "New model" }],
  });
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Fresh start");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Saved answer", { exact: true })).toBeVisible();
  expect(sent[2].messages).toEqual([{ role: "user", content: "Fresh start" }]);
});

test("truncated responses are labeled incomplete and excluded from follow-up context", async ({
  page,
}) => {
  await hostFixture(page);
  let calls = 0;
  await page.route("**/api/chat", (route) => {
    if (++calls === 1)
      return route.fulfill({
        contentType: "application/x-ndjson",
        body: '{"content":"Truncated answer","done":false}\n',
      });
    expect(route.request().postDataJSON().messages).toEqual([
      { role: "user", content: "Start" },
      { role: "user", content: "Continue" },
    ]);
    return route.fulfill({
      contentType: "application/x-ndjson",
      body: '{"content":"Complete answer","done":true}\n',
    });
  });
  await page.goto("/playground");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Start");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("alert")).toContainText("before the model finished");
  await expect(
    page.getByText("Incomplete response · Not used in later prompts.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Continue");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Complete answer", { exact: true })).toBeVisible();
});

test("duplicate submissions admit one request and stopping before headers allows retry", async ({
  page,
}) => {
  await hostFixture(page);
  let calls = 0;
  await page.route("**/api/chat", (route) => {
    if (++calls === 1) return; // Hold headers until the browser cancels this intercepted request.
    expect(route.request().postDataJSON().messages).toEqual([
      { role: "user", content: "Waiting" },
      { role: "user", content: "Retry" },
    ]);
    return route.fulfill({
      contentType: "application/x-ndjson",
      body: '{"content":"Retry succeeded","done":true}\n',
    });
  });
  await page.goto("/playground");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Waiting");
  await input.evaluate((element) => {
    const form = element.closest("form")!;
    for (let i = 0; i < 2; i++)
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await expect.poll(() => calls).toBe(1);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(
    page.getByText("Stopped response · Not used in later prompts.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Thinking…", { exact: true })).toHaveCount(0);
  await input.fill("Retry");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Retry succeeded", { exact: true })).toBeVisible();
  expect(calls).toBe(2);
});

test("context limits disclose omissions before sending and retain the visible transcript", async ({
  page,
}) => {
  await hostFixture(page);
  const longAnswer = "A detailed answer. ".repeat(920);
  const sent: { role: string; content: string }[][] = [];
  let calls = 0;
  await page.route("**/api/chat", (route) => {
    calls++;
    sent.push(route.request().postDataJSON().messages);
    return route.fulfill({
      contentType: "application/x-ndjson",
      body:
        JSON.stringify({
          content: calls === 1 ? longAnswer : `Short answer ${calls}`,
          done: true,
          outputTokens: 7,
        }) + "\n",
    });
  });
  await page.goto("/playground");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  const send = page.getByRole("button", { name: "Send message" });
  await input.fill("Start");
  await send.click();
  await expect(page.getByText(longAnswer.trim(), { exact: true })).toBeAttached();
  await input.fill("Follow up");
  const preview = page.getByRole("status").filter({ hasText: "will be omitted" });
  await expect(preview).toContainText("1 earlier turn will be omitted");
  await expect(preview).toContainText("Only your new message will be sent.");
  expect(calls).toBe(1);
  await page.screenshot({ path: "test-results/context-limit-preview.png", fullPage: true });
  await send.click();
  await expect(page.getByText("Short answer 2", { exact: true })).toBeVisible();
  expect(sent[1]).toEqual([{ role: "user", content: "Follow up" }]);
  await expect(page.getByText("Sent with 1 earlier turn omitted.", { exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "7 output tokens" })).toBeVisible();
  await expect(page.getByText(longAnswer.trim(), { exact: true })).toBeAttached();
  await page.screenshot({ path: "test-results/context-limit-sent.png", fullPage: true });
  await page.setViewportSize({ width: 320, height: 1000 });
  await input.fill("Continue");
  await expect(preview).toContainText("The most recent turns will be sent.");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "test-results/context-limit-mobile.png", fullPage: true });
  await send.click();
  await expect(page.getByText("Short answer 3", { exact: true })).toBeVisible();
  expect(sent[2]).toEqual([
    { role: "user", content: "Follow up" },
    { role: "assistant", content: "Short answer 2" },
    { role: "user", content: "Continue" },
  ]);
  expect(calls).toBe(3);
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await input.fill("Fresh start");
  await expect(preview).toHaveCount(0);
  await expect(page.getByText("Sent with 1 earlier turn omitted.", { exact: true })).toHaveCount(0);
});

test("oversized new messages remain editable and show validation before sending", async ({
  page,
}) => {
  await hostFixture(page);
  let calls = 0;
  await page.route("**/api/chat", (route) => {
    calls++;
    return route.fulfill({
      contentType: "application/x-ndjson",
      body: '{"content":"Accepted","done":true}\n',
    });
  });
  await page.goto("/playground");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  const send = page.getByRole("button", { name: "Send message" });
  const prompt = "An overlong message. ".repeat(900);
  await expect(input).toBeEditable();
  await input.focus();
  await page.keyboard.insertText(prompt);
  await expect(input).toHaveValue(prompt);
  await expect(page.getByRole("alert")).toHaveText(
    "This message is too long. Shorten it before sending.",
  );
  await expect(send).toBeDisabled();
  await page.screenshot({ path: "test-results/prompt-too-long.png", fullPage: true });
  await input.press("Enter");
  expect(calls).toBe(0);
  await expect(page.getByRole("alert")).toHaveCount(1);
  await input.fill("Shorter message");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await send.click();
  await expect(page.getByText("Accepted", { exact: true })).toBeVisible();
  expect(calls).toBe(1);
});

test("page headings stay inside the mobile content area", async ({ page }) => {
  await hostFixture(page);
  await page.setViewportSize({ width: 320, height: 1000 });
  for (const path of ["/", "/models", "/playground", "/activity", "/connection"]) {
    await page.goto(path);
    await expect(page.getByText("Gateway online", { exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const description = page.getByRole("heading", { level: 1 }).locator("..").locator("p");
    await expect(description).toBeVisible();
    const bounds = await description.evaluate((element) => {
      const text = document.createRange();
      text.selectNodeContents(element);
      const main = document.querySelector("main")!.getBoundingClientRect();
      return {
        left: text.getBoundingClientRect().left,
        right: text.getBoundingClientRect().right,
        mainLeft: main.left,
        mainRight: main.right,
        viewport: document.documentElement.clientWidth,
      };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(bounds.mainLeft);
    expect(bounds.right).toBeLessThanOrEqual(bounds.mainRight);
    expect(bounds.mainRight).toBeLessThanOrEqual(bounds.viewport);
    if (path === "/playground") {
      await page.screenshot({ path: "test-results/mobile-playground-heading.png", fullPage: true });
      await page.screenshot({ path: "test-results/mobile-playground-viewport.png" });
    }
  }
});

const cloudReason = "Cloud models are not supported by this local gateway.";
function discoveredModel(name: string, chatUnavailableReason: string | null) {
  return {
    name,
    chatUnavailableReason,
    sizeBytes: 0,
    parameterSize: "",
    quantization: "",
    modifiedAt: "",
  };
}

test("unsupported models stay visible while the playground chooses an eligible default", async ({
  page,
}) => {
  await hostFixture(page);
  await page.route("**/api/models", (route) =>
    route.fulfill({
      json: {
        connected: true,
        models: [
          discoveredModel("remote:cloud", cloudReason),
          discoveredModel("local:small", null),
        ],
      },
    }),
  );
  const sent: { model: string }[] = [];
  await page.route("**/api/chat", (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({
      contentType: "application/x-ndjson",
      body: '{"content":"Local answer","done":true}\n',
    });
  });
  await page.goto("/models");
  await expect(page.getByRole("heading", { name: "remote:cloud", exact: true })).toBeVisible();
  await expect(page.getByText(cloudReason, { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Try in playground" })).toHaveCount(1);
  await page.screenshot({ path: "test-results/models-admission.png", fullPage: true });
  await page.getByRole("link", { name: "Playground", exact: true }).click();
  const model = page.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toHaveValue("local:small");
  await model.selectOption("remote:cloud");
  await page.getByRole("button", { name: "API example", exact: true }).click();
  await expect(
    page.getByText("Select a model available to try to see its API example.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("pre")).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText(cloudReason);
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  await page.screenshot({ path: "test-results/playground-admission.png", fullPage: true });
  await model.selectOption("local:small");
  await expect(page.locator("pre")).toContainText("local:small");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Hello");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Local answer", { exact: true })).toBeVisible();
  expect(sent.map((request) => request.model)).toEqual(["local:small"]);
});

for (const [name, reason] of [
  ["remote:cloud", cloudReason],
  ["bad name", "This model name is not supported by the gateway."],
] as const) {
  test(`an explicit unsupported model cannot submit: ${name}`, async ({ page }) => {
    await hostFixture(page);
    await page.route("**/api/models", (route) =>
      route.fulfill({ json: { connected: true, models: [discoveredModel(name, reason)] } }),
    );
    let calls = 0;
    await page.route("**/api/chat", (route) => {
      calls++;
      return route.abort();
    });
    await page.setViewportSize({ width: 320, height: 1000 });
    await page.goto("/playground?model=" + encodeURIComponent(name));
    await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveValue(name);
    await expect(page.getByRole("alert")).toContainText(reason);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeDisabled();
    if (name === "remote:cloud")
      await page.screenshot({ path: "test-results/mobile-model-admission.png", fullPage: true });
    await page.locator("form").evaluate((form) => (form as HTMLFormElement).requestSubmit());
    expect(calls).toBe(0);
    await page.goto("/");
    await expect(page.getByText("0 available to try", { exact: true })).toBeVisible();
    await expect(page.getByText("Ready to run", { exact: true })).toHaveCount(0);
  });
}

test("changed admission preserves the selected conversation and missing metadata stays unknown", async ({
  page,
}) => {
  await hostFixture(page);
  let blocked = false;
  await page.route("**/api/models", (route) =>
    route.fulfill({
      json: {
        connected: true,
        models: [
          discoveredModel(
            "chosen:small",
            blocked ? "This model is currently unavailable for chat." : null,
          ),
          discoveredModel("other:small", null),
        ],
      },
    }),
  );
  await page.route("**/api/chat", (route) => {
    blocked = true;
    return route.fulfill({
      contentType: "application/x-ndjson",
      body: '{"content":"Keep this answer","done":true}\n',
    });
  });
  await page.goto("/playground");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Remember this");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "This model is currently unavailable for chat.",
  );
  await expect(page.getByText("Keep this answer", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveValue(
    "chosen:small",
  );
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  await page.route("**/api/models", (route) =>
    route.fulfill({ json: { connected: true, models: [{ name: "old:small", sizeBytes: 0 }] } }),
  );
  await page.goto("/playground?model=old%3Asmall");
  await expect(page.getByRole("alert")).toContainText("Model availability is unknown.");
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
});

test("runtime setup remains available when the selected model is also unsupported", async ({
  page,
}) => {
  await hostFixture(page, false);
  await page.route("**/api/models", (route) =>
    route.fulfill({
      json: { connected: true, models: [discoveredModel("remote:cloud", cloudReason)] },
    }),
  );
  await page.goto("/playground");
  await expect(page.getByText("Runtime not ready", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(cloudReason);
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  await page.screenshot({ path: "test-results/runtime-and-model-unavailable.png", fullPage: true });
  await page.getByRole("link", { name: "Set up your host", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Connection & setup", exact: true }),
  ).toBeVisible();
});
