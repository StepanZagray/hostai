import { readInferStream, type InferRecord, type ModelUi } from "./api";

/**
 * Host side of the model-UI bridge (docs/model-ui.md). The frame runs with an
 * opaque origin, so messages travel with target "*" and are trusted only by
 * source identity: the host listens solely to its own frame's contentWindow.
 * Framework-free so the owner Playground and the guest page share it.
 */

export type ModelUiTheme = "light" | "dark";
export type ModelUiScope = "owner" | "guest";

/** The subset of an iframe the host needs; a plain object works in tests. */
export interface ModelUiFrameLike {
  contentWindow: { postMessage(message: unknown, targetOrigin: string): void } | null;
}

export interface ModelUiHostOptions {
  frame: ModelUiFrameLike;
  model: string;
  scope: ModelUiScope;
  theme: ModelUiTheme;
  /** Starts one inference. Owners post to /api/infer; guests use their channel. */
  infer: (input: unknown, signal: AbortSignal) => Promise<Response>;
  /** Where `message` events arrive. Defaults to `window`. */
  target?: EventTarget;
  /** Observes every accepted stream record, for diagnostics or history. */
  onRecord?: (id: string, record: InferRecord) => void;
}

export interface ModelUiHost {
  /** Number of inferences currently running for this frame. */
  readonly inFlight: number;
  setTheme(theme: ModelUiTheme): void;
  /** Aborts every inference and stops listening. Safe to call twice. */
  dispose(): void;
}

export const MAX_IN_FLIGHT = 4;

/**
 * Same-origin asset route for a runtime's entry page. `prefix` is the owner or
 * guest route base without a trailing slash. Segments are encoded even though
 * the gateway already validated them.
 */
export function modelUiAssetPath(prefix: string, ui: ModelUi): string {
  const entry = ui.entry.split("/").map(encodeURIComponent).join("/");
  return `${prefix}/${encodeURIComponent(ui.runtime)}/${entry}`;
}
export const CANCELLED_MESSAGE = "Cancelled.";

type HostMessage =
  | { type: "hello"; model: string; theme: ModelUiTheme; scope: ModelUiScope }
  | { type: "event"; id: string; event: unknown }
  | { type: "done"; id: string }
  | { type: "error"; id: string; error: string }
  | { type: "theme"; theme: ModelUiTheme };

interface Run {
  controller: AbortController;
  settled: boolean;
}

