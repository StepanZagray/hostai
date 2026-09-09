import { expect, test, type Page } from "@playwright/test";
import { hostFixture } from "./support/host-fixture";

type ControlledWindow = typeof window & { pushChat: (content: string, done: boolean) => void };

async function controlledChat(page: Page) {
  await hostFixture(page, true, ["fixture-model:small", "other-model:small"]);
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.pathname !== "/api/chat") return realFetch(input, init);
      return new Response(
        new ReadableStream({
          start(controller) {
            (window as ControlledWindow).pushChat = (content, done) => {
              controller.enqueue(
                new TextEncoder().encode(JSON.stringify({ content, done }) + "\n"),
              );
              if (done) controller.close();
            };
          },
        }),
        { headers: { "Content-Type": "application/x-ndjson" } },
      );
    };
  });
  await page.goto("/playground");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Read a long answer");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForFunction(() => typeof (window as ControlledWindow).pushChat === "function");
}

async function push(page: Page, content: string, done = false) {
  await page.evaluate(({ content, done }) => (window as ControlledWindow).pushChat(content, done), {
    content,
    done,
  });
}
const longAnswer = Array.from(
  { length: 100 },
  (_, i) => `Line ${i + 1}: A paragraph worth reading.\n`,
).join("");

test("streaming preserves a reader's position above the latest output", async ({ page }) => {
  await controlledChat(page);
  const pane = page.getByLabel("Conversation messages", { exact: true });
  await push(page, longAnswer);
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(500);
  await pane.hover();
  await page.mouse.wheel(0, -500);
  await expect
    .poll(() =>
      pane.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
    )
    .toBeGreaterThan(300);
  const before = await pane.evaluate((element) => element.scrollTop);
  await push(page, "New streamed output.\n");
  await expect(pane).toContainText("New streamed output.");
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBe(before);
  const jump = page.getByRole("button", { name: "Jump to latest", exact: true });
  await expect(jump).toBeVisible();
  await page.screenshot({ path: "test-results/conversation-reading-earlier.png", fullPage: true });
  await jump.focus();
  await jump.press("Enter");
  await expect(pane).toBeFocused();
  await expect(jump).toHaveCount(0);
  await push(page, "Following again.\n");
  await expect
    .poll(() =>
      pane.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
    )
    .toBeLessThanOrEqual(2);
  await page.screenshot({ path: "test-results/conversation-following.png", fullPage: true });
  await pane.press("Home");
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(jump).toBeVisible();
  await push(page, "Finished.\n", true);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBe(0);
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(jump).toHaveCount(0);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Start fresh");
  await page.getByRole("button", { name: "Send message" }).click();
  await push(page, longAnswer, true);
  // A short, not-yet-rendered answer also has a zero bottom gap. Wait for overflow
  // before testing native scroll-away input on the newly mounted conversation.
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(500);
  await expect
    .poll(() =>
      pane.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
    )
    .toBeLessThanOrEqual(2);
  await pane.focus();
  await pane.press("Home");
  await expect(jump).toBeVisible();
  await page
    .getByRole("combobox", { name: "Model", exact: true })
    .selectOption("other-model:small");
  await expect(jump).toHaveCount(0);
  await expect(pane.getByText("Line 100:", { exact: false })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("New model");
  await page.getByRole("button", { name: "Send message" }).click();
  await push(page, longAnswer, true);
  // A short, not-yet-rendered answer also has a zero bottom gap. Wait for overflow
  // before testing native scroll-away input on the newly mounted conversation.
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(500);
  await expect
    .poll(() =>
      pane.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
    )
    .toBeLessThanOrEqual(2);
  await pane.focus();
  await pane.press("Home");
  await expect(jump).toBeVisible();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Follow up while reading");
  await page.getByRole("button", { name: "Send message" }).click();
  await push(page, "The follow-up answer.\n", true);
  await expect(pane.getByText("The follow-up answer.", { exact: true })).toBeVisible();
  await expect(jump).toHaveCount(0);
  await expect
    .poll(() =>
      pane.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
    )
    .toBeLessThanOrEqual(2);
});

test("following new output never scrolls the surrounding page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await controlledChat(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await push(page, longAnswer);
  await expect(page.getByLabel("Conversation messages", { exact: true })).toContainText(
    "Line 100:",
  );
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test("viewport changes keep following output without overriding a paused reader", async ({
  page,
}) => {
  await controlledChat(page);
  const pane = page.getByLabel("Conversation messages", { exact: true });
  const jump = page.getByRole("button", { name: "Jump to latest", exact: true });
  await push(page, longAnswer);
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await expect
      .poll(() =>
        pane.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
      )
      .toBeLessThanOrEqual(2);
    await expect(jump).toHaveCount(0);
  }
  await pane.focus();
  await pane.press("Home");
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(jump).toBeVisible();
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(jump).toBeVisible();
  await push(page, "Still paused.\n");
  await expect(pane).toContainText("Still paused.");
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBe(0);
  await page.screenshot({ path: "test-results/mobile-conversation-reading.png", fullPage: true });
  await pane.press("End");
  await expect(jump).toHaveCount(0);
  await push(page, "End of the answer.\n", true);
  await expect
    .poll(() =>
      pane.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
    )
    .toBeLessThanOrEqual(2);
});

for (const gesture of ["wheel", "keyboard", "touch"] as const) {
  test(`${gesture} scroll-away intent wins over simultaneous reflow`, async ({ page }) => {
    await controlledChat(page);
    const pane = page.getByLabel("Conversation messages", { exact: true });
    await push(page, longAnswer);
    await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(500);
    // Deterministic ordering: layout changes before the input's scroll event,
    // but ResizeObserver has not run. Native wheel/keyboard paths are tested above.
    const before = await pane.evaluate((element, gesture) => {
      element.style.height = "450px";
      if (gesture === "wheel")
        element.dispatchEvent(new WheelEvent("wheel", { deltaY: -300, bubbles: true }));
      if (gesture === "keyboard")
        element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      if (gesture === "touch") {
        element.dispatchEvent(
          new TouchEvent("touchstart", {
            touches: [new Touch({ identifier: 1, target: element, clientY: 100 })],
            bubbles: true,
          }),
        );
        element.dispatchEvent(
          new TouchEvent("touchmove", {
            touches: [new Touch({ identifier: 1, target: element, clientY: 200 })],
            bubbles: true,
          }),
        );
      }
      element.scrollTop -= 300;
      const top = element.scrollTop;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
      return top;
    }, gesture);
    await push(page, "Arrived during reflow.\n", true);
    await expect(pane).toContainText("Arrived during reflow.");
    await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBe(before);
    await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toBeVisible();
  });
}

test("keyboard reading survives a stream arriving during native scroll animation", async ({
  page,
}) => {
  await controlledChat(page);
  const pane = page.getByLabel("Conversation messages", { exact: true });
  await push(page, longAnswer);
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(500);
  await pane.focus();
  const timer = await page.evaluate(() =>
    window.setInterval(
      () => (window as ControlledWindow).pushChat("More live output.\n", false),
      16,
    ),
  );
  try {
    await pane.press("ArrowUp");
    await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toBeVisible();
    await expect
      .poll(() =>
        pane.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
      )
      .toBeGreaterThan(100);
  } finally {
    await page.evaluate((timer) => window.clearInterval(timer), timer);
  }
});
