// Explicit test fixture. Never used by the application or its normal launcher.
import { createServer } from "node:http";
const installed = new Set();
const attempts = new Map();
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/version") return res.end(JSON.stringify({ version: "test-stub" }));
  if (req.url === "/api/tags")
    return res.end(
      JSON.stringify({
        models: [
          ...[...installed].map((name) => ({ name, size: 100000000 })),
          { name: "test-remote:cloud", size: 0 },
          {
            name: "test-model:small",
            size: 800000000,
            modified_at: "2026-09-09T12:00:00Z",
            details: { parameter_size: "0.6B", quantization_level: "Q4_K_M" },
          },
        ],
      }),
    );
  if (req.url === "/api/pull" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { model } = JSON.parse(body);
    // Only this fixture tag can be pulled. No network or model files are involved.
    if (model !== "fixture-download:small") {
      res.writeHead(400);
      return res.end("{}");
    }
    const attempt = (attempts.get(model) || 0) + 1;
    attempts.set(model, attempt);
    res.setHeader("Content-Type", "application/x-ndjson");
    res.write(
      JSON.stringify({
        status: "pulling layer",
        digest: "sha256:fixture",
        total: 100000000,
        completed: 25000000,
      }) + "\n",
    );
    const timer = setTimeout(
      () => {
        installed.add(model);
        res.end('{"status":"verifying sha256 digest"}\n{"status":"success"}\n');
      },
      attempt === 1 ? 30000 : 2500,
    );
    res.on("close", () => clearTimeout(timer));
    return;
  }
  if (req.url === "/api/chat") {
    for await (const _chunk of req) {
      /* Drain request; fixture never logs prompts. */
    }
    res.setHeader("Content-Type", "application/x-ndjson");
    res.write(
      JSON.stringify({
        message: { content: "Hello from the isolated test runtime. " },
        done: false,
      }) + "\n",
    );
    const timer = setTimeout(
      () =>
        res.end(
          JSON.stringify({ message: { content: "Stream complete." }, done: true, eval_count: 12 }) +
            "\n",
        ),
      1500,
    );
    res.on("close", () => clearTimeout(timer));
    return;
  }
  res.writeHead(404);
  res.end("{}");
});
server.listen(11435, "127.0.0.1", () => console.log("Test-only Ollama stub on 127.0.0.1:11435"));
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    server.close();
    server.closeAllConnections();
  });