/** Fixed, user-facing text per HTTP status. Server bodies are never echoed. */
export function inferFailureMessage(response: Response): string {
  const { status } = response;
  if (status === 429) {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter && /^\d{1,6}$/.test(retryAfter.trim())) {
      const seconds = Math.max(1, Number(retryAfter.trim()));
      return `The host is busy. Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
    }
    return "The host is busy. Try again shortly.";
  }
  if (status === 400) return "The runtime rejected this request.";
  if (status === 401 || status === 403) return "Access to this model was denied.";
  if (status === 404) return "This model is not available.";
  if (status === 409) return "Inference is not available on this connection.";
  if (status === 413) return "The request is too large.";
  if (status === 415 || status === 422) return "The request was not accepted.";
  if (status === 502 || status === 503 || status === 504)
    return "The model runtime is unavailable. Try again shortly.";
  return "Inference failed.";
}

const MAX_PROBLEM_BYTES = 4096;

/**
 * Owners run the runtime themselves, so its own validation message (already bounded and
 * control-stripped by the gateway, delivered as a problem detail) is useful to them.
 * Guests never see server text: the fixed message stands, and the body is discarded.
 */
export async function inferFailureDetail(response: Response, scope: ModelUiScope): Promise<string> {
  const fixed = inferFailureMessage(response);
  const type = response.headers.get("content-type") ?? "";
  if (response.status !== 400 || scope !== "owner" || !/application\/problem\+json/i.test(type)) {
    await response.body?.cancel().catch(() => {});
    return fixed;
  }
  try {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_PROBLEM_BYTES) return fixed;
    const problem: unknown = JSON.parse(text);
    const detail =
      problem &&
      typeof problem === "object" &&
      typeof (problem as { detail?: unknown }).detail === "string"
        ? sanitizeStreamError((problem as { detail: string }).detail)
        : "";
    return detail && detail !== "Inference failed." ? detail : fixed;
  } catch {
    return fixed;
  }
}

/** Terminal-record errors come from the runtime; keep them short and printable. */
function sanitizeStreamError(message: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = message.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean ? clean.slice(0, 256) : "Inference failed.";
}

function isStreamError(error: unknown): error is Error {
  return error instanceof Error && error.name !== "AbortError";
}

export function createModelUiHost(options: ModelUiHostOptions): ModelUiHost {
  const { frame, model, scope, infer, onRecord } = options;
  const target: EventTarget = options.target ?? window;
  let theme = options.theme;
  let disposed = false;
  const runs = new Map<string, Run>();

  const post = (message: HostMessage) => {
    if (disposed) return;
    frame.contentWindow?.postMessage({ hostai: 1, ...message }, "*");
  };

  const finish = (id: string, run: Run) => {
    if (run.settled) return false;
    run.settled = true;
    runs.delete(id);
    return true;
  };

  const start = async (id: string, input: unknown) => {
    const run: Run = { controller: new AbortController(), settled: false };
    runs.set(id, run);
    try {
      const response = await infer(input, run.controller.signal);
      if (run.settled) {
        await response.body?.cancel().catch(() => {});
        return;
      }
      if (!response.ok) {
        const message = await inferFailureDetail(response, scope);
        if (finish(id, run)) post({ type: "error", id, error: message });
        return;
      }
      await readInferStream(response, (record) => {
        if (run.settled) return;
        onRecord?.(id, record);
        if ("event" in record) post({ type: "event", id, event: record.event });
      });
      if (finish(id, run)) post({ type: "done", id });
    } catch (error) {
      if (!finish(id, run)) return;
      if (run.controller.signal.aborted) {
        post({ type: "error", id, error: CANCELLED_MESSAGE });
        return;
      }
      const message =
        isStreamError(error) && !(error instanceof TypeError)
          ? sanitizeStreamError(error.message)
          : "The host is unreachable. Check the connection and try again.";
      post({ type: "error", id, error: message });
    }
  };

  const onMessage = (event: Event) => {
    if (disposed) return;
    const { source, data } = event as MessageEvent;
    if (!frame.contentWindow || source !== frame.contentWindow) return;
    if (!data || typeof data !== "object" || data.hostai !== 1 || typeof data.type !== "string")
      return;
    if (data.type === "ready") {
      post({ type: "hello", model, theme, scope });
      return;
    }
    if (data.type !== "infer" && data.type !== "cancel") return;
    const id: unknown = data.id;
    if (typeof id !== "string" || id.length < 1 || id.length > 64) return;
    if (data.type === "cancel") {
      const run = runs.get(id);
      if (!run) return;
      finish(id, run);
      run.controller.abort();
      post({ type: "error", id, error: CANCELLED_MESSAGE });
      return;
    }
    if (runs.has(id)) {
      post({ type: "error", id, error: "This request id is already in use." });
      return;
    }
    if (runs.size >= MAX_IN_FLIGHT) {
      post({
        type: "error",
        id,
        error: `At most ${MAX_IN_FLIGHT} inferences can run at once. Wait for one to finish.`,
      });
      return;
    }
    void start(id, "input" in data ? data.input : null);
  };

  target.addEventListener("message", onMessage);

  return {
    get inFlight() {
      return runs.size;
    },
    setTheme(next) {
      if (next !== "light" && next !== "dark") return;
      theme = next;
      post({ type: "theme", theme });
    },
    dispose() {
      if (disposed) return;
      target.removeEventListener("message", onMessage);
      for (const [id, run] of runs) {
        finish(id, run);
        run.controller.abort();
      }
      disposed = true;
    },
  };
}
