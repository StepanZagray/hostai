import { test, expect } from "@playwright/test";

test("shared UI streams through Java and releases a cancelled request", async ({ page }) => {
  test.skip(
    process.env.HOSTAI_INTEGRATION !== "1",
    "Requires Java pointed at the explicit isolated Ollama fixture.",
  );
  await page.goto("/playground");
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
