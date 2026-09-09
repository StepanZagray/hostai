import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";

// A separate static entry: no Start plugin, server bundle, or owner router.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/",
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: "dist/guest",
    // Vite empties only this outDir; dist/client and dist/server remain intact.
    emptyOutDir: true,
    assetsDir: "assets",
    assetsInlineLimit: 0,
    sourcemap: false,
    rollupOptions: {
      input: fileURLToPath(new URL("guest.html", import.meta.url)),
    },
  },
});
