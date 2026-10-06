import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 120_000,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:6790", headless: true, ...devices["Desktop Chrome"] },
  projects: [{ name: "paseo", testMatch: "paseo.spec.ts" }],
});
