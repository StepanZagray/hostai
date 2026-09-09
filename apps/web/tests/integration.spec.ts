import { test, expect } from "@playwright/test";

test("shared UI streams through Java and releases a cancelled request", async ({ page }) => {
  test.skip(
    process.env.HOSTAI_INTEGRATION !== "1",
    "Requires Java pointed at the explicit isolated Ollama fixture.",
  );
  await page.goto("/models");
  await expect(page.getByRole("heading", { name: "test-remote:cloud", exact: true })).toBeVisible();
  await expect(
    page.getByText("Cloud models are not supported by this local gateway.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Try in playground" })).toHaveCount(1);
  await page.getByRole("link", { name: "Playground", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveValue(
    "test-model:small",
  );
  await expect(page.getByText("Local inference ready", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Integration check");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByText("Hello from the isolated test runtime. Stream complete.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "12 output tokens" })).toBeVisible();
  await expect
    .poll(async () => (await (await page.request.get("/api/requests")).json()).requests[0])
    .toMatchObject({ status: "completed", outputTokens: 12 });
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Cancellation check");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByText("Hello from the isolated test runtime.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Generation stopped" })).toBeVisible();
  await expect(
    page.getByText("Stopped response · Not used in later prompts.", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/cancelled-conversation.png", fullPage: true });
  await expect
    .poll(async () => (await (await page.request.get("/api/status")).json()).activeRequests)
    .toBe(0);
  await expect
    .poll(async () => (await (await page.request.get("/api/requests")).json()).requests[0].status)
    .toBe("cancelled");
  const nextRequest = page.waitForRequest(
    (request) => request.url().endsWith("/api/chat") && request.method() === "POST",
  );
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("After stopping");
  await page.getByRole("button", { name: "Send message" }).click();
  expect((await nextRequest).postDataJSON().messages).toEqual([
    { role: "user", content: "Integration check" },
    { role: "assistant", content: "Hello from the isolated test runtime. Stream complete." },
    { role: "user", content: "Cancellation check" },
    { role: "user", content: "After stopping" },
  ]);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Request activity", exact: true }).click();
  await expect(page.getByRole("cell", { name: "completed", exact: true }).first()).toBeVisible();
});

test("downloads through the real proxy and Java, cancels, retries and chats with the installed fixture", async ({
  page,
}) => {
  test.skip(
    process.env.HOSTAI_INTEGRATION !== "1",
    "Requires Java pointed at the explicit isolated Ollama fixture.",
  );
  await page.goto("/models");
  const panel = page.getByRole("region", { name: "Model downloads", exact: true });
  await page.getByLabel("Model and tag", { exact: true }).fill("fixture-download:small");
  await panel.getByRole("button", { name: "Download model", exact: true }).click();
  await expect(panel.getByRole("progressbar")).toHaveAttribute("value", "25000000");
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page.goto("/models");
  await expect(panel.getByRole("progressbar")).toHaveAttribute("value", "25000000");
  await panel.getByRole("button", { name: "Cancel download", exact: true }).click();
  await expect(panel.getByText("Cancelled", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Retry download", exact: true }).click();
  await expect(
    panel.getByRole("link", { name: "Try downloaded model", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/download-integration-complete.png", fullPage: true });
  await panel.getByRole("link", { name: "Try downloaded model", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveValue(
    "fixture-download:small",
  );
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("First prompt after download");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByText("Hello from the isolated test runtime. Stream complete.", { exact: true }),
  ).toBeVisible();
});
