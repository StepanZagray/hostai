import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  approvedAccessKey,
  createRequestCredential,
  type RequestCredential,
} from "./request-credential";
import {
  isRequestTerminal,
  parseAccessRequest,
  parseRequestHello,
  RequestApiError,
  requestJson,
  type AccessRequest,
  type RequestBody,
  type RequestHello,
} from "./request-api";

type Operation = "details" | "submit" | "poll" | "cancel" | "connect";
type Recovery = "submit" | "poll" | "cancel" | null;
type RelativeDeadline = { seconds: number; wall: number; monotonic: number; elapsed?: number };
const deadline = (seconds: number): RelativeDeadline => ({
  seconds,
  wall: Date.now(),
  monotonic: performance.now(),
});

export function secondsRemaining(value: RelativeDeadline): number {
  // Retain the greatest observed elapsed time, including across wall-clock corrections.
  value.elapsed = Math.max(
    value.elapsed ?? 0,
    Date.now() - value.wall,
    performance.now() - value.monotonic,
  );
  return Math.max(0, value.seconds - Math.floor(value.elapsed / 1000));
}

export interface GuestRequestView {
  details: "idle" | "ready" | "unavailable" | "error" | "unsupported";
  hello: RequestHello | null;
  submission: { name: string; model: string } | null;
  request: AccessRequest | null;
  busy: Operation | null;
  error: string;
  recovery: Recovery;
  intakeStopped: boolean;
  remainingSeconds: number | null;
  retrySeconds: number;
}

const initialView = (): GuestRequestView => ({
  details: "idle",
  hello: null,
  submission: null,
  request: null,
  busy: null,
  error: "",
  recovery: null,
  intakeStopped: false,
  remainingSeconds: null,
  retrySeconds: 0,
});

