import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FatalError, MAX_LIMIT, runBridge, SEL, type BridgeOptions } from "../../tools/chatgpt-bridge/bridge.ts";
import { sandboxVerdict } from "../../tools/chatgpt-bridge/preflight.ts";
import { BRIDGE_LOCK, fileName, isFresh, LEASE_MS, newTaskId, writeAtomic, type Kind } from "../../tools/paseo-plugin/server/protocol.ts";

// Мост против имитации ChatGPT: страница подставляется по адресу живого чата, в сеть ничего не уходит.
const FAKE = fileURLToPath(new URL("fake-chatgpt.html", import.meta.url));
const CHAT = "https://chatgpt.com/c/fake-test";
const fast = { pollMs: 50, pauseMs: 0, startTimeoutMs: 5_000, answerTimeoutMs: 20_000, log: () => {} };

async function openChat(page: Page, query = "") {
  await page.route("**/*", (route) => (route.request().url().startsWith(CHAT) ? route.fulfill({ path: FAKE }) : route.abort()));
  await page.goto(CHAT + query);
}

const sent = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).sent);
const sentAt = (page: Page): Promise<number[]> => page.evaluate(() => (window as any).sentAt);
const stopped = (page: Page): Promise<number> => page.evaluate(() => (window as any).stopped);
const read = (path: string) => readFile(path, "utf8");
const newRoot = () => mkdtemp(join(tmpdir(), "chatgpt-bridge-"));
const age = (path: string, ms: number) => utimes(path, new Date(Date.now() - ms), new Date(Date.now() - ms));

type Task = Record<Kind, string>; // пути task-, claim-, reply-, error- одного id

// Задача, как её кладёт плагин: task-<id>.md в папке сессии, mtime свежий.
async function task(root: string, session: string, text: string): Promise<Task> {
  const dir = join(root, session);
  const id = newTaskId();
  const path = (kind: Kind) => join(dir, fileName(kind, id));
  const t = { task: path("task"), claim: path("claim"), reply: path("reply"), error: path("error") };
  await mkdir(dir, { recursive: true });
  await writeAtomic(t.task, text);
  return t;
}

// Мост закончил с задачей: ответ или ошибка на месте, захват снят.
const handled = (t: Task) =>
  expect.poll(() => (existsSync(t.reply) || existsSync(t.error)) && !existsSync(t.claim), { timeout: 30_000 }).toBe(true);

// Мост в фоне; stop() — как Ctrl+C оператора: между задачами мост просто выходит.
function start(page: Page, root: string, options: Partial<BridgeOptions> = {}) {
  const abort = new AbortController();
  const run = runBridge({ page, root, ...fast, ...options, signal: abort.signal });
  run.catch(() => {}); // отказ проверяет сам тест
  return {
    run,
    stop: () => {
      abort.abort();
      return run;
    },
  };
}

// REPLY из fake-chatgpt.html в Markdown — так его собирает конвертер моста.
const reply = (text: string) =>
  [
    `Эхо: ${text.replaceAll("`", "").replace(/\s+/g, " ")}`,
    "### Итог",
    "- первый пункт\n  - вложенный пункт\n- второй с `кодом`",
    "9. девять\n   - под девятью\n10. десять\n    - под десятью", // продолжение пункта — на ширину маркера
    "```bash\necho привет\nls -la\n```",
    "| Ключ | Значение |\n| --- | --- |\n| a | 1 |",
    "> цитата",
    "---",
    "Ссылка: [пример](https://example.com/), **жирный** и _курсив_.",
  ].join("\n\n");

test("задача уходит в чат, ответ — Markdown в reply-<id>.md; после лимита захват и замок сняты", async ({ page }) => {
  await openChat(page, "?think=300");
  const root = await newRoot();
  const a = await task(root, "s1", "строка 1\nстрока `2`");
  const b = await task(root, "s2", "сверх лимита");
  const lines: string[] = [];

  expect(await runBridge({ page, root, ...fast, limit: 1, log: (line) => lines.push(line) })).toEqual({ sent: 1 });

  expect(await sent(page)).toEqual(["строка 1\nстрока `2`"]);
  expect((await read(a.reply)).trim()).toBe(reply("строка 1\nстрока `2`")); // и без «Думаю…»
  for (const path of [a.claim, b.claim, b.reply, b.error, join(root, BRIDGE_LOCK)]) expect(existsSync(path), path).toBe(false);
  expect(lines.join("\n")).not.toMatch(/строка|Эхо/); // ни задач, ни ответов в журнале
});

