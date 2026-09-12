const MAX_BODY_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
// Give Java's ten-minute generation deadline time to deliver its terminal error.
const CHAT_TIMEOUT_MS = 610_000;
const MODEL_UI_PREFIX = "/api/model-ui/";
const MODEL_UI_RUNTIME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MODEL_UI_SEGMENT = /^[A-Za-z0-9._-]+$/;
const MODEL_UI_MAX_SEGMENTS = 8;

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function modelUiPolicy(origin: string): string {
  return (
    `default-src 'none'; script-src 'self' ${origin}; ` +
    `style-src 'self' 'unsafe-inline' ${origin}; img-src 'self' data: blob: ${origin}; ` +
    `font-src 'self' ${origin}; connect-src 'none'; base-uri 'none'; form-action 'none'; ` +
    `frame-ancestors 'self' ${origin}`
  );
}

// Checked on the raw pathname: percent-encoded characters never match the segment class.
function isModelUiPath(pathname: string): boolean {
  if (!pathname.startsWith(MODEL_UI_PREFIX)) return false;
  const [runtime, ...segments] = pathname.slice(MODEL_UI_PREFIX.length).split("/");
  if (!MODEL_UI_RUNTIME.test(runtime)) return false;
  if (segments.length < 1 || segments.length > MODEL_UI_MAX_SEGMENTS) return false;
  return segments.every(
    (segment) => MODEL_UI_SEGMENT.test(segment) && segment !== "." && segment !== "..",
  );
}

async function readBody(request: Request, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_BODY_BYTES) {
    throw new RequestError(413, "Request is too large.");
  }
  signal.throwIfAborted();
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  // Releasing rejects a pending read without destroying the incoming HTTP socket.
  // The server adapter closes an unread upload after sending the error response.
  const interrupt = () => reader.releaseLock();
  signal.addEventListener("abort", interrupt, { once: true });
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        throw new RequestError(413, "Request is too large.");
      }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } finally {
    signal.removeEventListener("abort", interrupt);
    reader.releaseLock();
  }
}

function relay(
  upstream: Response,
  headers: Headers,
  abort: AbortController,
  cleanup: () => void,
): Response {
  const reader = upstream.body?.getReader();
  if (!reader) {
    cleanup();
    return new Response(null, { status: upstream.status, headers });
  }
  const release = () => {
    cleanup();
    reader.releaseLock();
  };
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel() {
      abort.abort();
      try {
        await reader.cancel().catch(() => {});
      } finally {
        release();
      }
    },
  });
  return new Response(stream, { status: upstream.status, headers });
}

export async function proxy({ request }: { request: Request }) {
  const url = new URL(request.url);
  const isChat = url.pathname === "/api/chat";
  const isInfer = url.pathname === "/api/infer";
  const isStreaming = isChat || isInfer;
  const isModelUi = isModelUiPath(url.pathname);
  const isDownload = url.pathname === "/api/model-downloads";
  const isCancel =
    /^\/api\/model-downloads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/cancel$/i.test(
      url.pathname,
    );
  const isSharingRead = url.pathname === "/api/sharing";
  const isAccessRequestMutation =
    ["/api/sharing/requests/start", "/api/sharing/requests/stop"].includes(url.pathname) ||
    /^\/api\/sharing\/requests\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/(?:approve|reject)$/.test(
      url.pathname,
    );
  const isSharingMutation =
    [
      "/api/sharing/start",
      "/api/sharing/stop",
      "/api/sharing/grants",
      "/api/sharing/grants/cleanup",
      "/api/sharing/internet/start",
      "/api/sharing/internet/stop",
    ].includes(url.pathname) ||
    /^\/api\/sharing\/grants\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:revoke|key)$/i.test(
      url.pathname,
    );
  const allowed =
    request.method === "GET"
      ? ["/api/status", "/api/models", "/api/requests"].includes(url.pathname) ||
        isDownload ||
        isSharingRead ||
        isModelUi
      : request.method === "POST" &&
        (isStreaming || isDownload || isCancel || isSharingMutation || isAccessRequestMutation);
  if (!allowed) return Response.json({ detail: "Endpoint not found." }, { status: 404 });
  if (request.method === "POST") {
    const origin = request.headers.get("origin");
    const site = request.headers.get("sec-fetch-site");
    if (
      (origin && origin !== url.origin) ||
      (isAccessRequestMutation
        ? site !== null && !["same-origin", "none"].includes(site)
        : site === "cross-site")
    )
      return Response.json({ detail: "Cross-origin requests are not allowed." }, { status: 403 });
  }
  if (request.method === "POST") {
    if (
      request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !==
      "application/json"
    )
      return Response.json({ detail: "JSON is required." }, { status: 415 });
  }
  const abort = new AbortController();
  const onAbort = () => abort.abort(request.signal.reason);
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  let timedOut = false;
  const timeout = () => {
    timedOut = true;
    abort.abort();
  };
  let timer = setTimeout(timeout, REQUEST_TIMEOUT_MS);
  const cleanup = () => {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
  };
  try {
    abort.signal.throwIfAborted();
    const body = request.method === "POST" ? await readBody(request, abort.signal) : undefined;
    abort.signal.throwIfAborted();
    clearTimeout(timer);
    timer = setTimeout(timeout, isStreaming ? CHAT_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
    const upstream = await fetch(
      new URL(url.pathname, process.env.HOSTAI_BACKEND_URL || "http://127.0.0.1:8080"),
      {
        method: request.method,
        body,
        signal: abort.signal,
        headers: isModelUi
          ? { Accept: "*/*" }
          : {
              "Content-Type": "application/json",
              Accept: isStreaming ? "application/x-ndjson" : "application/json",
            },
      },
    );
    if (isModelUi) {
      return relay(
        upstream,
        new Headers({
          "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy": modelUiPolicy(url.origin),
        }),
        abort,
        cleanup,
      );
    }
    const headers = new Headers({
      "Content-Type": upstream.headers.get("content-type") || "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Accel-Buffering": "no",
    });
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter) headers.set("Retry-After", retryAfter);
    return relay(upstream, headers, abort, cleanup);
  } catch (error) {
    cleanup();
    if (error instanceof RequestError)
      return Response.json({ detail: error.message }, { status: error.status });
    if (timedOut)
      return Response.json(
        { detail: "The HostAI request timed out. Please try again." },
        { status: 504 },
      );
    return Response.json(
      { detail: "The HostAI backend is unavailable. Start the Java service, then reconnect." },
      { status: 503 },
    );
  }
}
