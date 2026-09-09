import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/",
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: "dist/directory",
    emptyOutDir: true,
    assetsDir: "assets",
    assetsInlineLimit: 0,
    sourcemap: false,
    rollupOptions: { input: fileURLToPath(new URL("directory.html", import.meta.url)) },
  },
});
