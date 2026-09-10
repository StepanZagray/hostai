import { expect, it, vi } from "vite-plus/test";
import { createOwnerConversations } from "./owner-conversations";

const answer = (content = "Answer") => new Response(JSON.stringify({ content, done: true }) + "\n");
const settled = () => {};

it("keeps per-model drafts, settings and completed context without sending on selection", async () => {
  const fetchChat = vi.fn<typeof fetch>().mockImplementation(async () => answer());
  const store = createOwnerConversations(fetchChat);
  store.select("a:small");
  store.edit("a:small", { prompt: "A question", temperature: 1.2, maxTokens: 128 });
  await store.send("a:small", true, settled);
  store.edit("a:small", { prompt: "A draft" });
  store.select("b:small");
  store.edit("b:small", { prompt: "B draft", temperature: 0.2 });
  store.select("a:small");
  expect(fetchChat).toHaveBeenCalledTimes(1);
  expect(store.getSnapshot().conversations.get("a:small")).toMatchObject({
    prompt: "A draft",
    temperature: 1.2,
    maxTokens: 128,
    turns: [{ prompt: "A question", response: "Answer", state: "completed" }],
  });
  await store.send("a:small", true, settled);
  expect(JSON.parse(String(fetchChat.mock.calls[1][1]?.body)).messages).toEqual([
    { role: "user", content: "A question" },
    { role: "assistant", content: "Answer" },
    { role: "user", content: "A draft" },
  ]);
  expect(store.getSnapshot().conversations.get("b:small")?.prompt).toBe("B draft");
});

it("stops before headers synchronously and rejects late completion after a new request", async () => {
  let oldResponse!: (response: Response) => void;
  let nextResponse!: (response: Response) => void;
  const fetchChat = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          oldResponse = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          nextResponse = resolve;
        }),
    );
  const store = createOwnerConversations(fetchChat);
  store.select("a:small");
  store.edit("a:small", { prompt: "Old request" });
  const old = store.send("a:small", true, settled);
  store.stop("a:small");
  expect(fetchChat.mock.calls[0][1]?.signal?.aborted).toBe(true);
  expect(store.getSnapshot().conversations.get("a:small")).toMatchObject({
    busy: false,
    prompt: "Old request",
    turns: [{ state: "cancelled" }],
  });
  store.edit("a:small", { prompt: "Explicit retry" });
  const next = store.send("a:small", true, settled);
  oldResponse(answer("Late old answer"));
  await old;
  expect(store.getSnapshot().conversations.get("a:small")?.busy).toBe(true);
  expect(store.getSnapshot().conversations.get("a:small")?.turns[0].response).toBe("");
  nextResponse(answer("New answer"));
  await next;
  expect(store.getSnapshot().conversations.get("a:small")?.turns[1].response).toBe("New answer");
});

it("retains partial text and ignores late chunks after selection changes", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const fetchChat = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          stream = controller;
        },
      }),
    ),
  );
  const store = createOwnerConversations(fetchChat);
  const push = (content: string, done: boolean) =>
    stream.enqueue(new TextEncoder().encode(JSON.stringify({ content, done }) + "\n"));
  store.select("a:small");
  store.edit("a:small", { prompt: "A question" });
  const running = store.send("a:small", true, settled);
  push("Partial", false);
  await vi.waitFor(() =>
    expect(store.getSnapshot().conversations.get("a:small")?.turns[0].response).toBe("Partial"),
  );
  store.select("b:small");
  store.edit("b:small", { prompt: "B draft" });
  push("Late content", true);
  await running;
  expect(store.getSnapshot().conversations.get("a:small")).toMatchObject({
    prompt: "A question",
    busy: false,
    turns: [{ response: "Partial", state: "cancelled" }],
  });
  expect(store.getSnapshot().conversations.get("b:small")).toMatchObject({
    prompt: "B draft",
    turns: [],
  });
  store.select("a:small");
  expect(fetchChat).toHaveBeenCalledTimes(1);
});

it("keeps an already completed result when cancellation races stream cleanup", async () => {
  let release!: () => void;
  const fetchChat = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"content":"Completed","done":true}\n'));
        },
        cancel() {
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      }),
    ),
  );
  const store = createOwnerConversations(fetchChat);
  store.select("a:small");
  store.edit("a:small", { prompt: "Question" });
  const running = store.send("a:small", true, settled);
  await vi.waitFor(() =>
    expect(store.getSnapshot().conversations.get("a:small")?.turns[0].state).toBe("completed"),
  );
  store.stop("a:small");
  expect(store.getSnapshot().conversations.get("a:small")).toMatchObject({
    prompt: "",
    busy: false,
    turns: [{ response: "Completed", state: "completed" }],
  });
  release();
  await running;
});

