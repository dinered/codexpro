// Мост Paseo → ChatGPT (учебный, ai/codexpro#2 п. 6). Плагин codexpro-worker кладёт текст
// сообщения в <root>/<сессия>/task.md; мост вводит его в открытый чат ChatGPT, ждёт конца
// ответа и пишет текст ответа в reply.md рядом — плагин отдаёт его в чат Paseo.
import type { Page } from "playwright-core";
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Разметка ChatGPT на 2026-10-06. Поменяется — править здесь и в tests/e2e/fake-chatgpt.html.
export const SEL = {
  composer: '[data-composer-input] [contenteditable="true"]',
  assistant: '[data-conversation-role="assistant"]',
  answer: "[data-markdown-text-style]",
  stop: 'button[data-testid="stop-button"]',
};

export interface BridgeOptions {
  page: Page;
  root: string; // каталог .ai-bridge/paseo
  limit?: number; // сообщений за запуск
  ignoreExisting?: boolean; // задачи, лежавшие до запуска, — остатки прошлых прогонов, не отправлять
  pollMs?: number;
  startTimeoutMs?: number; // ChatGPT так и не начал отвечать: лимит, капча или вход слетел
  answerTimeoutMs?: number;
  log?: (line: string) => void;
}

interface Task {
  session: string;
  file: string;
  reply: string;
  key: string;
  mtime: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = (file: string) => stat(file).then(() => true, () => false);

export async function runBridge({
  page,
  root,
  limit = 500,
  ignoreExisting = true,
  pollMs = 1000,
  startTimeoutMs = 120_000,
  answerTimeoutMs = 600_000,
  log = console.log,
}: BridgeOptions) {
  const done = new Set<string>();
  if (ignoreExisting) {
    const old = await pending(root, done);
    for (const task of old) done.add(task.key);
    if (old.length) log(`пропускаю задачи, лежавшие до запуска моста: ${old.map((t) => t.session).join(", ")}`);
  }
  for (let sent = 0; sent < limit; ) {
    const [task] = await pending(root, done);
    if (!task) {
      await sleep(pollMs);
      continue;
    }
    done.add(task.key);
    const text = (await readFile(task.file, "utf8").catch(() => "")).trim();
    if (!text) continue;
    sent++;
    log(`${task.session}: отправляю в ChatGPT (${sent}/${limit})`);
    const answer = await ask(page, text, () => exists(task.file), { pollMs, startTimeoutMs, answerTimeoutMs });
    if (answer === null || !(await exists(task.file))) {
      log(`${task.session}: ход отменён в Paseo, ответ ChatGPT остановлен`);
      continue;
    }
    await writeFile(`${task.reply}.tmp`, answer);
    await rename(`${task.reply}.tmp`, task.reply); // плагин не увидит недописанный ответ
    log(`${task.session}: ответ отдан в Paseo`);
  }
  log(`лимит ${limit} сообщений за запуск — мост остановлен`);
}

// Задачи без ответа, старые первыми.
async function pending(root: string, done: Set<string>): Promise<Task[]> {
  const tasks: Task[] = [];
  for (const session of await readdir(root).catch(() => [])) {
    const file = join(root, session, "task.md");
    const reply = join(root, session, "reply.md");
    const mtime = await stat(file).then((s) => s.mtimeMs, () => 0);
    const key = `${session}:${mtime}`;
    if (mtime && !done.has(key) && !(await exists(reply))) tasks.push({ session, file, reply, key, mtime });
  }
  return tasks.sort((a, b) => a.mtime - b.mtime);
}

// Вводит текст в чат и ждёт конца ответа. null — задачу отменили (task.md удалён).
async function ask(
  page: Page,
  text: string,
  wanted: () => Promise<boolean>,
  { pollMs, startTimeoutMs, answerTimeoutMs }: { pollMs: number; startTimeoutMs: number; answerTimeoutMs: number },
): Promise<string | null> {
  const composer = page.locator(SEL.composer);
  if ((await composer.innerText()).trim()) throw new Error("в поле ввода ChatGPT уже есть текст — мост его не трогает");
  const turns = page.locator(SEL.assistant);
  const stop = page.locator(SEL.stop);
  const before = await turns.count();

  await composer.click();
  for (const [i, line] of text.split("\n").entries()) {
    if (i) await page.keyboard.press("Shift+Enter"); // голый Enter отправил бы раньше времени
    if (line) await page.keyboard.insertText(line);
  }
  await page.keyboard.press("Enter");

  const started = Date.now();
  let last = "";
  let stable = 0;
  for (;;) {
    await sleep(pollMs);
    const generating = await stop.isVisible();
    if (!(await wanted())) {
      if (generating) await stop.click({ timeout: 2000 }).catch(() => {});
      return null;
    }
    const elapsed = Date.now() - started;
    if ((await turns.count()) <= before) {
      if (elapsed > startTimeoutMs) throw new Error(`ChatGPT не начал отвечать за ${startTimeoutMs / 1000} с: лимит, капча или вход слетел?`);
      continue;
    }
    if (elapsed > answerTimeoutMs) throw new Error(`ChatGPT не закончил ответ за ${answerTimeoutMs / 1000} с`);
    const answer = (await turns.last().locator(SEL.answer).allInnerTexts()).join("\n\n").trim();
    // конец ответа: кнопки «Стоп» нет и текст не менялся два опроса подряд
    stable = !generating && answer && answer === last ? stable + 1 : 0;
    last = answer;
    if (stable >= 2) return answer;
  }
}
