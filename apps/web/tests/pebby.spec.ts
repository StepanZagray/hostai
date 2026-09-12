import { expect, test, type Frame, type Page } from "@playwright/test";

// Opt-in end-to-end proof that a real runtime interface (Pebby's 8x8 grid) works
// inside the Playground: the sandboxed frame loads through /api/model-ui, arrow
// keys and arrow buttons reach the model through the gateway, and the object moves.
// Requires a live stack at HOSTAI_TEST_URL: Pebby `uv run serve.py`, the Java
// gateway with HOSTAI_OLLAMA_URL pointing at it, and `node server.mjs`.
test.skip(process.env.HOSTAI_PEBBY !== "1", "Requires a running Pebby + gateway stack");

const MODEL = "pebby:latest";
const FRAME = `iframe[title='${MODEL} interface']`;

type CspWindow = Window & { cspViolations: string[] };

async function cspViolations(target: Page | Frame) {
  return target.evaluate(() => (window as unknown as CspWindow).cspViolations ?? []);
}

test("Pebby's grid moves through the gateway from arrow keys and buttons", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Console "Failed to load resource" lines carry no URL; failed responses are
  // tracked by URL below so the host's missing /favicon.ico can be told apart.
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
      errors.push(message.text());
    }
  });
  const failedUrls: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400) failedUrls.push(new URL(response.url()).pathname);
  });
  // Runs in the top document and in every frame, sandboxed or not.
  await page.addInitScript(() => {
    const state = window as unknown as CspWindow;
    state.cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      state.cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  const inferBodies: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/infer") {
      inferBodies.push(request.postDataJSON());
    }
  });

  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(`/playground?model=${encodeURIComponent(MODEL)}`);

  // The frame replaces the chat composer.
  const frameEl = page.locator(FRAME);
  await expect(frameEl).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frameEl).toHaveAttribute("src", "/api/model-ui/pebby/ui/index.html");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Run settings" })).toHaveCount(0);
  await expect(page.getByText("Interface ready", { exact: true })).toBeVisible();

  const inner = page.frameLocator(FRAME);
  const status = inner.locator("#status");
  const board = inner.getByRole("grid", { name: "Pebby board" });
  const objectCells = board.locator("td.is-object");
  const objectAt = (row: number, column: number) =>
    board.locator(`td[aria-label='Row ${row}, column ${column}: object']`);

  await expect(status).toHaveText("Ready. Use the arrows or arrow keys.");
  await expect(inner.locator("#model")).toHaveText(MODEL);
  await expect(objectCells).toHaveCount(1);
  await expect(objectAt(3, 3)).toBeVisible();
  for (const name of ["Up", "Down", "Left", "Right"]) {
    await expect(inner.getByRole("button", { name, exact: true })).toBeEnabled();
  }

  // Keyboard without a prior click: the grid takes focus once the bridge is ready, so
  // the frame's window keydown listener receives the key, not the host document.
  await expect(board).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(objectAt(3, 4)).toBeVisible();
  await expect(objectCells).toHaveCount(1);
  await expect(status).toHaveText("Last action: right");

  // Arrow button.
  await inner.getByRole("button", { name: "Up", exact: true }).click();
  await expect(objectAt(2, 4)).toBeVisible();
  await expect(objectCells).toHaveCount(1);
  await expect(status).toHaveText("Last action: up");

  // Keyboard again after the button click moved focus to a control inside the frame.
  await page.keyboard.press("ArrowLeft");
  await expect(objectAt(2, 3)).toBeVisible();
  await expect(objectCells).toHaveCount(1);
  await expect(status).toHaveText("Last action: left");
  await expect(inner.locator("#warning")).toBeHidden();

  // Every move was a real /api/infer call from the host with the frame's board state.
  expect(inferBodies).toHaveLength(3);
  expect(
    inferBodies.map((body) => (body as { model: string; input: { action: string } }).model),
  ).toEqual([MODEL, MODEL, MODEL]);
  expect(inferBodies.map((body) => (body as { input: { action: string } }).input.action)).toEqual([
    "right",
    "up",
    "left",
  ]);

  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: "test-results/pebby-playground-light.png", fullPage: true });

  // system -> light -> dark; the frame follows through the bridge.
  await page.getByRole("button", { name: /^Theme:/ }).click();
  await page.getByRole("button", { name: /^Theme:/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(inner.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.waitForTimeout(150);
  await page.screenshot({ path: "test-results/pebby-playground-dark.png", fullPage: true });

  const frame = page.frame({ url: /\/api\/model-ui\/pebby\// });
  expect(frame).not.toBeNull();
  expect(await cspViolations(page)).toEqual([]);
  expect(await cspViolations(frame!)).toEqual([]);
  expect(errors).toEqual([]);
  expect(failedUrls.filter((path) => path !== "/favicon.ico")).toEqual([]);
});
