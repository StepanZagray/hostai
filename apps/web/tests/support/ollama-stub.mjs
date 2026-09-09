// Explicit test fixture. Never used by the application or its normal launcher.
import { createServer } from "node:http";
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/version") return res.end(JSON.stringify({ version: "test-stub" }));
  if (req.url === "/api/tags")
    return res.end(
      JSON.stringify({
        models: [
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
