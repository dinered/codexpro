import { defineConfig, devices } from "@playwright/test";

// #учебно-не-боевое-22 — тесты гоняют руками: в CI их нет (задание smoke печатает «smoke ok»), paseo требует контейнер
// на Маке оператора. В бою — все тесты в CI на каждый MR, обязательные для слияния (docs/training-vs-production.md).
export default defineConfig({
  testDir: ".",
  timeout: 120_000,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:6790", headless: true, ...devices["Desktop Chrome"] },
  projects: [
    { name: "paseo", testMatch: "paseo.spec.ts" }, // нужен контейнер paseo-sandbox
    { name: "bridge", testMatch: "bridge.spec.ts" }, // только имитация ChatGPT
  ],
});