test("пауза между сообщениями: следующее уходит не раньше чем через pauseMs после предыдущего", async ({ page }) => {
  await openChat(page, "?ms=1"); // ответ короче паузы: без неё второе ушло бы раньше
  const root = await newRoot();
  const a = await task(root, "s1", "первое");
  const b = await task(root, "s2", "второе");

  const bridge = start(page, root, { pauseMs: 2_000 });
  await handled(a);
  await handled(b);
  expect(await bridge.stop()).toEqual({ sent: 2 });
  const [first, second] = await sentAt(page);
  expect(second - first).toBeGreaterThanOrEqual(2_000);
  expect(await read(b.reply)).toContain("Эхо: второе");
});

test(`лимит вне 1..${MAX_LIMIT} — мост не стартует при любом вызове ядра, а не только из CLI`, async ({ page }) => {
  await openChat(page);
  const root = await newRoot();
  const a = await task(root, "s1", "задача");

  for (const limit of [0, MAX_LIMIT + 1, 1.5, Number.NaN]) {
    expect(await runBridge({ page, root, ...fast, limit }).catch((e) => e), String(limit)).toBeInstanceOf(FatalError);
  }
  expect(await sent(page)).toEqual([]);
  for (const path of [a.claim, a.reply, a.error, join(root, BRIDGE_LOCK)]) expect(existsSync(path), path).toBe(false);
});

test("пауза посреди ответа со «Остановить» на экране ответ не обрезает", async ({ page }) => {
  await openChat(page, "?pause=2500");
  const root = await newRoot();
  const a = await task(root, "s1", "длинный ответ");

  const bridge = start(page, root);
  await handled(a);
  expect(await bridge.stop()).toEqual({ sent: 1 });
  expect((await read(a.reply)).trim()).toBe(reply("длинный ответ"));
});

test("«Стоп» в Paseo (task-<id>.md удалён) останавливает ответ ChatGPT, ответа нет", async ({ page }) => {
  await openChat(page, "?ms=100");
  const root = await newRoot();
  const a = await task(root, "s1", "долгая задача");

  const bridge = start(page, root);
  await expect(page.locator(SEL.answer)).toContainText("Эхо"); // ответ пошёл
  await rm(a.task);
  await expect.poll(() => existsSync(a.claim)).toBe(false); // мост бросил задачу
  expect(await bridge.stop()).toEqual({ sent: 1 });
  expect(await stopped(page)).toBe(1);
  for (const path of [a.reply, a.error]) expect(existsSync(path), path).toBe(false);
});

test("«Стоп» и сразу новое сообщение в той же сессии: ответа на A нет, B получает свой", async ({ page }) => {
  await openChat(page, "?ms=30");
  const root = await newRoot();
  const a = await task(root, "s1", "задача A");

  const bridge = start(page, root);
  await expect(page.locator(SEL.answer)).toContainText("Эхо");
  await rm(a.task); // плагин при «Стоп» удаляет все файлы id
  await rm(a.claim, { force: true });
  const b = await task(root, "s1", "задача B");
  await handled(b);
  expect(await bridge.stop()).toEqual({ sent: 2 });

  expect(await sent(page)).toEqual(["задача A", "задача B"]);
  expect(await stopped(page)).toBe(1);
  for (const path of [a.reply, a.error]) expect(existsSync(path), path).toBe(false);
  expect(await read(b.reply)).toContain("Эхо: задача B");
});

test("Ctrl+C посреди ответа: «Остановить» в ChatGPT и error-<id>.md «мост остановлен оператором»", async ({ page }) => {
  await openChat(page, "?ms=100");
  const root = await newRoot();
  const a = await task(root, "s1", "долгая задача");

  const bridge = start(page, root);
  await expect(page.locator(SEL.answer)).toContainText("Эхо");
  expect(await bridge.stop()).toEqual({ sent: 1 });

  expect(await stopped(page)).toBe(1);
  expect(await read(a.error)).toContain("мост остановлен оператором");
  for (const path of [a.reply, a.claim, join(root, BRIDGE_LOCK)]) expect(existsSync(path), path).toBe(false);
});

test("задача без пульса плагина (остаток мёртвого хода) не отправляется, живая — да", async ({ page }) => {
  await openChat(page);
  const root = await newRoot();
  const dead = await task(root, "s1", "мёртвая");
  await age(dead.task, LEASE_MS + 5_000);
  const live = await task(root, "s2", "живая");

  const bridge = start(page, root);
  await handled(live);
  expect(await bridge.stop()).toEqual({ sent: 1 });
  expect(await sent(page)).toEqual(["живая"]);
  for (const path of [dead.claim, dead.reply, dead.error]) expect(existsSync(path), path).toBe(false);
});

