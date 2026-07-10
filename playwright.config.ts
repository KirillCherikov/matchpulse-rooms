import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: {
    command:
      "SENTINEL_MODE=replay TELEGRAM_ENABLED=false PORT=3100 LOG_LEVEL=silent npm run build && SENTINEL_MODE=replay TELEGRAM_ENABLED=false PORT=3100 LOG_LEVEL=silent node dist/server.js",
    port: 3100,
    reuseExistingServer: false,
    timeout: 120_000
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
});
