import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:3842",
  },
  webServer: {
    command: "pnpm dev --host 127.0.0.1 --port 3842",
    url: "http://127.0.0.1:3842",
    reuseExistingServer: true,
    stdout: "ignore",
    stderr: "pipe",
    timeout: 30000,
  },
});
