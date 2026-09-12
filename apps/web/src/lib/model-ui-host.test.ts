import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CANCELLED_MESSAGE,
  createModelUiHost,
  inferFailureDetail,
  inferFailureMessage,
  modelUiAssetPath,
  type ModelUiHostOptions,
} from "./model-ui-host";

function setup(overrides: Partial<ModelUiHostOptions> = {}) {
  const postMessage = vi.fn();
  const frame = { contentWindow: { postMessage } };
  const target = new EventTarget();
  const infer = vi.fn<ModelUiHostOptions["infer"]>();
  const host = createModelUiHost({
    frame,
    model: "pebby:latest",
    scope: "owner",
    theme: "light",
    infer,
    target,
    ...overrides,
  });
  const send = (data: unknown, source: unknown = frame.contentWindow) =>
    target.dispatchEvent(Object.assign(new Event("message"), { data, source }));
  const posted = () => postMessage.mock.calls.map(([message]) => message);
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { host, frame, target, infer, send, posted, postMessage, flush };
}

function ndjson(...lines: string[]) {
  return new Response(lines.join("\n") + "\n", {
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

const hosts: { dispose(): void }[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose();
});

describe("model UI host bridge", () => {
  it("answers ready with hello and every postMessage targets any origin", () => {
    const { host, send, postMessage } = setup();
    hosts.push(host);
    send({ hostai: 1, type: "ready" });
    expect(postMessage).toHaveBeenCalledExactlyOnceWith(
      { hostai: 1, type: "hello", model: "pebby:latest", theme: "light", scope: "owner" },
      "*",
    );
  });
  it("ignores messages from other sources or without the protocol marker", () => {
    const { host, send, postMessage } = setup();
    hosts.push(host);
    send({ hostai: 1, type: "ready" }, { postMessage: vi.fn() });
    send({ hostai: 1, type: "ready" }, null);
    send({ type: "ready" });
    send({ hostai: 2, type: "ready" });
    send("ready");
    send(null);
    expect(postMessage).not.toHaveBeenCalled();
  });
  it("streams events then done for a successful inference", async () => {
    const { host, send, posted, infer, flush } = setup();
    hosts.push(host);
    infer.mockResolvedValue(
      ndjson('{"event":{"pong":1},"done":false}', '{"event":null,"done":false}', '{"done":true}'),
    );
    send({ hostai: 1, type: "infer", id: "r1", input: { ping: 1 } });
    expect(host.inFlight).toBe(1);
    expect(infer).toHaveBeenCalledOnce();
    expect(infer.mock.calls[0][0]).toEqual({ ping: 1 });
    expect(infer.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    await flush();
    expect(posted()).toEqual([
      { hostai: 1, type: "event", id: "r1", event: { pong: 1 } },
      { hostai: 1, type: "event", id: "r1", event: null },
      { hostai: 1, type: "done", id: "r1" },
    ]);
    expect(host.inFlight).toBe(0);
  });
  it("includes an event carried by the terminal record", async () => {
    const { host, send, posted, infer, flush } = setup();
    hosts.push(host);
    infer.mockResolvedValue(ndjson('{"event":"final","done":true}'));
    send({ hostai: 1, type: "infer", id: "r1", input: 1 });
    await flush();
    expect(posted()).toEqual([
      { hostai: 1, type: "event", id: "r1", event: "final" },
      { hostai: 1, type: "done", id: "r1" },
    ]);
  });
  it("maps HTTP failures to fixed messages and never echoes the body", async () => {
    const { host, send, posted, infer, flush } = setup();
    hosts.push(host);
    infer.mockResolvedValue(
      Response.json(
        { detail: "secret upstream text" },
        { status: 429, headers: { "Retry-After": "7" } },
      ),
    );
    send({ hostai: 1, type: "infer", id: "r1", input: {} });
    await flush();
    expect(posted()).toEqual([
      { hostai: 1, type: "error", id: "r1", error: "The host is busy. Try again in 7 seconds." },
    ]);
    expect(JSON.stringify(posted())).not.toContain("secret");
    expect(host.inFlight).toBe(0);
  });
  it.each([
    [400, "The runtime rejected this request."],
    [403, "Access to this model was denied."],
    [404, "This model is not available."],
    [413, "The request is too large."],
    [429, "The host is busy. Try again shortly."],
    [502, "The model runtime is unavailable. Try again shortly."],
    [500, "Inference failed."],
  ])("describes status %i without server text", (status, message) => {
    expect(inferFailureMessage(new Response("raw body", { status }))).toBe(message);
  });
  it("forwards a bounded 400 problem detail to owners only", async () => {
    const problem = (detail: unknown) =>
      new Response(JSON.stringify({ status: 400, detail }), {
        status: 400,
        headers: { "content-type": "application/problem+json" },
      });
    await expect(
      inferFailureDetail(problem("board must be an 8x8 matrix."), "owner"),
    ).resolves.toBe("board must be an 8x8 matrix.");
    await expect(inferFailureDetail(problem("bad\u0007\u0000text"), "owner")).resolves.toBe(
      "bad  text",
    );
    await expect(inferFailureDetail(problem("secret detail"), "guest")).resolves.toBe(
      "The runtime rejected this request.",
    );
    await expect(inferFailureDetail(problem(42), "owner")).resolves.toBe(
      "The runtime rejected this request.",
    );
    await expect(
      inferFailureDetail(new Response("plain text", { status: 400 }), "owner"),
    ).resolves.toBe("The runtime rejected this request.");
    await expect(
      inferFailureDetail(
        new Response("{}", {
          status: 403,
          headers: { "content-type": "application/problem+json" },
        }),
        "owner",
      ),
    ).resolves.toBe("Access to this model was denied.");
  });
  it("reports terminal stream errors and invalid streams", async () => {
    const { host, send, posted, infer, flush } = setup();
    hosts.push(host);
    infer
      .mockResolvedValueOnce(
        ndjson('{"event":1,"done":false}', '{"done":true,"error":"Board\\u0007 is full."}'),
      )
      .mockResolvedValueOnce(new Response("not json\n"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    send({ hostai: 1, type: "infer", id: "a", input: {} });
    send({ hostai: 1, type: "infer", id: "b", input: {} });
    send({ hostai: 1, type: "infer", id: "c", input: {} });
    await flush();
    // Concurrent runs settle in transport order; compare by id.
    const byId = (message: { id: string }) => message.id;
    expect(posted().sort((a, b) => byId(a).localeCompare(byId(b)))).toEqual([
      { hostai: 1, type: "event", id: "a", event: 1 },
      { hostai: 1, type: "error", id: "a", error: "Board  is full." },
      { hostai: 1, type: "error", id: "b", error: "The model returned an invalid stream." },
      {
        hostai: 1,
        type: "error",
        id: "c",
        error: "The host is unreachable. Check the connection and try again.",
      },
    ]);
  });
  it("cancels by aborting upstream and reporting Cancelled once", async () => {
    const { host, send, posted, infer, flush } = setup();
    hosts.push(host);
    let signal: AbortSignal | undefined;
    infer.mockImplementation(
      (_input, s) =>
        new Promise((_resolve, reject) => {
          signal = s;
          s.addEventListener("abort", () => reject(s.reason), { once: true });
        }),
    );
    send({ hostai: 1, type: "infer", id: "r1", input: {} });
    send({ hostai: 1, type: "cancel", id: "r1" });
    expect(signal?.aborted).toBe(true);
    expect(host.inFlight).toBe(0);
    await flush();
    expect(posted()).toEqual([{ hostai: 1, type: "error", id: "r1", error: CANCELLED_MESSAGE }]);
    send({ hostai: 1, type: "cancel", id: "r1" });
    send({ hostai: 1, type: "cancel", id: "unknown" });
    expect(posted()).toHaveLength(1);
  });
  it("limits in-flight inferences to four and rejects duplicate ids", async () => {
    const { host, send, posted, infer, flush } = setup();
    hosts.push(host);
    const pending: ((response: Response) => void)[] = [];
    infer.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    for (const id of ["a", "b", "c", "d"]) send({ hostai: 1, type: "infer", id, input: {} });
    send({ hostai: 1, type: "infer", id: "e", input: {} });
    send({ hostai: 1, type: "infer", id: "a", input: {} });
    expect(infer).toHaveBeenCalledTimes(4);
    expect(host.inFlight).toBe(4);
    expect(posted()).toEqual([
      {
        hostai: 1,
        type: "error",
        id: "e",
        error: "At most 4 inferences can run at once. Wait for one to finish.",
      },
      { hostai: 1, type: "error", id: "a", error: "This request id is already in use." },
    ]);
    pending[0]!(ndjson('{"done":true}'));
    await flush();
    expect(host.inFlight).toBe(3);
    send({ hostai: 1, type: "infer", id: "e", input: {} });
    expect(infer).toHaveBeenCalledTimes(5);
  });
  it("ignores malformed ids and infer without a usable id", () => {
    const { host, send, posted, infer } = setup();
    hosts.push(host);
    send({ hostai: 1, type: "infer", id: "", input: {} });
    send({ hostai: 1, type: "infer", id: "x".repeat(65), input: {} });
    send({ hostai: 1, type: "infer", id: 7, input: {} });
    send({ hostai: 1, type: "infer", input: {} });
    expect(infer).not.toHaveBeenCalled();
    expect(posted()).toEqual([]);
  });
  it("posts theme changes and uses the latest theme in later hellos", () => {
    const { host, send, posted } = setup();
    hosts.push(host);
    host.setTheme("dark");
    host.setTheme("purple" as never);
    send({ hostai: 1, type: "ready" });
    expect(posted()).toEqual([
      { hostai: 1, type: "theme", theme: "dark" },
      { hostai: 1, type: "hello", model: "pebby:latest", theme: "dark", scope: "owner" },
    ]);
  });
  it("dispose aborts running inferences silently and stops listening", async () => {
    const { host, send, posted, infer, flush } = setup();
    let signal: AbortSignal | undefined;
    infer.mockImplementation(
      (_input, s) =>
        new Promise((_resolve, reject) => {
          signal = s;
          s.addEventListener("abort", () => reject(s.reason), { once: true });
        }),
    );
    send({ hostai: 1, type: "infer", id: "r1", input: {} });
    host.dispose();
    host.dispose();
    expect(signal?.aborted).toBe(true);
    await flush();
    send({ hostai: 1, type: "ready" });
    host.setTheme("dark");
    expect(posted()).toEqual([]);
    expect(host.inFlight).toBe(0);
  });
  it("does nothing when the frame has no window", () => {
    const { host, send, frame, posted } = setup();
    hosts.push(host);
    const window = frame.contentWindow;
    (frame as { contentWindow: unknown }).contentWindow = null;
    send({ hostai: 1, type: "ready" }, window);
    expect(posted()).toEqual([]);
  });
});

describe("model UI asset paths", () => {
  it("builds owner and guest routes with every segment encoded", () => {
    expect(modelUiAssetPath("/api/model-ui", { runtime: "pebby", entry: "ui/index.html" })).toBe(
      "/api/model-ui/pebby/ui/index.html",
    );
    expect(modelUiAssetPath("/guest/v1/model-ui", { runtime: "a-b", entry: "a b/x?y.html" })).toBe(
      "/guest/v1/model-ui/a-b/a%20b/x%3Fy.html",
    );
  });
});
