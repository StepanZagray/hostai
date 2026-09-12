import { expect, test } from "@playwright/test";
import { hostFixture } from "./support/host-fixture";

const a = "fixture-model:small";
const b = "other-model:small";

test("each model retains its conversation, draft and settings through navigation and clear", async ({
  page,
}) => {
  await hostFixture(page, true, [a, b]);
  const requests: { model: string; messages: { role: string; content: string }[] }[] = [];
  await page.route("**/api/chat", (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    return route.fulfill({
      contentType: "application/x-ndjson",
      body: JSON.stringify({ content: `Answer from ${body.model}`, done: true }) + "\n",
    });
  });
  await page.goto("/playground?model=" + encodeURIComponent(a));
  const select = page.getByRole("combobox", { name: "Model", exact: true });
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  const temperature = page.getByRole("slider", { name: /Temperature/ });
  const tokens = page.getByLabel("Maximum output tokens", { exact: true });
  await temperature.fill("1.2");
  await tokens.selectOption("128");
  await composer.fill("Question A");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(`Answer from ${a}`, { exact: true })).toBeVisible();
  await composer.fill("Draft A");
  await select.selectOption(b);
  await expect(page).toHaveURL(/model=other-model%3Asmall/);
  await expect(composer).toHaveValue("");
  await temperature.fill("0.2");
  await tokens.selectOption("256");
  await composer.fill("Question B");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(`Answer from ${b}`, { exact: true })).toBeVisible();
  await composer.fill("Draft B");
  await page.getByRole("link", { name: "Models", exact: true }).click();
  await page
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: a, exact: true }) })
    .getByRole("link", { name: "Try in playground" })
    .click();
  await expect(select).toHaveValue(a);
  await expect(composer).toHaveValue("Draft A");
  await expect(temperature).toHaveValue("1.2");
  await expect(tokens).toHaveValue("128");
  await expect(page.getByText(`Answer from ${a}`, { exact: true })).toBeVisible();
  await expect(page.getByText(`Answer from ${b}`, { exact: true })).toHaveCount(0);
  expect(requests).toHaveLength(2);
  await page.screenshot({ path: "test-results/owner-memory-restored.png", fullPage: true });
  await page.setViewportSize({ width: 320, height: 850 });
  await expect(composer).toHaveValue("Draft A");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const description = page.getByText(`Answer from ${a}`, { exact: true });
  await expect
    .poll(() =>
      description.evaluate((element) => {
        const text = document.createRange();
        text.selectNodeContents(element);
        return text.getBoundingClientRect().right <= document.documentElement.clientWidth;
      }),
    )
    .toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.screenshot({ path: "test-results/owner-memory-restored-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await select.selectOption(b);
  await expect(composer).toHaveValue("Draft B");
  await expect(temperature).toHaveValue("0.2");
  await expect(tokens).toHaveValue("256");
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByText(`Answer from ${b}`, { exact: true })).toHaveCount(0);
  await expect(composer).toHaveValue("Draft B");
  await page.getByRole("link", { name: "Connection", exact: true }).click();
  await page.getByRole("link", { name: "Playground", exact: true }).click();
  await expect(select).toHaveValue(b);
  await expect(composer).toHaveValue("Draft B");
  await expect(page.getByText(`Answer from ${b}`, { exact: true })).toHaveCount(0);
  await select.selectOption(a);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2].messages).toEqual([
    { role: "user", content: "Question A" },
    { role: "assistant", content: `Answer from ${a}` },
    { role: "user", content: "Draft A" },
  ]);
  await page.reload();
  await expect(composer).toHaveValue("");
  await expect(page.getByRole("article")).toHaveCount(0);
  expect(requests).toHaveLength(3);
  const stored = await page.evaluate(() => ({
    local: { ...localStorage },
    session: { ...sessionStorage },
  }));
  expect(stored.local).toEqual({});
  // The router persists scroll coordinates; conversation content must stay in memory.
  expect(Object.keys(stored.session)).toEqual(["tsr-scroll-restoration-v1_3"]);
  expect(JSON.stringify(stored)).not.toMatch(/Question A|Question B|Draft A|Draft B|Answer from/);
});

test("model disappearance cannot replace an unsent draft and reappearance restores admission", async ({
  page,
}) => {
  await hostFixture(page, true, [a, b]);
  let missing = false;
  await page.route("**/api/models", (route) =>
    route.fulfill({
      json: {
        connected: true,
        models: (missing ? [b] : [a, b]).map((name) => ({
          name,
          sizeBytes: 1,
          parameterSize: "small",
          quantization: "Q4",
          modifiedAt: new Date().toISOString(),
          chatUnavailableReason: null,
        })),
      },
    }),
  );
  await page.clock.install();
  await page.goto("/playground");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  const select = page.getByRole("combobox", { name: "Model", exact: true });
  await composer.fill("Unsent for A");
  missing = true;
  await page.clock.runFor(15001);
  await expect(select).toHaveValue(a);
  await expect(composer).toHaveValue("Unsent for A");
  await expect(composer).toBeDisabled();
  await expect(page.getByText("Selected model unavailable", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Review model library", exact: true }),
  ).toHaveAttribute("href", "/models");
  await page.screenshot({ path: "test-results/owner-memory-model-missing.png", fullPage: true });
  missing = false;
  await page.clock.runFor(15001);
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveValue("Unsent for A");
});

test("switching models after recovery keeps keyboard focus on the model selector", async ({
  page,
}) => {
  await hostFixture(page, true, [a, b]);
  await page.route("**/api/chat", (route) =>
    route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } }),
  );
  await page.goto("/playground?model=" + encodeURIComponent(a));
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  const select = page.getByRole("combobox", { name: "Model", exact: true });
  await composer.fill("Recover this prompt");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(composer).toHaveValue("Recover this prompt");
  await expect(composer).toBeFocused();
  await select.focus();
  await select.selectOption(b);
  await expect(composer).toHaveValue("");
  await expect(select).toBeFocused();
  await select.selectOption(a);
  await expect(composer).toHaveValue("Recover this prompt");
  await expect(select).toBeFocused();
});