test("захват упавшего моста (без пульса): задача не отправляется повторно — error-<id>.md", async ({ page }) => {
  await openChat(page);
  const root = await newRoot();
  const orphan = await task(root, "s1", "отправлена упавшим мостом");
  await writeFile(orphan.claim, "упавший мост");
  await age(orphan.claim, LEASE_MS + 5_000);
  const next = await task(root, "s2", "следующая");

  const bridge = start(page, root);
  await handled(orphan);
  await handled(next);
  expect(await bridge.stop()).toEqual({ sent: 1 });
  expect(await sent(page)).toEqual(["следующая"]);
  expect(await read(orphan.error)).toContain("мост упал");
  expect(existsSync(orphan.reply)).toBe(false);
});

test("пульс плагина пропал после Enter (сон Мака), файл задачи на месте — ответ всё равно отдан", async ({ page }) => {
  await openChat(page, "?ms=50");
  const root = await newRoot();
  const a = await task(root, "s1", "задача во сне");

  const bridge = start(page, root);
  await expect(page.locator(SEL.answer)).toContainText("Эхо"); // Enter уже был
  await age(a.task, LEASE_MS + 5_000);
  await handled(a);
  expect(await bridge.stop()).toEqual({ sent: 1 });
  expect(await stopped(page)).toBe(0);
  expect(await read(a.reply)).toContain("Эхо: задача во сне");
});

test("задачу под живым чужим захватом мост не трогает", async ({ page }) => {
  await openChat(page);
  const root = await newRoot();
  const taken = await task(root, "s1", "занята");
  await writeFile(taken.claim, "другой исполнитель");
  const free = await task(root, "s2", "свободна");

  const bridge = start(page, root);
  await handled(free);
  expect(await bridge.stop()).toEqual({ sent: 1 });
  expect(await sent(page)).toEqual(["свободна"]);
  expect(await read(taken.claim)).toBe("другой исполнитель");
  for (const path of [taken.reply, taken.error]) expect(existsSync(path), path).toBe(false);
});

test("ссылки вместо файла задачи, папки сессии и корня мост не читает", async ({ page }) => {
  await openChat(page);
  const root = await newRoot();
  const outside = await mkdtemp(join(tmpdir(), "chatgpt-bridge-outside-"));
  await writeFile(join(outside, "secret"), "секрет");
  await mkdir(join(root, "s1"));
  const linkedTask = join(root, "s1", fileName("task", newTaskId()));
  await symlink(join(outside, "secret"), linkedTask);
  await writeAtomic(join(outside, fileName("task", newTaskId())), "задача за ссылкой на папку");
  await symlink(outside, join(root, "s2"));
  const real = await task(root, "s3", "настоящая");

  const bridge = start(page, root);
  await handled(real);
  expect(await bridge.stop()).toEqual({ sent: 1 });
  expect(await sent(page)).toEqual(["настоящая"]);
  expect(await readdir(join(root, "s1"))).toEqual([basename(linkedTask)]); // ни захвата, ни ответа рядом
  expect(await readdir(outside)).toHaveLength(2);

  const rootLink = `${root}-link`;
  await symlink(root, rootLink);
  expect(await runBridge({ page, root: rootLink, ...fast }).catch((e) => e)).toBeInstanceOf(FatalError);
});

test("пустая задача — error-<id>.md, в чат ничего не уходит", async ({ page }) => {
  await openChat(page);
  const root = await newRoot();
  const a = await task(root, "s1", " \n\t ");

  const bridge = start(page, root);
  await handled(a);
  expect(await bridge.stop()).toEqual({ sent: 0 });
  expect(await sent(page)).toEqual([]);
  expect(await read(a.error)).toContain("пустая задача");
});

for (const [why, query, draft] of [
  ["идёт ответ", "?busy", ""],
  ["в поле ввода черновик", "", "черновик оператора"],
] as const) {
  test(`чат занят (${why}): мост ничего не вводит, FatalError и error-<id>.md`, async ({ page }) => {
    await openChat(page, query);
    if (draft) await page.locator(SEL.composer).fill(draft);
    const root = await newRoot();
    const a = await task(root, "s1", "задача");

    expect(await runBridge({ page, root, ...fast }).catch((e) => e)).toBeInstanceOf(FatalError);

    expect(await sent(page)).toEqual([]);
    expect(await page.locator(SEL.composer).innerText()).toBe(draft);
    expect(await read(a.error)).toMatch(/\S/);
    for (const path of [a.claim, join(root, BRIDGE_LOCK)]) expect(existsSync(path), path).toBe(false);
  });
}

