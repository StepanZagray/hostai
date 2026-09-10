import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { hostFixture } from "./support/host-fixture";

// Diagnostic measurements, not hardware-dependent pass/fail timing gates.
// Run only through scripts/test-ui.py against a production build.
test.skip(process.env.HOSTAI_RENDER_BENCH !== "1", "Opt-in production rendering measurement");

for (const kind of ["prose", "markdown"] as const) {
  const slowdown = 4;
  test(`measure ${kind} streaming rendering at ${slowdown}x CPU slowdown`, async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(60000);
    await hostFixture(page);
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: slowdown });
      const unit =
        kind === "prose"
          ? "A short paragraph explains the implementation and its assumptions.\n\n"
          : "## A useful section\n\n- **First** step\n- Second `step`\n\n```js\nconst n = 42;\n```\n\n| Name | Value |\n| - | - |\n| answer | 42 |\n\n";
      const content = unit.repeat(Math.ceil(16_000 / unit.length)).slice(0, 16_000);
      await page.context().route("**/render-measurement-worker.js", (route) =>
        route.fulfill({
          contentType: "application/javascript",
          body: `onmessage = ({data}) => {\n  let offset = 0;\n  const timer = setInterval(() => {\n    const part = data.slice(offset, offset + 16);\n    offset += part.length;\n    const done = offset >= data.length;\n    postMessage({ content: part, done, sent: performance.timeOrigin + performance.now() });\n    if (done) clearInterval(timer);\n  }, 10);\n};`,
        }),
      );
      await page.addInitScript(
        ({ content }) => {
          const state = {
            start: 0,
            received: 0,
            mutations: 0,
            longTasks: [] as number[],
            frames: [] as number[],
            deliveryLags: [] as number[],
            end: 0,
            sentAt: [] as number[],
          };
          let stop = () => {};
          let copied = "";
          Object.defineProperty(navigator, "clipboard", {
            value: {
              writeText: async (text: string) => {
                copied = text;
              },
            },
          });
          Object.assign(window, {
            renderMeasurement: state,
            stopMeasurement: () => stop(),
            measuredCopy: () => copied,
          });
          const original = window.fetch.bind(window);
          window.fetch = async (input, init) => {
            const url = new URL(
              input instanceof Request ? input.url : String(input),
              location.href,
            );
            if (url.pathname !== "/api/chat") return original(input, init);
            state.start = performance.now();
            const tasks = new PerformanceObserver((list) =>
              state.longTasks.push(...list.getEntries().map((entry) => entry.duration)),
            );
            tasks.observe({ type: "longtask" });
            const pane = document.querySelector(
              '[aria-label="Conversation messages"]',
            )!.parentElement!;
            const mutations = new MutationObserver(() => state.mutations++);
            mutations.observe(pane, { characterData: true, childList: true, subtree: true });
            let previous = performance.now();
            let frame = requestAnimationFrame(tick);
            function tick(now: number) {
              state.frames.push(now - previous);
              previous = now;
              frame = requestAnimationFrame(tick);
            }
            const worker = new Worker("/render-measurement-worker.js");
            let streamController: ReadableStreamDefaultController<Uint8Array>;
            const abort = () => {
              worker.terminate();
              streamController.error(new DOMException("Aborted", "AbortError"));
            };
            stop = () => {
              worker.terminate();
              cancelAnimationFrame(frame);
              tasks.disconnect();
              mutations.disconnect();
              init?.signal?.removeEventListener("abort", abort);
              state.end = performance.now();
            };
            init?.signal?.addEventListener("abort", abort, { once: true });
            return new Response(
              new ReadableStream({
                start(controller) {
                  streamController = controller;
                  worker.onmessage = ({ data }) => {
                    state.received++;
                    state.sentAt.push(data.sent);
                    state.deliveryLags.push(performance.timeOrigin + performance.now() - data.sent);
                    controller.enqueue(
                      new TextEncoder().encode(
                        JSON.stringify({ content: data.content, done: data.done }) + "\n",
                      ),
                    );
                    if (data.done) controller.close();
                  };
                  worker.postMessage(content);
                },
                cancel() {
                  worker.terminate();
                },
              }),
              { headers: { "Content-Type": "application/x-ndjson" } },
            );
          };
        },
        { content },
      );
      await page.goto("/playground");
      await expect(page.getByText("Available to try", { exact: true })).toBeVisible();
      await page
        .getByRole("textbox", { name: "Message", exact: true })
        .fill("Measure a long answer");
      await page.getByRole("button", { name: "Send message" }).click();
      await expect(page.getByRole("button", { name: "Copy response", exact: true })).toBeEnabled({
        timeout: 40000,
      });
      await expect(
        page.getByLabel("Conversation messages", { exact: true }).locator('[aria-busy="true"]'),
      ).toHaveCount(0);
      const result = await page.evaluate(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const w = window as typeof window & {
          stopMeasurement: () => void;
          renderMeasurement: unknown;
        };
        w.stopMeasurement();
        return w.renderMeasurement;
      });
      writeFileSync(
        `test-results/render-${kind}-${slowdown}x-${testInfo.repeatEachIndex}.json`,
        JSON.stringify(
          {
            browser: browser.version(),
            viewport: page.viewportSize(),
            sourceChars: content.length,
            chunkChars: 16,
            nominalIntervalMs: 10,
            cpuSlowdown: slowdown,
            following: true,
            ...(result as object),
          },
          null,
          2,
        ),
      );
      await page.getByRole("button", { name: "Copy response", exact: true }).click();
      expect(
        await page.evaluate(() =>
          (window as typeof window & { measuredCopy: () => string }).measuredCopy(),
        ),
      ).toBe(content);
      console.log(kind, "measurement saved; original response preserved");
      await page.screenshot({
        path: `test-results/render-${kind}-${slowdown}x.png`,
        fullPage: true,
      });
    } finally {
      try {
        await page.evaluate(() =>
          (window as typeof window & { stopMeasurement?: () => void }).stopMeasurement?.(),
        );
      } finally {
        await cdp.detach();
      }
    }
  });
}
