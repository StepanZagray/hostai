import { createFileRoute } from "@tanstack/react-router";
import { proxy } from "../lib/api-proxy.server";

export const Route = createFileRoute("/api/$")({
  server: { handlers: { GET: proxy, POST: proxy } },
});