it("clear affects only selected history and retains its draft and settings", async () => {
  const store = createOwnerConversations(async () => answer());
  for (const model of ["a:small", "b:small"]) {
    store.select(model);
    store.edit(model, { prompt: model });
    await store.send(model, true, settled);
  }
  store.edit("b:small", { prompt: "Keep draft", maxTokens: 256 });
  store.clear("a:small"); // A stale view must not clear a different selected model.
  store.clear("b:small");
  expect(store.getSnapshot().conversations.get("b:small")).toMatchObject({
    turns: [],
    prompt: "Keep draft",
    maxTokens: 256,
  });
  expect(store.getSnapshot().conversations.get("a:small")?.turns).toHaveLength(1);
});

it("rejects writes without selection and isolates store instances including prototype-like names", () => {
  const one = createOwnerConversations();
  const two = createOwnerConversations();
  one.edit("", { prompt: "No model" });
  one.edit("unselected", { prompt: "Wrong view" });
  expect(one.getSnapshot().conversations.size).toBe(0);
  one.select("__proto__");
  one.edit("__proto__", { prompt: "Kept safely" });
  expect(one.getSnapshot().conversations.get("__proto__")?.prompt).toBe("Kept safely");
  expect(two.getSnapshot().conversations.size).toBe(0);
  expect(one.getSnapshot()).toBe(one.getSnapshot());
});

it("drops only untouched empty sessions when browsing many models", () => {
  const store = createOwnerConversations();
  store.select("draft");
  store.edit("draft", { prompt: "Keep" });
  store.select("settings");
  store.edit("settings", { temperature: 1 });
  for (let i = 0; i < 100; i++) store.select(`empty:${i}`);
  expect([...store.getSnapshot().conversations.keys()]).toEqual(["draft", "settings", "empty:99"]);
});

it("shares the host retry wait across models and Clear without trusting the device date", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const fetchChat = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ detail: "Busy" }, { status: 429, headers: { "Retry-After": "10" } }),
    )
    .mockResolvedValue(answer());
  const store = createOwnerConversations(fetchChat);
  try {
    store.select("a:small");
    store.edit("a:small", { prompt: "Original prompt" });
    await store.send("a:small", true, settled);
    expect(store.getSnapshot().retryAt).toBe(11000);
    store.clear("a:small");
    store.edit("a:small", { prompt: "Edited prompt" });
    await store.send("a:small", true, settled);
    store.select("b:small");
    store.edit("b:small", { prompt: "B draft" });
    vi.spyOn(Date, "now").mockReturnValue(9_000_000_000_000);
    await store.send("b:small", true, settled);
    vi.spyOn(Date, "now").mockReturnValue(0);
    await store.send("b:small", true, settled);
    expect(fetchChat).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().conversations.get("b:small")?.prompt).toBe("B draft");
    now = 11000;
    await vi.advanceTimersByTimeAsync(10000);
    expect(store.getSnapshot().retryAt).toBe(0);
    expect(fetchChat).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await store.send("b:small", true, settled);
    expect(fetchChat).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().retryAt).toBeNull();
    expect(store.getSnapshot().conversations.get("a:small")?.prompt).toBe("Edited prompt");
  } finally {
    store.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

it("rechecks elapsed monotonic time and cancels the retry timer on close", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(performance, "now").mockReturnValue(0);
  const fetchChat = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json({ detail: "Busy" }, { status: 503, headers: { "Retry-After": "1" } }),
    );
  const store = createOwnerConversations(fetchChat);
  try {
    store.select("a:small");
    store.edit("a:small", { prompt: "Retain this" });
    await store.send("a:small", true, settled);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.getSnapshot().retryAt).toBe(1000);
    expect(vi.getTimerCount()).toBe(1);
    const listener = vi.fn();
    store.subscribe(listener);
    store.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(300000);
    expect(listener).not.toHaveBeenCalled();
    expect(fetchChat).toHaveBeenCalledTimes(1);
  } finally {
    store.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});
