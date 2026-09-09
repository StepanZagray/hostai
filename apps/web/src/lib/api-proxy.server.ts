const MAX_BODY_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
// Give Java's ten-minute generation deadline time to deliver its terminal error.
const CHAT_TIMEOUT_MS = 610_000;

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
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

export async function proxy({ request }: { request: Request }) {
  const url = new URL(request.url);
  const isChat = url.pathname === "/api/chat";
  const isDownload = url.pathname === "/api/model-downloads";
  const isCancel =
    /^\/api\/model-downloads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/cancel$/i.test(
      url.pathname,
    );
  const isSharingRead = ["/api/sharing", "/api/directory", "/api/directory/listings"].includes(
    url.pathname,
  );
  const isSharingMutation =
    [
      "/api/sharing/start",
      "/api/sharing/stop",
      "/api/sharing/grants",
      "/api/sharing/internet/start",
      "/api/sharing/internet/stop",
      "/api/directory/start",
      "/api/directory/stop",
    ].includes(url.pathname) ||
    /^\/api\/sharing\/grants\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/revoke$/i.test(
      url.pathname,
    );
  const allowed =
    request.method === "GET"
      ? ["/api/status", "/api/models", "/api/requests"].includes(url.pathname) ||
        isDownload ||
        isSharingRead
      : request.method === "POST" && (isChat || isDownload || isCancel || isSharingMutation);
  if (!allowed) return Response.json({ detail: "Endpoint not found." }, { status: 404 });
  const isDirectory =
    url.pathname === "/api/directory" || url.pathname.startsWith("/api/directory/");
  if (request.method === "POST" || isDirectory) {
    const origin = request.headers.get("origin");
    const site = request.headers.get("sec-fetch-site");
    if (
      (origin && origin !== url.origin) ||
      (isDirectory
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
    timer = setTimeout(timeout, isChat ? CHAT_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
    const upstream = await fetch(
      new URL(url.pathname, process.env.HOSTAI_BACKEND_URL || "http://127.0.0.1:8080"),
      {
        method: request.method,
        body,
        signal: abort.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: isChat ? "application/x-ndjson" : "application/json",
        },
      },
    );
    const headers = new Headers({
      "Content-Type": upstream.headers.get("content-type") || "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Accel-Buffering": "no",
    });
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter) headers.set("Retry-After", retryAfter);
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
