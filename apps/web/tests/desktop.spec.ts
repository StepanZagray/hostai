import { chromium, expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";

test("Electron renders the shared localhost app with an isolated renderer", async () => {
  const address = process.env.HOSTAI_TEST_URL || "http://127.0.0.1:3000";
  const child = spawn(
    resolve("apps/desktop/node_modules/electron/dist/electron"),
    [
      "--remote-debugging-port=0",
      "--ozone-platform=wayland",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      resolve("apps/desktop"),
    ],
    {
      env: {
        ...process.env,
        HOSTAI_UI_URL: address,
        HOSTAI_DESKTOP_USER_DATA: resolve(process.env.XDG_RUNTIME_DIR!, "../electron-profile"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    const endpoint = await new Promise<string>((accept, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error(`Electron did not start: ${output}`)), 10000);
      child.stderr.on("data", (chunk) => {
        output += chunk.toString();
        const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) {
          clearTimeout(timer);
          accept(match[1]);
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Electron exited (${code}): ${output}`));
      });
    });
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || (await context.waitForEvent("page"));
    await expect(page.getByRole("heading", { name: "Host overview" })).toBeVisible();
    await expect(page.getByText(/Gateway (online|offline)/)).toBeVisible();
    expect(await page.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe(
      "undefined",
    );
    execFileSync("grim", [
      "-o",
      "HEADLESS-1",
      resolve(process.env.XDG_RUNTIME_DIR!, "../electron-overview.png"),
    ]);
    await page.getByRole("link", { name: "Playground", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Playground", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  } finally {
    await browser?.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await once(child, "exit");
      clearTimeout(timer);
    }
  }
});
