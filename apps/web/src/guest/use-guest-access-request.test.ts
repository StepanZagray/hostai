import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as credentials from "./request-credential";
import { createGuestAccessRequest, secondsRemaining } from "./use-guest-access-request";

const id = "51e6b724-f7f7-4dd1-a74a-7140f86eaf3b";
const otherId = "61e6b724-f7f7-4dd1-a74a-7140f86eaf3b";
const credential = {
  requestSecret: "A".repeat(43),
  accessSecret: "B".repeat(42) + "A",
  accessCommitment: "c".repeat(64),
};
const hello = {
  version: 1,
  scope: "temporary-internet",
  requestsAccepted: true,
  intakeId: id,
  hostLabel: "Host",
  model: "model:small",
};
const pending = {
  version: 1,
  id,
  state: "pending",
  code: "ABC-123",
  name: "Guest",
  model: hello.model,
  channel: "internet",
  expiresInSeconds: 900,
  grantId: null,
  grantExpiresAt: null,
};
const approved = {
  ...pending,
  state: "approved",
  grantId: otherId,
  grantExpiresAt: "2026-01-01T00:00:00Z",
};
let documentFixture: EventTarget & { visibilityState: string };
let fetch: ReturnType<typeof vi.fn>;
const controllers: ReturnType<typeof createGuestAccessRequest>[] = [];
const flush = () => vi.advanceTimersByTimeAsync(0);
const paths = () => fetch.mock.calls.map(([path]) => path);
const posts = () => fetch.mock.calls.filter(([path]) => path === "/guest/v1/requests");
function make() {
  const controller = createGuestAccessRequest();
  controllers.push(controller);
  return controller;
}
async function start() {
  const controller = make();
  controller.setEnabled(true);
  await flush();
  return controller;
}
function hidden(value: boolean) {
  documentFixture.visibilityState = value ? "hidden" : "visible";
  documentFixture.dispatchEvent(new Event("visibilitychange"));
}
beforeEach(() => {
  vi.useFakeTimers();
  documentFixture = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("document", documentFixture);
  vi.stubGlobal("window", { location: { protocol: "https:" } });
  fetch = vi
    .fn()
    .mockImplementation((path: string) =>
      Promise.resolve(Response.json(path === "/guest/v1/hello" ? hello : pending)),
    );
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(credentials, "createRequestCredential").mockResolvedValue(credential);
});
afterEach(async () => {
  controllers.splice(0).forEach((controller) => controller.setEnabled(false));
  await flush();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("explicit access requests and memory", () => {
  it("only discovers when a key is needed and never submits on discovery or refresh", async () => {
    const controller = make();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).not.toHaveBeenCalled();
    controller.setEnabled(true);
    await flush();
    await controller.refresh();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(paths()).toEqual(["/guest/v1/hello", "/guest/v1/hello"]);
    expect(credentials.createRequestCredential).not.toHaveBeenCalled();
  });

  it("keeps credentials out of observable state and ambient browser credential channels", async () => {
    const forbidden = vi.fn(() => {
      throw new Error("Ambient credential access");
    });
    Object.defineProperty(documentFixture, "cookie", { get: forbidden, set: forbidden });
    vi.stubGlobal("localStorage", { getItem: forbidden, setItem: forbidden });
    vi.stubGlobal("sessionStorage", { getItem: forbidden, setItem: forbidden });
    Object.defineProperties(window.location, {
      hash: { get: forbidden },
      search: { get: forbidden },
      href: { get: forbidden },
    });
    const controller = await start();
    const snapshots: string[] = [];
    const unsubscribe = controller.subscribe(() =>
      snapshots.push(JSON.stringify(controller.getSnapshot())),
    );
    await controller.submit("Guest");
    unsubscribe();
    expect(forbidden).not.toHaveBeenCalled();
    for (const value of Object.values(credential)) expect(snapshots.join(" ")).not.toContain(value);
    expect(JSON.stringify(posts())).not.toContain(credential.accessSecret);
    expect(posts()).toHaveLength(1);
  });

  it("retries a lost POST response with exactly the same immutable body and bearer", async () => {
    const controller = await start();
    fetch.mockRejectedValueOnce(new Error("provider-private-secret"));
    await controller.submit(" Guest ");
    expect(controller.getSnapshot().recovery).toBe("submit");
    expect(controller.getSnapshot().error).not.toContain("provider-private-secret");
    await controller.submit("Someone else");
    await controller.retrySubmit();
    expect(posts()).toHaveLength(2);
    expect(posts()[0][1].body).toBe(posts()[1][1].body);
    expect(posts()[0][1].headers.Authorization).toBe(posts()[1][1].headers.Authorization);
    expect(credentials.createRequestCredential).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().request?.name).toBe("Guest");
  });

  it("blocks duplicate clicks while cryptography is pending and ignores its result after cleanup", async () => {
    let resolve!: (value: credentials.RequestCredential) => void;
    vi.mocked(credentials.createRequestCredential).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const controller = await start();
    const first = controller.submit("Guest");
    await controller.submit("Duplicate");
    controller.setEnabled(false);
    resolve(credential);
    await first;
    expect(posts()).toHaveLength(0);
    expect(controller.getSnapshot().submission).toBeNull();
    expect(credentials.createRequestCredential).toHaveBeenCalledOnce();
  });

  it("requires explicit connection after approval and constructs the key locally", async () => {
    const controller = await start();
    await controller.submit("Guest");
    fetch.mockImplementation((path: string) =>
      Promise.resolve(Response.json(path === "/guest/v1/hello" ? hello : approved)),
    );
    const onConnect = vi.fn();
    await controller.check();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onConnect).not.toHaveBeenCalled();
    expect(controller.getSnapshot().request?.state).toBe("approved");
    // Host-reported wall clock dates cannot gate connection: the session API authenticates the key.
    await controller.connect(onConnect);
    expect(onConnect).toHaveBeenCalledExactlyOnceWith(`hga1.${otherId}.${credential.accessSecret}`);
    expect(controller.matchesKey(`hga1.${otherId}.${credential.accessSecret}`)).toBe(true);
    expect(controller.matchesKey(` hga1.${otherId}.${credential.accessSecret} `)).toBe(true);
    expect(controller.matchesKey("another-key")).toBe(false);
    controller.setEnabled(false);
    expect(paths()).not.toContain("/guest/v1/requests/self/cancel");
    expect(paths().some((path) => path.includes("chat") || path.includes("session"))).toBe(false);
  });
});

