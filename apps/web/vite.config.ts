import { defineConfig } from "vite-plus";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Paired with the pinned Start compatibility patch in /patches (router#7614).
  plugins: [tanstackStart({ vite: { installDevServerMiddleware: true } }), react()],
  server: { host: "127.0.0.1", port: 3000, strictPort: true },
  preview: { host: "127.0.0.1" },
  test: { include: ["src/**/*.test.{ts,tsx}"] },
  lint: { ignorePatterns: ["styled-system/**", "src/routeTree.gen.ts", "dist/**"] },
  fmt: { ignorePatterns: ["styled-system/**", "src/routeTree.gen.ts", "dist/**"] },
});
