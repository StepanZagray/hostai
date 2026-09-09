// One public generation per socket. Credentials travel in the first encrypted message,
// never in a URL or subprotocol. Browser WebSocket handshakes reject redirects.
const MAX_REQUEST_BYTES = 262_144;
const MAX_FRAME_BYTES = 1_048_576;
const encoder = new TextEncoder();

export function guestSocket(key: string, body: string, signal: AbortSignal): Promise<Response> {
  if (signal.aborted) return Promise.reject(new DOMException("Operation aborted", "AbortError"));
  if (!key.length || key.length > 256 || encoder.encode(body).byteLength > MAX_REQUEST_BYTES)
    return Promise.reject(new Error("Invalid client request."));
  let envelope: string;
  try {
    envelope = JSON.stringify({ key, request: JSON.parse(body) });
    if (encoder.encode(envelope).byteLength > MAX_REQUEST_BYTES + 1024)
      throw new Error("Invalid client request.");
  } catch {
    return Promise.reject(new Error("Invalid client request."));
  }
  const url = new URL("/guest/v1/chat-stream", window.location.href);
  url.protocol = "wss:";

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let started = false;
    let closed = false;
    let output: ReadableStreamDefaultController<Uint8Array>;
    let progress: ReturnType<typeof setTimeout>;
    let overall: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearTimeout(progress);
      clearTimeout(overall);
      signal.removeEventListener("abort", abort);
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try {
        socket.close();
      } catch {
        /* A failed handshake is already closed. */
      }
    };
    const fail = () => {
      if (closed) return;
      const error = new Error("The public response ended before completion.");
      if (started) output.error(error);
      else reject(error);
      cleanup();
    };
    const abort = () => {
      if (closed) return;
      const error = new DOMException("Operation aborted", "AbortError");
      if (started) output.error(error);
      else reject(error);
      cleanup();
    };
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          output = controller;
        },
        cancel() {
          cleanup();
        },
      },
      {
        highWaterMark: MAX_FRAME_BYTES,
        size(chunk) {
          return chunk.byteLength;
        },
      },
    );
    progress = setTimeout(fail, 10_000);
    overall = setTimeout(fail, 615_000);
    signal.addEventListener("abort", abort, { once: true });
    socket.onopen = () => {
      if (closed || signal.aborted) {
        abort();
        return;
      }
      clearTimeout(progress);
      progress = setTimeout(fail, 70_000);
      try {
        socket.send(envelope);
        envelope = "";
      } catch {
        fail();
      }
    };
    socket.onmessage = (event) => {
      if (closed) return;
      if (typeof event.data !== "string" || event.data.length > MAX_FRAME_BYTES) {
        fail();
        return;
      }
      const bytes = encoder.encode(event.data + "\n");
      if (bytes.byteLength > MAX_FRAME_BYTES) {
        fail();
        return;
      }
      let packet: Record<string, unknown>;
      try {
        packet = JSON.parse(event.data);
      } catch {
        fail();
        return;
      }
      if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
        fail();
        return;
      }
      if (packet.type === "error") {
        if (
          started ||
          ![400, 401, 403, 408, 409, 413, 429, 500, 502, 503, 504].includes(packet.status as number)
        ) {
          fail();
          return;
        }
        const headers = new Headers();
        if (
          packet.status === 429 &&
          Number.isSafeInteger(packet.retryAfter) &&
          (packet.retryAfter as number) >= 1 &&
          (packet.retryAfter as number) <= 3600
        )
          headers.set("Retry-After", String(packet.retryAfter));
        resolve(new Response(null, { status: packet.status as number, headers }));
        cleanup();
        return;
      }
      if ((output.desiredSize ?? 0) < bytes.byteLength) {
        fail();
        return;
      }
      if (!started) {
        started = true;
        resolve(new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } }));
      }
      output.enqueue(bytes);
      clearTimeout(progress);
      progress = setTimeout(fail, 70_000);
      if (packet.done === true) {
        output.close();
        cleanup();
      }
    };
    socket.onerror = fail;
    socket.onclose = fail;
    if (signal.aborted) abort();
  });
}