describe("polling, backoff and expiry", () => {
  it("polls every five seconds only while visible and never overlaps fetches", async () => {
    const controller = await start();
    await controller.submit("Guest");
    hidden(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(paths()).toHaveLength(2);
    hidden(false);
    await vi.advanceTimersByTimeAsync(4999);
    expect(paths()).toHaveLength(2);
    let resolve!: (response: Response) => void;
    fetch.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(paths()).toHaveLength(3);
    await controller.check();
    await controller.refresh();
    await controller.cancel();
    await vi.advanceTimersByTimeAsync(5000);
    expect(paths()).toHaveLength(3);
    resolve(Response.json(pending));
    await flush();
    expect(paths()).toHaveLength(3);
    hidden(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(paths()).toHaveLength(3);
  });

  it("pauses after poll errors, retains identity, and requires explicit recovery", async () => {
    const controller = await start();
    await controller.submit("Guest");
    fetch.mockRejectedValueOnce(new Error("Offline"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(controller.getSnapshot().recovery).toBe("poll");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(paths()).toHaveLength(3);
    await controller.check();
    expect(controller.getSnapshot().error).toBe("");
    expect(posts()).toHaveLength(1);
    expect(credentials.createRequestCredential).toHaveBeenCalledOnce();
  });

  it("enforces 429 backoff on every manual action, including cancellation", async () => {
    const controller = await start();
    fetch.mockResolvedValueOnce(
      new Response("provider error", { status: 429, headers: { "Retry-After": "20" } }),
    );
    await controller.submit("Guest");
    expect(controller.getSnapshot().retrySeconds).toBe(20);
    await controller.retrySubmit();
    await controller.refresh();
    await controller.cancel();
    expect(paths()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(19_999);
    await controller.retrySubmit();
    expect(paths()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await controller.retrySubmit();
    expect(posts()).toHaveLength(2);
    expect(posts()[0][1].body).toBe(posts()[1][1].body);
  });

  it("uses max monotonic/wall elapsed for expiry and does not resubmit on expiry or refresh", async () => {
    const controller = await start();
    fetch.mockResolvedValueOnce(Response.json({ ...pending, expiresInSeconds: 2 }));
    await controller.submit("Guest");
    const wall = Date.now();
    const monotonic = performance.now();
    vi.setSystemTime(wall - 100_000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(secondsRemaining({ seconds: 2, wall, monotonic })).toBe(0);
    expect(controller.getSnapshot().remainingSeconds).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await controller.refresh();
    expect(posts()).toHaveLength(1);
    expect(paths()).not.toContain("/guest/v1/requests/self");
    expect(controller.getSnapshot().request?.state).toBe("pending");
    expect(credentials.createRequestCredential).toHaveBeenCalledOnce();
    vi.setSystemTime(wall + 30_000);
    expect(secondsRemaining({ seconds: 40, wall, monotonic })).toBe(10);
  });

  it("does not extend a request countdown on repeated status responses", async () => {
    const controller = await start();
    await controller.submit("Guest");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(controller.getSnapshot().remainingSeconds).toBe(885);
  });

  it("preserves fractional elapsed time through rapid refreshes and never revives an expired timer", async () => {
    const controller = await start();
    fetch.mockImplementation((path: string) =>
      Promise.resolve(
        Response.json(path === "/guest/v1/hello" ? hello : { ...approved, expiresInSeconds: 2 }),
      ),
    );
    await controller.submit("Guest");
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(500);
      await controller.check();
    }
    expect(controller.getSnapshot().remainingSeconds).toBe(0);
    const onConnect = vi.fn();
    await controller.connect(onConnect);
    expect(onConnect).toHaveBeenCalledExactlyOnceWith(`hga1.${otherId}.${credential.accessSecret}`);
    const anchor = { seconds: 5, wall: Date.now(), monotonic: performance.now() };
    vi.setSystemTime(anchor.wall + 6000);
    expect(secondsRemaining(anchor)).toBe(0);
    vi.setSystemTime(anchor.wall);
    expect(secondsRemaining(anchor)).toBe(0);
  });
});

describe("intake changes, cancellation and stale async work", () => {
  it.each([404, 409, 410])(
    "stops on request status %s and requires discard before a fresh request",
    async (status) => {
      const controller = await start();
      await controller.submit("Guest");
      fetch.mockResolvedValueOnce(new Response(null, { status }));
      await vi.advanceTimersByTimeAsync(5000);
      expect(controller.getSnapshot().intakeStopped).toBe(true);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(paths()).toHaveLength(3);
      await controller.refresh();
      await controller.submit("Other");
      expect(posts()).toHaveLength(1);
      controller.discard(false);
      expect(controller.getSnapshot().submission).not.toBeNull();
      controller.discard(true);
      await flush();
      expect(controller.getSnapshot().submission).toBeNull();
      expect(posts()).toHaveLength(1);
      await controller.submit("Guest");
      expect(posts()).toHaveLength(2);
    },
  );

  it("recovers the last-slot approval independently of anonymous discovery availability", async () => {
    const controller = await start();
    fetch.mockRejectedValueOnce(new Error("Lost submission response"));
    await controller.submit("Guest");
    fetch.mockImplementation((path: string) =>
      Promise.resolve(
        path === "/guest/v1/hello" ? new Response(null, { status: 429 }) : Response.json(approved),
      ),
    );
    await controller.retrySubmit();
    expect(controller.getSnapshot().request?.state).toBe("approved");
    expect(paths().filter((path) => path === "/guest/v1/hello")).toHaveLength(1);
    await controller.refresh();
    expect(controller.getSnapshot().retrySeconds).toBeGreaterThan(0);
    const onConnect = vi.fn();
    await controller.connect(onConnect);
    expect(onConnect).toHaveBeenCalledExactlyOnceWith(`hga1.${otherId}.${credential.accessSecret}`);
    expect(posts()).toHaveLength(2);
  });

  it("continues polling a known request when the host stops accepting new requests", async () => {
    const controller = await start();
    await controller.submit("Guest");
    fetch.mockResolvedValueOnce(
      Response.json({
        ...hello,
        requestsAccepted: false,
        intakeId: null,
        model: null,
        hostLabel: null,
      }),
    );
    await controller.refresh();
    expect(controller.getSnapshot().intakeStopped).toBe(false);
    fetch.mockResolvedValueOnce(Response.json(approved));
    await controller.check();
    const onConnect = vi.fn();
    await controller.connect(onConnect);
    expect(onConnect).toHaveBeenCalledOnce();
  });

  it("allows explicit discovery after an old server starts accepting requests", async () => {
    fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const controller = await start();
    expect(controller.getSnapshot().details).toBe("error");
    await controller.refresh();
    await controller.submit("Guest");
    expect(posts()).toHaveLength(1);
  });

  it("keeps requests unavailable without cryptography and never generates credentials", async () => {
    vi.stubGlobal("crypto", { getRandomValues: vi.fn() });
    const controller = await start();
    await controller.submit("Guest");
    expect(controller.getSnapshot().details).toBe("unsupported");
    expect(fetch).not.toHaveBeenCalled();
    expect(credentials.createRequestCredential).not.toHaveBeenCalled();
  });

  it("rejects changed response identity and never exposes an approved key from it", async () => {
    const controller = await start();
    await controller.submit("Guest");
    fetch.mockImplementation((path: string) =>
      Promise.resolve(
        Response.json(path === "/guest/v1/hello" ? hello : { ...approved, id: otherId }),
      ),
    );
    await controller.check();
    expect(controller.getSnapshot().request?.state).toBe("pending");
    expect(controller.getSnapshot().recovery).toBe("poll");
    const onConnect = vi.fn();
    await controller.connect(onConnect);
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("handles the approval/cancel race and retries a lost cancellation with the same bearer", async () => {
    const controller = await start();
    await controller.submit("Guest");
    fetch.mockRejectedValueOnce(new Error("Lost cancel response"));
    await controller.cancel();
    expect(controller.getSnapshot().request?.state).toBe("pending");
    expect(controller.getSnapshot().recovery).toBe("cancel");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(paths()).toHaveLength(3);
    // A response that still says approved is not confirmation of cancellation.
    fetch.mockResolvedValueOnce(Response.json(approved));
    await controller.cancel();
    expect(controller.getSnapshot().request?.state).toBe("approved");
    expect(controller.getSnapshot().recovery).toBe("cancel");
    const onConnect = vi.fn();
    await controller.connect(onConnect);
    expect(onConnect).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(Response.json({ ...approved, state: "revoked" }));
    await controller.cancel();
    expect(controller.getSnapshot().request?.state).toBe("revoked");
    const cancellations = fetch.mock.calls.filter(([path]) => path.endsWith("/cancel"));
    expect(cancellations).toHaveLength(3);
    expect(new Set(cancellations.map(([, init]) => init.headers.Authorization)).size).toBe(1);
    expect(cancellations.every(([, init]) => init.body === "{}")).toBe(true);
  });

  it("aborts in-flight work on cleanup and ignores stale responses after reactivation", async () => {
    let resolve!: (response: Response) => void;
    fetch.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const controller = make();
    controller.setEnabled(true);
    controller.setEnabled(false);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    controller.setEnabled(true);
    await flush();
    expect(controller.getSnapshot().hello?.model).toBe(hello.model);
    resolve(Response.json({ ...hello, model: "stale" }));
    await flush();
    expect(controller.getSnapshot().hello?.model).toBe(hello.model);
    expect(paths()).not.toContain("/guest/v1/requests/self/cancel");
  });

  it("lets a bounded submission finish while hidden without resubmitting", async () => {
    const controller = await start();
    let resolve!: (response: Response) => void;
    fetch.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const attempt = controller.submit("Guest");
    await flush();
    hidden(true);
    expect(posts()[0][1].signal.aborted).toBe(false);
    resolve(Response.json(approved));
    await attempt;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(controller.getSnapshot().request?.state).toBe("approved");
    expect(controller.getSnapshot().recovery).toBeNull();
    hidden(false);
    await flush();
    expect(posts()).toHaveLength(1);
    expect(credentials.createRequestCredential).toHaveBeenCalledOnce();
  });

  it("lets cancellation finish while hidden and preserves the confirmed outcome", async () => {
    const controller = await start();
    await controller.submit("Guest");
    let resolve!: (response: Response) => void;
    fetch.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const attempt = controller.cancel();
    await flush();
    hidden(true);
    const call = fetch.mock.calls.at(-1)!;
    expect(call[1].signal.aborted).toBe(false);
    resolve(Response.json({ ...pending, state: "cancelled" }));
    await attempt;
    hidden(false);
    expect(controller.getSnapshot().request?.state).toBe("cancelled");
    expect(controller.getSnapshot().recovery).toBeNull();
    expect(paths().filter((path) => path.endsWith("/cancel"))).toHaveLength(1);
  });

  it("a hidden stalled cancellation still times out and requires explicit retry", async () => {
    const controller = await start();
    await controller.submit("Guest");
    fetch.mockImplementationOnce(() => new Promise(() => {}));
    const attempt = controller.cancel();
    hidden(true);
    await vi.advanceTimersByTimeAsync(10_001);
    await attempt;
    expect(controller.getSnapshot().busy).toBeNull();
    expect(controller.getSnapshot().recovery).toBe("cancel");
    hidden(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(paths().filter((path) => path.endsWith("/cancel"))).toHaveLength(1);
  });

  it("ignores a stale approval after a later cancellation has been confirmed", async () => {
    const controller = await start();
    await controller.submit("Guest");
    let resolve!: (response: Response) => void;
    fetch.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const checking = controller.check();
    await flush();
    hidden(true);
    await checking;
    hidden(false);
    fetch.mockResolvedValueOnce(Response.json({ ...pending, state: "cancelled" }));
    await controller.cancel();
    resolve(Response.json(approved));
    await flush();
    expect(controller.getSnapshot().request?.state).toBe("cancelled");
    const onConnect = vi.fn();
    await controller.connect(onConnect);
    expect(onConnect).not.toHaveBeenCalled();
  });
});

describe("request name drafts", () => {
  it("retains editable drafts through failed/closed details, disabling discovery and a changed model", async () => {
    const controller = await start();
    controller.editName("Before refresh");
    fetch.mockRejectedValueOnce(new Error("offline"));
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({
      nameDraft: "Before refresh",
      details: "error",
      hello: null,
    });
    controller.editName("");
    expect(controller.getSnapshot().nameDraft).toBe("");
    controller.editName("Retained name");
    await controller.submit("Retained name");
    expect(posts()).toHaveLength(0);
    fetch.mockResolvedValueOnce(
      Response.json({
        ...hello,
        requestsAccepted: false,
        intakeId: null,
        model: null,
        hostLabel: null,
      }),
    );
    await controller.refresh();
    expect(controller.getSnapshot().nameDraft).toBe("Retained name");
    controller.setEnabled(false);
    controller.setEnabled(true);
    fetch.mockResolvedValueOnce(
      Response.json({ ...hello, model: "another:small", intakeId: otherId }),
    );
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({
      nameDraft: "Retained name",
      hello: { model: "another:small" },
    });
    expect(posts()).toHaveLength(0);
    expect(credentials.createRequestCredential).not.toHaveBeenCalled();
    expect(make().getSnapshot().nameDraft).toBeNull();
  });
  it("freezes a submitted name for retries, clears the editable draft and starts empty after discard", async () => {
    const controller = await start();
    controller.editName("  Guest  ");
    fetch.mockRejectedValueOnce(new Error("lost reply"));
    await controller.submit(controller.getSnapshot().nameDraft!);
    expect(controller.getSnapshot()).toMatchObject({
      nameDraft: null,
      submission: { name: "Guest", model: hello.model },
    });
    controller.editName("Changed after submit");
    await controller.retrySubmit();
    expect(posts()).toHaveLength(2);
    expect(posts()[1][1].body).toBe(posts()[0][1].body);
    expect(JSON.parse(posts()[1][1].body).name).toBe("Guest");
    expect(credentials.createRequestCredential).toHaveBeenCalledTimes(1);
    controller.discard(true);
    await flush();
    expect(controller.getSnapshot().nameDraft).toBeNull();
    controller.editName("x".repeat(41));
    expect(controller.getSnapshot().nameDraft).toBeNull();
  });
});

it("rejects unsupported names before creating credentials while allowing supported names", async () => {
  const controller = await start();
  for (const name of ["Anna 🌸", "Guest\u200bName", "Guest\nName", "Guest\u0378Name", "\ud800"]) {
    controller.editName(name);
    await controller.submit(name);
    expect(controller.getSnapshot().nameDraft).toBe(name);
  }
  expect(credentials.createRequestCredential).not.toHaveBeenCalled();
  expect(posts()).toHaveLength(0);
  fetch.mockResolvedValueOnce(Response.json({ ...pending, name: "Ána 李" }));
  controller.editName("Ána 李");
  await controller.submit("Ána 李");
  expect(posts()).toHaveLength(1);
  expect(controller.getSnapshot().submission?.name).toBe("Ána 李");
});

it("restores the first 400 rejection for editing but preserves credentials when a retry gets 400", async () => {
  const controller = await start();
  controller.editName("Guest");
  fetch.mockResolvedValueOnce(Response.json({}, { status: 400 }));
  await controller.submit("Guest");
  expect(controller.getSnapshot()).toMatchObject({
    nameDraft: "Guest",
    submission: null,
    recovery: null,
    hello: null,
    details: "error",
  });
  await controller.submit("Guest");
  expect(posts()).toHaveLength(1);
  await controller.refresh();
  fetch.mockRejectedValueOnce(new Error("lost response"));
  await controller.submit("Guest");
  fetch.mockResolvedValueOnce(Response.json({}, { status: 400 }));
  await controller.retrySubmit();
  expect(controller.getSnapshot()).toMatchObject({
    nameDraft: null,
    submission: { name: "Guest" },
    recovery: "submit",
  });
  expect(posts()[2][1].body).toBe(posts()[1][1].body);
});
