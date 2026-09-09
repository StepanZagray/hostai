import { defineConfig } from "@playwright/test";

// An explicit guard prevents accidentally running this suite on the live desktop.
if (
  process.env.HOSTAI_TEST_DISPLAY_PROVED !== "1" ||
  !process.env.WAYLAND_DISPLAY ||
  !process.env.XDG_RUNTIME_DIR?.startsWith("/tmp/hai-")
) {
  throw new Error(
    "UI tests require a separately verified, isolated Wayland display. See docs/verification.md.",
  );
}
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: process.env.HOSTAI_TEST_URL || "http://127.0.0.1:3000",
    headless: false,
    launchOptions: {
      executablePath: "/usr/bin/chromium",
      args: [
        "--ozone-platform=wayland",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--password-store=basic",
      ],
    },
    viewport: { width: 1440, height: 1100 },
    screenshot: "only-on-failure",
  },
});
