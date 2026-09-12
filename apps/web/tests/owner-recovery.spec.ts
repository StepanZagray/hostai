import { expect, test } from "@playwright/test";
import { hostFixture } from "./support/host-fixture";

const model = "fixture-model:small";
type RequestBody = { model: string; messages: { role: string; content: string }[] };

for (const [failure, width] of [
  ["capacity", 320],
  ["network", 768],
  ["malformed", 1024],
  ["truncated", 1440],
  ["empty", 320],
] as const) {
  test(`${failure} restores an editable prompt at ${width}px without duplicating context`, async ({
    page,
  }) => {
    await hostFixture(page);
    await page.setViewportSize({ width, height: 1000 });
    const requests: RequestBody[] = [];
    await page.route("**/api/chat", (route) => {
      requests.push(route.request().postDataJSON());
      if (requests.length === 2) {
        if (failure === "capacity")
          return route.fulfill({ status: 429, json: { detail: "All generation slots are busy." } });
        if (failure === "network") return route.abort("failed");
        return route.fulfill({
          contentType: "application/x-ndjson",
          body:
            failure === "malformed"
              ? "not-json\n"
              : JSON.stringify({
                  content: failure === "empty" ? "" : "Partial answer",
                  done: failure === "empty",
                }) + "\n",
        });
      }
      return route.fulfill({
        contentType: "application/x-ndjson",
        body: JSON.stringify({ content: "Completed answer", done: true }) + "\n",
      });
    });
    await page.goto("/playground");
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    const send = page.getByRole("button", { name: "Send message", exact: true });
    await expect(page.getByText("Available to try", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Set up guest access" })).toHaveCount(0);
    await composer.fill("Completed question");
    await send.click();
    await expect(page.getByText("Model answered a prompt", { exact: true })).toBeVisible();
    await composer.fill("Question to recover");
    await send.click();
    await expect(composer).toHaveValue("Question to recover");
    await expect(composer).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: /prompt is restored/ })).toBeVisible();
    if (failure === "truncated")
      await expect(page.getByText("Partial answer", { exact: true })).toBeVisible();
    await expect(send).toBeEnabled();
    expect(requests).toHaveLength(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `test-results/owner-recovery-${failure}-${width}.png`,
      fullPage: true,
    });
    await composer.fill("Edited retry");
    await send.click();
    await expect(page.getByText("Completed answer", { exact: true })).toHaveCount(2);
    expect(requests).toHaveLength(3);
    expect(requests[2].messages).toEqual([
      { role: "user", content: "Completed question" },
      { role: "assistant", content: "Completed answer" },
      { role: "user", content: "Edited retry" },
    ]);
    await expect(page.getByText("Question to recover", { exact: true })).toBeVisible();
  });
}

test("a completed test leads to the same model's client settings without enabling sharing", async ({
  page,
}) => {
  const other = "other-model:small";
  await hostFixture(page, true, [model, other]);
  let chatCalls = 0;
  let mutations = 0;
  await page.route("**/api/chat", (route) => {
    chatCalls++;
    expect(route.request().postDataJSON().model).toBe(other);
    return route.fulfill({
      contentType: "application/x-ndjson",
      body: '{"content":"Test answer","done":true}\n',
    });
  });
  await page.route("**/api/sharing**", (route) => {
    if (route.request().method() !== "GET") {
      mutations++;
      return route.abort();
    }
    return route.fulfill({
      json: {
        state: "stopped",
        hostLabel: "Local host",
        model: null,
        guestUrl: null,
        error: null,
        grants: [],
        internet: {
          state: "off",
          provider: "cloudflare-quick",
          available: true,
          publicUrl: null,
          checkedAt: null,
          error: null,
        },
      },
    });
  });
  await page.goto("/playground?model=" + encodeURIComponent(other));
  await expect(page.getByText("Available to try", { exact: true })).toBeVisible();
  expect(chatCalls).toBe(0);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Test this model");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const next = page.getByRole("link", { name: "Set up guest access" });
  await expect(next).toBeVisible();
  await page.screenshot({ path: "test-results/owner-model-tested.png", fullPage: true });
  await next.click();
  await expect(page.getByRole("combobox", { name: "Model for guests", exact: true })).toHaveValue(
    other,
  );
  expect(chatCalls).toBe(1);
  expect(mutations).toBe(0);
});

for (const status of [429, 503]) {
  test(`${status} retry waits survive model changes, navigation and clock corrections without resending`, async ({
    page,
  }) => {
    const other = "other-model:small";
    await hostFixture(page, true, [model, other]);
    await page.clock.install();
    await page.setViewportSize({ width: 320, height: 1000 });
    const requests: RequestBody[] = [];
    await page.route("**/api/chat", (route) => {
      requests.push(route.request().postDataJSON());
      return requests.length === 1
        ? route.fulfill({
            status,
            headers: { "Retry-After": "8" },
            json: { detail: "The host is temporarily busy." },
          })
        : route.fulfill({
            contentType: "application/x-ndjson",
            body: '{"content":"A manual retry answer","done":true}\n',
          });
    });
    await page.goto(`/playground?model=${encodeURIComponent(model)}`);
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    const send = page.getByRole("button", { name: "Send message", exact: true });
    await composer.fill("A rejected prompt");
    await send.click();
    await expect(composer).toHaveValue("A rejected prompt");
    await expect(composer).toBeFocused();
    await expect(send).toBeDisabled();
    await expect(page.getByText(/The host asked you to wait/)).toBeVisible();
    await composer.fill("Edited after rejection");
    await composer.press("Enter");
    expect(requests).toHaveLength(1);
    await page.clock.setFixedTime(new Date(Date.now() + 48 * 3_600_000));
    await page.clock.runFor(1000);
    await expect(send).toBeDisabled();
    await page.clock.setFixedTime(new Date(Date.now() - 48 * 3_600_000));
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.clock.runFor(50);
    const description = page.getByText(/The host asked you to wait/);
    await expect
      .poll(() =>
        description.evaluate((element) => {
          const text = document.createRange();
          text.selectNodeContents(element);
          return text.getBoundingClientRect().right <= document.documentElement.clientWidth;
        }),
      )
      .toBe(true);
    await page.screenshot({
      path: `test-results/owner-retry-${status}-mobile.png`,
      fullPage: false,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.getByRole("link", { name: "Models", exact: true }).click();
    await page.clock.runFor(2000);
    await page
      .getByRole("listitem")
      .filter({ has: page.getByRole("heading", { name: other, exact: true }) })
      .getByRole("link", { name: "Try in playground", exact: true })
      .click();
    await composer.fill("Another model's draft");
    await expect(send).toBeDisabled();
    await composer.press("Enter");
    await expect(page.getByText(/This wait applies to all models/)).toBeVisible();
    expect(requests).toHaveLength(1);
    await page.clock.runFor(10000);
    await expect(send).toBeEnabled();
    await expect(page.getByText(/The wait is over. Send manually/)).toBeVisible();
    expect(requests).toHaveLength(1);
    await page.getByRole("combobox", { name: "Model", exact: true }).selectOption(model);
    await expect(composer).toHaveValue("Edited after rejection");
    await send.click();
    await expect(page.getByText("A manual retry answer", { exact: true })).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests[1].messages).toEqual([{ role: "user", content: "Edited after rejection" }]);
    await expect(page.getByText(/This wait applies to all models/)).toHaveCount(0);
  });
}
