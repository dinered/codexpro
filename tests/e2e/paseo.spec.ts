import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBridge } from "../../tools/chatgpt-bridge/bridge.ts";
import { BRIDGE_LOCK, fileName, isFresh, parseName, readRegular, tasksRoot } from "../../tools/paseo-plugin/server/protocol.ts";

const ROOT = join(homedir(), "work/ai/codexpro/2");
const BRIDGE = tasksRoot(join(ROOT, "sandbox"));
const FAKE = fileURLToPath(new URL("fake-chatgpt.html", import.meta.url));
const CHAT = "https://chatgpt.com/c/fake-test";

// Пока работает настоящий мост, сообщения e2e ушли бы в живой ChatGPT.
test.beforeAll(async () => {
  const lock = join(BRIDGE, BRIDGE_LOCK);
  if (await isFresh(lock)) {
    throw new Error(`работает мост (пульс в ${lock}): сообщения e2e ушли бы в живой ChatGPT — остановите его (Ctrl+C) и повторите`);
  }
});

// Пароль читаем из файла 0600 и нигде не печатаем.
function daemonPassword(): string {
  const m = readFileSync(join(ROOT, "sandbox-paseo/paseo.env"), "utf8").match(/^PASEO_PASSWORD=(.+)$/m);
  if (!m) throw new Error("PASEO_PASSWORD not found in paseo.env");
  return m[1].trim();
}

// task-<id>.md во всех папках сессий.
async function tasks() {
  const found: { dir: string; id: string; file: string }[] = [];
  for (const entry of await readdir(BRIDGE, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const dir = join(BRIDGE, entry.name);
    for (const name of await readdir(dir).catch(() => [])) {
      const parsed = parseName(name);
      if (parsed?.kind === "task") found.push({ dir, id: parsed.id, file: join(dir, name) });
    }
  }
  return found;
}

// Задача этого теста — по тексту: он у каждого прогона свой, остатки прошлых прогонов не мешают.
async function findTask(text: string) {
  for (const t of await tasks()) if ((await readRegular(t.file).catch(() => null)) === text) return t;
  return null;
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

test("агент ChatGPT (CodexPro): task-<id>.md -> reply-<id>.md -> ответ в чате", async ({ page }) => {
  const message = `Проверь e2e ${Date.now()}`;
  const reply = `Ответ из e2e ${Date.now()}`;

  await startAgent(page, message);
  await expect(page.getByText("Задача ждёт ChatGPT").first()).toBeVisible({ timeout: 60_000 });

  await expect.poll(() => findTask(message), { timeout: 30_000 }).not.toBeNull();
  const { dir, id } = (await findTask(message))!;
  await writeFile(join(dir, fileName("reply", id)), reply + "\n"); // как человек: обычной записью, не атомарной

  await expect(page.getByText(reply).first()).toBeVisible({ timeout: 30_000 });
});

test("мост: задача Paseo уходит в имитацию ChatGPT, ответ появляется в чате", async ({ page, context }) => {
  // мост берёт любую живую задачу корня: чужой ход получил бы ответ имитации
  const live: string[] = [];
  for (const t of await tasks()) if (await isFresh(t.file)) live.push(t.file);
  expect(live, "в .ai-bridge/paseo ждут ответа другие ходы — дождитесь их или отмените").toEqual([]);

  const chat = await context.newPage();
  await chat.route("**/*", (route) => (route.request().url().startsWith(CHAT) ? route.fulfill({ path: FAKE }) : route.abort()));
  await chat.goto(CHAT);
  const abort = new AbortController();
  const message = `Мост e2e ${Date.now()}`;

  // Promise.all: упал мост — тест падает сразу с его причиной, а не по таймауту ожидания в чате
  const [result] = await Promise.all([
    runBridge({ page: chat, root: BRIDGE, limit: 1, pollMs: 200, log: () => {}, signal: abort.signal }),
    (async () => {
      await startAgent(page, message);
      await expect(page.getByText("Задача ушла мосту в ChatGPT").first()).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(`Эхо: ${message}`).first()).toBeVisible({ timeout: 60_000 });
      abort.abort(); // мост с limit: 1 обычно уже вышел сам
    })(),
  ]);
  expect(result).toEqual({ sent: 1 });
});