test("ChatGPT принял сообщение и молчит — error-<id>.md, мост берёт следующую задачу", async ({ page }) => {
  await openChat(page, "?noanswer&keep=1"); // keep=1: старые пары выгружаются, новую мост ищет по ключу, не по счёту
  const root = await newRoot();
  const a = await task(root, "s1", "без ответа");
  const b = await task(root, "s2", "следующая");

  const bridge = start(page, root, { startTimeoutMs: 1_000 });
  await handled(a);
  await handled(b);
  expect(await bridge.stop()).toEqual({ sent: 2 });
  expect(await read(a.error)).toMatch(/\S/);
  expect(existsSync(a.reply)).toBe(false);
  expect(await read(b.reply)).toContain("Эхо: следующая");
});

test("ChatGPT не принял сообщение (лимит, капча) — мост встаёт: FatalError, error-<id>.md, дальше ничего не уходит", async ({ page }) => {
  await openChat(page, "?reject");
  const root = await newRoot();
  const a = await task(root, "s1", "не примут");
  const b = await task(root, "s2", "следующая");

  const error = await runBridge({ page, root, ...fast, startTimeoutMs: 1_000 }).catch((e) => e);
  expect(error).toBeInstanceOf(FatalError);
  expect(error.message).toContain("не принял");
  expect(await read(a.error)).toContain("не принял");
  expect(await sent(page)).toEqual([]);
  for (const path of [a.claim, b.claim, b.reply, b.error, join(root, BRIDGE_LOCK)]) expect(existsSync(path), path).toBe(false);
});

test("ответ дописан, но «Остановить» не уходит — по answerTimeoutMs «Остановить» и error-<id>.md", async ({ page }) => {
  await openChat(page, "?hang&ms=1");
  const root = await newRoot();
  const a = await task(root, "s1", "вечный ответ");

  const bridge = start(page, root, { answerTimeoutMs: 2_000 });
  await handled(a);
  expect(await bridge.stop()).toEqual({ sent: 1 });
  expect(await stopped(page)).toBe(1);
  expect(existsSync(a.reply)).toBe(false);
  expect(await read(a.error)).toMatch(/\S/);
});

test("второй мост на том же корне не запускается, замок первого цел", async ({ page }) => {
  await openChat(page);
  const root = await newRoot();
  const lock = join(root, BRIDGE_LOCK);
  const first = start(page, root);
  await expect.poll(() => existsSync(lock)).toBe(true);

  const error = await runBridge({ page, root, ...fast }).catch((e) => e);
  expect(error).toBeInstanceOf(FatalError);
  expect(error.message).toContain("другой мост уже работает");

  expect(await isFresh(lock)).toBe(true);
  expect(await first.stop()).toEqual({ sent: 0 });
  expect(existsSync(lock)).toBe(false);
});

test("замок упавшего моста (без пульса) перехватывается", async ({ page }) => {
  await openChat(page);
  const root = await newRoot();
  const lock = join(root, BRIDGE_LOCK);
  await writeFile(lock, "упавший мост");
  await age(lock, LEASE_MS + 5_000);
  const a = await task(root, "s1", "задача");

  const bridge = start(page, root);
  await handled(a);
  expect(await bridge.stop()).toEqual({ sent: 1 });
  expect(await read(a.reply)).toContain("Эхо: задача");
  expect(existsSync(lock)).toBe(false);
});

test("мост привязан к открытому чату: не /c/<id> — не стартует, вкладку увели в другой чат — FatalError", async ({ page, context }) => {
  const root = await newRoot();
  const blank = await context.newPage();
  expect(await runBridge({ page: blank, root, ...fast }).catch((e) => e)).toBeInstanceOf(FatalError);

  await openChat(page);
  const a = await task(root, "s1", "задача");
  const bridge = start(page, root);
  await handled(a); // мост работает и запомнил чат
  await page.evaluate(() => history.pushState(null, "", "/c/another-chat"));
  expect(await bridge.run.catch((e) => e)).toBeInstanceOf(FatalError);
  expect(existsSync(join(root, BRIDGE_LOCK))).toBe(false);
});

test("проверка codexpro-sandbox пропускает только «остановлен» и «такого контейнера нет», при сбое — отказ", () => {
  const exit1 = new Error("Command failed: exit 1");
  expect(sandboxVerdict(null, "false\n", "")).toBeNull();
  expect(sandboxVerdict(exit1, "\n", "error: no such object: codexpro-sandbox\n")).toBeNull();
  expect(sandboxVerdict(null, "true\n", "")).toMatch(/запущен codexpro-sandbox/);
  for (const [error, stdout, stderr] of [
    [new Error("spawn docker ENOENT"), "", ""], // нет docker
    [exit1, "", "Cannot connect to the Docker daemon"], // OrbStack не запущен
    [exit1, "", 'context "orbstack": context not found'],
    [null, "", ""],
    [null, "<no value>", ""],
  ] as const) {
    expect(sandboxVerdict(error, stdout, stderr), `${stderr || stdout || error?.message}`).toMatch(/не удалось проверить/);
  }
});
