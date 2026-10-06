import { expect, test, type Page } from "@playwright/test";
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runBridge } from "../../tools/chatgpt-bridge/bridge.ts";

const ROOT = join(homedir(), "work/ai/codexpro/2");
const BRIDGE = join(ROOT, "sandbox/.ai-bridge/paseo");

// Пароль читаем из файла 0600 и нигде не печатаем.
function daemonPassword(): string {
  const m = readFileSync(join(ROOT, "sandbox-paseo/paseo.env"), "utf8").match(/^PASEO_PASSWORD=(.+)$/m);
  if (!m) throw new Error("PASEO_PASSWORD not found in paseo.env");
  return m[1].trim();
}

// Папки сессий предыдущих прогонов остаются; берём ту, где task.md новее начала теста.
function newestTaskDir(since: number): string | null {
  if (!existsSync(BRIDGE)) return null;
  const dirs = readdirSync(BRIDGE)
    .map((d) => join(BRIDGE, d))
    .filter((d) => existsSync(join(d, "task.md")))
    .map((d) => ({ d, t: statSync(join(d, "task.md")).mtimeMs }))
    .filter((x) => x.t >= since)
    .sort((a, b) => b.t - a.t);
  return dirs[0]?.d ?? null;
}

// Подключиться к демону и создать агента codexpro/chatgpt с первым сообщением.
async function startAgent(page: Page, message: string) {
  await page.goto("/");
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("direct-host-input").fill("127.0.0.1");
  await page.getByTestId("direct-port-input").fill("6790");
  await page.getByTestId("direct-password-input").fill(daemonPassword());
  await page.getByTestId("direct-host-submit").click();

  await page.getByTestId("sidebar-global-new-workspace").click();
  await expect(page.getByTestId("new-workspace-project-picker-trigger")).toContainText("workspace");

  await page.getByTestId("combined-model-selector").click();
  await page.getByTestId("model-provider-codexpro").click();
  await page.getByText("chatgpt", { exact: false }).last().click();
  await expect(page.getByTestId("combined-model-selector")).not.toContainText("Select model");

  await page.getByPlaceholder("Message the agent").fill(message);
  await page.getByTestId("workspace-create-submit").click();
}

test("агент ChatGPT (CodexPro): задача -> reply.md -> ответ в чате", async ({ page }) => {
  const started = Date.now() - 1000;
  const reply = `Ответ из e2e ${Date.now()}`;

  await startAgent(page, "Проверь e2e");
  await expect(page.getByText("Задача ждёт ChatGPT").first()).toBeVisible({ timeout: 60_000 });

  let dir: string | null = null;
  await expect.poll(() => (dir = newestTaskDir(started)), { timeout: 30_000 }).not.toBeNull();
  writeFileSync(join(dir!, "reply.md"), reply + "\n");

  await expect(page.getByText(reply).first()).toBeVisible({ timeout: 30_000 });
});

test("мост: задача Paseo уходит в имитацию ChatGPT, ответ появляется в чате", async ({ page, context }) => {
  const chat = await context.newPage();
  await chat.goto(new URL("fake-chatgpt.html", import.meta.url).href);
  const message = `Мост e2e ${Date.now()}`;
  const bridge = runBridge({ page: chat, root: BRIDGE, limit: 1, pollMs: 200, log: () => {} });

  await startAgent(page, message);

  await expect(page.getByText(`Эхо: ${message}`).first()).toBeVisible({ timeout: 60_000 });
  await bridge;
});
