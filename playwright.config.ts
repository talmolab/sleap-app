import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  webServer: {
    command: "bun run dev",
    port: 5173,
    reuseExistingServer: true,
  },
  use: {
    baseURL: "http://localhost:5173",
    // Use the system Google Chrome ("chrome" channel) rather than Playwright's
    // downloaded chromium — the CI/dev browser download is fragile here, and the
    // app only needs a Chromium engine to exercise. Falls back naturally if a
    // future runner installs the bundled browser.
    channel: "chrome",
  },
});
