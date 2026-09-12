import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { hostFixture } from "./support/host-fixture";

// The real bridge script, so the host side is exercised against the shipped frame side.
const bridge = readFileSync(
  fileURLToPath(
    new URL("../../../backend/src/main/resources/hostai/hostai-bridge.js", import.meta.url),
  ),
  "utf8",
);

const page = `<!doctype html>
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
    <p id="theme">unknown</p>
    <script>
      hostai.ready().then(function (hello) {
        document.getElementById("hello").textContent =
          hello.model + " " + hello.scope + " " + hello.theme;
        document.getElementById("theme").textContent =
          document.documentElement.getAttribute("data-theme");
        return hostai.infer({ ping: 1 });
      }).then(function (events) {
        document.getElementById("result").textContent = "pong " + JSON.stringify(events);
      }, function (error) {
        document.getElementById("result").textContent = "error " + error.message;
      });
      hostai.onTheme(function (theme) {
        document.getElementById("theme").textContent = theme;
      });
    </script>
  </body>
</html>`;

async function modelUiFixture(page_: import("@playwright/test").Page) {
  await hostFixture(page_, true, ["fixture-model:small"]);
  await page_.route("**/api/models", (route) =>
    route.fulfill({
      json: {
        connected: true,
        models: [
          {
            name: "pebby:latest",
            sizeBytes: 12345,
            parameterSize: "3.2K",
            quantization: "F32",
            modifiedAt: new Date().toISOString(),
            chatUnavailableReason: "This model only supports /api/infer.",
            ui: { runtime: "stub", entry: "ui/index.html" },
          },
          {
            name: "fixture-model:small",
            sizeBytes: 800000000,
            parameterSize: "0.6B",
            quantization: "Q4_K_M",
            modifiedAt: new Date().toISOString(),
            chatUnavailableReason: null,
          },
        ],
      },
    }),
  );
  await page_.route("**/api/model-ui/stub/ui/index.html", (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: page }),
  );
  await page_.route("**/api/model-ui/stub/ui/hostai-bridge.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: bridge }),
  );
}

test("a runtime interface replaces the chat panel and reaches /api/infer", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await modelUiFixture(page);
  const inferBodies: unknown[] = [];
  await page.route("**/api/infer", (route) => {
    inferBodies.push(route.request().postDataJSON());
    return route.fulfill({
      contentType: "application/x-ndjson",
      body: '{"event":{"pong":1},"done":false}\n{"done":true}\n',
    });
  });
  await page.goto("/playground?model=pebby%3Alatest");
  const frame = page.locator("iframe[title='pebby:latest interface']");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(frame).toHaveAttribute("src", "/api/model-ui/stub/ui/index.html");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Clear", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Run settings" })).toHaveCount(0);
  await expect(page.getByText("Interface ready", { exact: true })).toBeVisible();
  await expect(page.getByText("Selected model cannot chat", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Interface provided by the stub runtime/)).toBeVisible();

  const inner = page.frameLocator("iframe[title='pebby:latest interface']");
  await expect(inner.locator("#hello")).toHaveText("pebby:latest owner light");
  await expect(inner.locator("#result")).toHaveText('pong [{"pong":1}]');
  expect(inferBodies).toEqual([{ model: "pebby:latest", input: { ping: 1 } }]);

  // The frame follows the host theme through the bridge.
  await page.getByRole("button", { name: /^Theme:/ }).click();
  await page.getByRole("button", { name: /^Theme:/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(inner.locator("#theme")).toHaveText("dark");
  await page.screenshot({ path: "test-results/playground-model-ui.png", fullPage: true });

  // Switching to a chat model brings the composer back and drops the frame.
  await page.getByRole("combobox", { name: "Model" }).selectOption("fixture-model:small");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Run settings" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("the API example shows /api/infer for a runtime interface", async ({ page }) => {
  await modelUiFixture(page);
  await page.goto("/playground?model=pebby%3Alatest");
  await page.getByRole("button", { name: "API example" }).click();
  await expect(page.getByText(/\/api\/infer/)).toBeVisible();
  await expect(page.getByText(/\/api\/chat/)).toHaveCount(0);
});
