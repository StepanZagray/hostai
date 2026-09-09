import { expect, test } from "@playwright/test";
import { hostFixture } from "./support/host-fixture";

type ClipboardWindow = typeof window & {
  copiedText?: string;
  failCopy?: boolean;
  settleCopies?: (() => void)[];
};
const answer =
  '# A useful answer\n\nUse **careful steps** and `code`.\n\n1. First step\n2. Second step\n\n```js\nconst message = "hello";\nconsole.log(message);\n```\n\n| Name | Value |\n| - | - |\n| answer | 42 |\n\n[Reference](https://example.com/reference)\n\n![Optional image](https://example.com/private-image.png)';

test("formatted answers copy original text and code while prompts remain literal", async ({
  page,
}) => {
  await hostFixture(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          if ((window as ClipboardWindow).failCopy) throw new Error("Denied");
          (window as ClipboardWindow).copiedText = text;
        },
      },
    });
  });
  const outgoing: { messages: { role: string; content: string }[] }[] = [];
  const remote: string[] = [];
  await page.route("https://example.com/**", (route) => {
    remote.push(route.request().url());
    return route.abort();
  });
  await page.route("**/api/chat", (route) => {
    outgoing.push(route.request().postDataJSON());
    return route.fulfill({
      contentType: "application/x-ndjson",
      body: JSON.stringify({ content: answer, done: true }) + "\n",
    });
  });
  await page.goto("/playground");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("# Literal user prompt");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("heading", { name: "A useful answer", exact: true })).toBeVisible();
  await expect(page.getByText("# Literal user prompt", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Literal user prompt" })).toHaveCount(0);
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("img", { name: "Optional image" })).toHaveCount(0);
  expect(remote).toEqual([]);
  await page.getByRole("button", { name: "Copy response", exact: true }).click();
  expect(await page.evaluate(() => (window as ClipboardWindow).copiedText)).toBe(answer);
  await expect(page.getByRole("status").filter({ hasText: "Copied" })).toBeVisible();
  await page.getByRole("button", { name: "Copy code", exact: true }).click();
  expect(await page.evaluate(() => (window as ClipboardWindow).copiedText)).toBe(
    'const message = "hello";\nconsole.log(message);\n',
  );
  await page.screenshot({ path: "test-results/formatted-answer.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "test-results/mobile-formatted-answer.png", fullPage: true });
  await page.evaluate(() => {
    (window as ClipboardWindow).failCopy = true;
  });
  await page.getByRole("button", { name: "Copy response", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Select and copy the text manually" }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Follow up");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => outgoing.length).toBe(2);
  expect(outgoing[1].messages).toContainEqual({ role: "assistant", content: answer });
});

test("unfinished code remains readable and a failed answer can be copied as partial", async ({
  page,
}) => {
  await hostFixture(page);
  const partial = '```python\nprint("unfinished")';
  await page.route("**/api/chat", (route) =>
    route.fulfill({
      contentType: "application/x-ndjson",
      body: JSON.stringify({ content: partial, done: false }) + "\n",
    }),
  );
  await page.goto("/playground");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Code please");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByLabel("python code", { exact: true })).toContainText(
    'print("unfinished")',
  );
  await expect(
    page.getByText("Incomplete response · Not used in later prompts.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Copy partial response", exact: true }),
  ).toBeEnabled();
});

test("wide code stays inside the answer at 320px", async ({ page }) => {
  await hostFixture(page);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.route("**/api/chat", (route) =>
    route.fulfill({
      contentType: "application/x-ndjson",
      body:
        JSON.stringify({ content: "```text\n" + "long_code_".repeat(40) + "\n```", done: true }) +
        "\n",
    }),
  );
  await page.goto("/playground");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Wide code");
  await page.getByRole("button", { name: "Send message" }).click();
  const code = page.getByLabel("text code", { exact: true });
  await expect(code).toBeVisible();
  expect(await code.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await code.focus();
  await page.keyboard.press("End");
  await expect(code).toBeFocused();
  await page.screenshot({ path: "test-results/narrow-code-answer.png", fullPage: true });
});

test("copy feedback belongs to the current command even when writes finish out of order", async ({
  page,
}) => {
  await hostFixture(page);
  await page.addInitScript(() => {
    (window as ClipboardWindow).settleCopies = [];
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: () =>
          new Promise<void>((resolve) => (window as ClipboardWindow).settleCopies!.push(resolve)),
      },
    });
  });
  await page.goto("/playground");
  await expect(page.getByText("Local inference ready", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "API example", exact: true }).click();
  const copy = page.getByRole("button", { name: "Copy command", exact: true });
  await copy.click();
  await expect(copy).toBeDisabled();
  await page.getByRole("slider", { name: /Temperature/ }).fill("1");
  await expect(copy).toBeEnabled();
  await copy.click();
  await page.evaluate(() => (window as ClipboardWindow).settleCopies![1]());
  const status = page.getByRole("status").filter({ hasText: "Copied" });
  await expect(status).toBeVisible();
  await page.evaluate(() => (window as ClipboardWindow).settleCopies![0]());
  await expect(status).toBeVisible();
  await page.getByRole("slider", { name: /Temperature/ }).fill("1.1");
  await expect(status).toHaveCount(0);
});