/** One controller per hook/ref. Only the metadata snapshot is exposed to React. */
export function createGuestAccessRequest() {
  let view = initialView();
  let enabled = false;
  let current: {
    credential: Readonly<RequestCredential>;
    body: Readonly<RequestBody>;
    ttl: RelativeDeadline | null;
  } | null = null;
  let active: { controller: AbortController; kind: Operation } | null = null;
  let backoff: RelativeDeadline | null = null;
  let polling: ReturnType<typeof setTimeout> | undefined;
  let ticking: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<GuestRequestView>) => {
    view = { ...view, ...patch };
    for (const listener of listeners) listener();
  };
  const visible = () => typeof document !== "undefined" && document.visibilityState === "visible";
  const clearPoll = () => {
    clearTimeout(polling);
    polling = undefined;
  };
  const remaining = () => (current?.ttl ? secondsRemaining(current.ttl) : null);
  const retry = () => (backoff ? secondsRemaining(backoff) : 0);
  const tick = () => {
    const remainingSeconds = remaining();
    const retrySeconds = retry();
    if (remainingSeconds === 0) clearPoll();
    if (remainingSeconds !== view.remainingSeconds || retrySeconds !== view.retrySeconds)
      publish({ remainingSeconds, retrySeconds });
  };
  const canPoll = () =>
    enabled &&
    visible() &&
    !active &&
    !!current &&
    view.request?.state === "pending" &&
    !view.error &&
    !view.intakeStopped &&
    !view.recovery &&
    remaining() !== 0 &&
    retry() === 0;
  const schedule = () => {
    clearPoll();
    if (canPoll())
      polling = setTimeout(() => {
        polling = undefined;
        if (canPoll()) void check();
      }, 5000);
  };
  const begin = (kind: Operation) => {
    if (!enabled || active || (kind !== "connect" && retry() > 0)) return null;
    clearPoll();
    const operation = { controller: new AbortController(), kind };
    active = operation;
    publish({ busy: kind, error: "" });
    return operation;
  };
  const live = (operation: NonNullable<typeof active>) =>
    active === operation && enabled && !operation.controller.signal.aborted;
  const finish = (operation: NonNullable<typeof active>) => {
    if (active !== operation) return;
    active = null;
    publish({ busy: null });
    tick();
    schedule();
  };
  const fail = (error: unknown, recovery: Recovery) => {
    const problem = error instanceof RequestApiError ? error : new RequestApiError();
    if (problem.retrySeconds) backoff = deadline(problem.retrySeconds);
    publish({
      error:
        recovery === "cancel" && [404, 409, 410].includes(problem.status)
          ? view.request?.grantId
            ? "This request cannot currently be cancelled on this connection. Its key may still be valid. Ask the host to revoke it in Access keys."
            : "Cancellation could not be confirmed. Ask the host to check this request and revoke any key it issued."
          : problem.message,
      recovery,
      intakeStopped: view.intakeStopped || (!!current && [404, 409, 410].includes(problem.status)),
      ...([404, 409, 410].includes(problem.status) ? { hello: null } : {}),
      retrySeconds: retry(),
    });
  };
  const stop = () => {
    clearPoll();
    const operation = active;
    active = null;
    operation?.controller.abort();
    if (operation)
      publish({
        busy: null,
        ...((operation.kind === "submit" || operation.kind === "cancel") && current
          ? {
              recovery: operation.kind,
              error:
                "The response was interrupted. Retry the same action to confirm what happened.",
            }
          : {}),
      });
  };

  async function readDetails(signal: AbortSignal, operation: NonNullable<typeof active>) {
    const hello = parseRequestHello(await requestJson("/guest/v1/hello", signal));
    if (!live(operation)) return false;
    if (!hello) throw new RequestApiError();
    const changed =
      !!current &&
      hello.requestsAccepted &&
      (hello.intakeId !== current.body.intakeId || hello.model !== current.body.model);
    publish({
      hello,
      details: hello.requestsAccepted ? "ready" : "unavailable",
      intakeStopped: view.intakeStopped || changed,
      ...(changed
        ? {
            error:
              "The host changed or closed access requests. Automatic checks have stopped. Cancel this request, or review the discard warning before starting another.",
          }
        : {}),
    });
    return hello.requestsAccepted && !view.intakeStopped;
  }

  async function refresh() {
    if (
      typeof window === "undefined" ||
      window.location.protocol !== "https:" ||
      typeof crypto === "undefined" ||
      typeof crypto.getRandomValues !== "function" ||
      !crypto.subtle?.digest
    ) {
      publish({ details: "unsupported", hello: null });
      return;
    }
    const operation = begin("details");
    if (!operation) return;
    try {
      await readDetails(operation.controller.signal, operation);
    } catch (error) {
      if (live(operation)) {
        publish({ details: "error", hello: null });
        fail(error, view.recovery);
      }
    } finally {
      finish(operation);
    }
  }

  function accept(value: unknown) {
    if (!current) throw new RequestApiError();
    const request = parseAccessRequest(value, current.body, view.request);
    if (!request) throw new RequestApiError();
    // Refreshes cannot extend the local countdown for the same state. Approval starts a new TTL.
    if (
      view.request?.state !== request.state ||
      !current.ttl ||
      request.expiresInSeconds < secondsRemaining(current.ttl)
    ) {
      current.ttl = deadline(request.expiresInSeconds);
    }
    // Preserve the original anchor when shortening is unnecessary, including its fractional second.
    publish({ request, remainingSeconds: remaining(), recovery: null, error: "" });
  }

  async function submit(name: string) {
    const hello = view.hello;
    if (
      current ||
      !hello?.requestsAccepted ||
      view.details !== "ready" ||
      view.intakeStopped ||
      !name.trim() ||
      name.trim().length > 40
    )
      return;
    const operation = begin("submit");
    if (!operation) return;
    try {
      // Generation is only reached from an explicit submission; a retry never reaches it.
      const credential = Object.freeze(await createRequestCredential());
      if (!live(operation)) return;
      const body = Object.freeze({
        intakeId: hello.intakeId,
        name: name.trim(),
        model: hello.model,
        accessCommitment: credential.accessCommitment,
      });
      current = { credential, body, ttl: null };
      publish({ submission: { name: body.name, model: body.model }, recovery: "submit" });
      const result = await requestJson(
        "/guest/v1/requests",
        operation.controller.signal,
        credential.requestSecret,
        body,
      );
      if (live(operation)) accept(result);
    } catch (error) {
      if (live(operation)) {
        if (current) fail(error, "submit");
        else
          publish({
            details: "unsupported",
            hello: null,
            error:
              "This browser could not create a secure request. You can still connect with an existing key.",
          });
      }
    } finally {
      finish(operation);
    }
  }

  async function retrySubmit() {
    if (!current || view.request || view.recovery !== "submit" || view.intakeStopped) return;
    const operation = begin("submit");
    if (!operation) return;
    try {
      const result = await requestJson(
        "/guest/v1/requests",
        operation.controller.signal,
        current.credential.requestSecret,
        current.body,
      );
      if (live(operation)) accept(result);
    } catch (error) {
      if (live(operation)) fail(error, "submit");
    } finally {
      finish(operation);
    }
  }

  async function check() {
    if (
      !current ||
      !view.request ||
      view.recovery === "cancel" ||
      view.intakeStopped ||
      isRequestTerminal(view.request.state)
    )
      return;
    const operation = begin("poll");
    if (!operation) return;
    try {
      const result = await requestJson(
        "/guest/v1/requests/self",
        operation.controller.signal,
        current.credential.requestSecret,
      );
      if (live(operation)) accept(result);
    } catch (error) {
      if (live(operation)) fail(error, "poll");
    } finally {
      finish(operation);
    }
  }

  async function cancel() {
    if (!current || (view.request && isRequestTerminal(view.request.state))) return;
    const operation = begin("cancel");
    if (!operation) return;
    publish({ recovery: "cancel" });
    try {
      const result = await requestJson(
        "/guest/v1/requests/self/cancel",
        operation.controller.signal,
        current.credential.requestSecret,
        {},
      );
      if (!live(operation)) return;
      accept(result);
      if (view.request && !isRequestTerminal(view.request.state))
        publish({
          recovery: "cancel",
          error:
            "Cancellation is not confirmed. Retry cancellation; approved access must be revoked by the host.",
        });
    } catch (error) {
      if (live(operation)) fail(error, "cancel");
    } finally {
      finish(operation);
    }
  }

  function discard(confirmed: boolean) {
    if (
      !current ||
      active ||
      (!confirmed && (!view.request || !isRequestTerminal(view.request.state)))
    )
      return;
    clearPoll();
    current = null;
    publish({ ...initialView(), retrySeconds: retry() });
    // Fetching new details is explicit and separate from creating the next request.
    void refresh();
  }

  async function connect(onConnect: (key: string) => void | Promise<void>) {
    if (
      !current ||
      view.request?.state !== "approved" ||
      !view.request.grantId ||
      view.recovery === "cancel"
    )
      return;
    // The request record's TTL and intake availability do not define the durable key's
    // lifetime. Explicit connection authenticates it through the existing guest session API.
    const operation = begin("connect");
    if (!operation) return;
    try {
      await onConnect(approvedAccessKey(view.request.grantId, current.credential.accessSecret));
    } catch {
      if (live(operation))
        publish({ error: "Could not connect. Check request status, then connect again." });
    } finally {
      finish(operation);
    }
  }

  const visibilityChanged = () => {
    if (!visible()) {
      clearPoll();
      // Let bounded explicit mutations finish when a mobile tab is backgrounded.
      if (active?.kind === "poll" || active?.kind === "details") stop();
    } else {
      tick();
      if (view.details === "idle" && !view.hello && !current) void refresh();
      else schedule();
    }
  };
  function setEnabled(next: boolean) {
    if (enabled === next) return;
    enabled = next;
    if (next) {
      document.addEventListener("visibilitychange", visibilityChanged);
      ticking = setInterval(tick, 1000);
      tick();
      if (view.details === "idle" && !current) void refresh();
      else if (
        view.request?.state === "approved" &&
        !view.intakeStopped &&
        view.recovery !== "cancel"
      )
        void check();
      else schedule();
    } else {
      document.removeEventListener("visibilitychange", visibilityChanged);
      clearInterval(ticking);
      ticking = undefined;
      // Closing, hiding, or connecting never sends cancellation.
      stop();
    }
  }

  return {
    getSnapshot: () => view,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setEnabled,
    refresh,
    submit,
    retrySubmit,
    check,
    cancel,
    discard,
    connect,
    matchesKey: (key: string) => {
      try {
        return (
          !!current &&
          !!view.request?.grantId &&
          key.trim() === approvedAccessKey(view.request.grantId, current.credential.accessSecret)
        );
      } catch {
        return false;
      }
    },
  };
}

export function useGuestAccessRequest(enabled: boolean) {
  const controller = useRef<ReturnType<typeof createGuestAccessRequest> | null>(null);
  if (!controller.current) controller.current = createGuestAccessRequest();
  const request = controller.current;
  const state = useSyncExternalStore(request.subscribe, request.getSnapshot, request.getSnapshot);
  const active = enabled || !!state.submission;
  useEffect(() => {
    request.setEnabled(active);
    return () => request.setEnabled(false);
  }, [active, request]);
  return { state, request };
}
