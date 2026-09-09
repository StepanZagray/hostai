import { createFileRoute } from "@tanstack/react-router";

async function proxy({ request }: { request: Request }) {
  const url = new URL(request.url);
  const allowed =
    request.method === "GET" ? ["/api/status", "/api/models", "/api/requests"] : ["/api/chat"];
  if (!allowed.includes(url.pathname))
    return Response.json({ detail: "Endpoint not found." }, { status: 404 });
  if (request.method === "POST") {
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin)
      return Response.json({ detail: "Cross-origin requests are not allowed." }, { status: 403 });
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      return Response.json({ detail: "JSON is required." }, { status: 415 });
  }
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  request.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(onAbort, request.method === "GET" ? 10000 : 180000);
  const cleanup = () => {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
  };
  try {
    const body = request.method === "POST" ? await request.text() : undefined;
    if (body && body.length > 100000) {
      cleanup();
      return Response.json({ detail: "Request is too large." }, { status: 413 });
    }
    const upstream = await fetch(
      new URL(url.pathname, process.env.HOSTAI_BACKEND_URL || "http://127.0.0.1:8080"),
      {
        method: request.method,
        body,
        signal: abort.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: request.method === "POST" ? "application/x-ndjson" : "application/json",
        },
      },
    );
    const reader = upstream.body?.getReader();
    if (!reader) {
      cleanup();
      return new Response(null, { status: upstream.status });
    }
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            cleanup();
            controller.close();
          } else controller.enqueue(value);
        } catch (error) {
          cleanup();
          controller.error(error);
        }
      },
      async cancel() {
        abort.abort();
        cleanup();
        await reader.cancel().catch(() => {});
      },
    });
    return new Response(stream, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    cleanup();
    return Response.json(
      { detail: "The HostAI backend is unavailable. Start the Java service, then reconnect." },
      { status: 503 },
    );
  }
}

export const Route = createFileRoute("/api/$")({
  server: { handlers: { GET: proxy, POST: proxy } },
});
