import { createServer } from "node:http";
import { Readable } from "node:stream";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname, sep } from "node:path";
import handler from "./dist/server/server.js";

const root = fileURLToPath(new URL("./dist/client/", import.meta.url));
const port = Number(process.env.HOSTAI_UI_PORT || 3000);
const mime = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const server = createServer(async (req, res) => {
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  try {
    const host = req.headers.host || `127.0.0.1:${port}`;
    const url = new URL(req.url, `http://${host}`);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      res.writeHead(403);
      res.end("Local access only");
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    if (["GET", "HEAD"].includes(req.method)) {
      const file = resolve(root, `.${decodeURIComponent(url.pathname)}`);
      if (
        file.startsWith(root.endsWith(sep) ? root : root + sep) &&
        (await stat(file).catch(() => null))?.isFile()
      ) {
        res.setHeader("Content-Type", mime[extname(file)] || "application/octet-stream");
        res.setHeader(
          "Cache-Control",
          url.pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
        );
        res.end(req.method === "HEAD" ? undefined : await readFile(file));
        return;
      }
    }
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      signal: abort.signal,
      ...(!["GET", "HEAD"].includes(req.method)
        ? { body: Readable.toWeb(req), duplex: "half" }
        : {}),
    });
    const response = await handler.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body || req.method === "HEAD") {
      res.end();
      return;
    }
    const body = Readable.fromWeb(response.body);
    res.on("close", () => body.destroy());
    body.on("error", () => res.destroy());
    body.pipe(res);
  } catch (error) {
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("The workspace could not complete this request.");
    console.error(error);
  }
});
server.listen(port, "127.0.0.1", () => console.log(`HostAI workspace: http://127.0.0.1:${port}`));
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    server.close();
    server.closeAllConnections();
  });
