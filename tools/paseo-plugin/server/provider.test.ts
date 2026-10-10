import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { access, appendFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { acquire, BRIDGE_LOCK, fileName, isFresh, newTaskId, parseName, pulse, tasksRoot, writeAtomic, type Kind } from "./protocol";
import { createCodexproProvider } from "./provider";

// pulse — настоящий, но тест может подменить один вызов (гонка «файл удалён между проверкой и пульсом»)
vi.mock("./protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./protocol")>();
  return { ...actual, pulse: vi.fn(actual.pulse) };
});

// Переносы, отступ, обратные кавычки и перевод строки в конце: в файл задачи — байт в байт.
const TEXT = "Добавь README\n  с примером `npm test`\n";

async function startTurn({ bridge = false, pollMs = 5 } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "codexpro-worker-"));
  const root = tasksRoot(cwd);
  if (bridge) {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, BRIDGE_LOCK), "токен моста"); // mtime свежий — мост жив
  }
  const connection = await createCodexproProvider({ pollMs, pulseMs: 20 }).connect({
    versions: [1],
    capabilities: ["prompt.message"],
  });
  onTestFinished(async () => {
    await connection.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "s1",
    config: { cwd, env: {}, mcpServers: {}, settings: {}, persist: false },
    history: "skip",
  });
  await connection.send({
    type: "session.prompt",
    sessionId: "s1",
    prompt: { clientMessageId: "m1", delivery: "auto", input: { type: "message", content: [{ type: "text", text: TEXT }] } },
  });

  // подсказка появляется после записи задачи; id хода — из имени файла задачи
  await vi.waitFor(() => expect(said(events, "wait-turn-1")).toBeDefined());
  const box = join(root, "s1");
  const tasks = (await readdir(box)).map(parseName).filter((parsed) => parsed?.kind === "task");
  expect(tasks).toHaveLength(1);
  const id = tasks[0]!.id;
  const file = (kind: Kind) => join(box, fileName(kind, id));
  expect(await readFile(file("task"), "utf8")).toBe(TEXT);
  return { cwd, connection, events, box, id, file };
}

const turnStates = (events: ProviderEvent[]) => events.flatMap((e) => (e.type === "session.turn" ? [e.state] : []));
const turnError = (events: ProviderEvent[]) =>
  events.flatMap((e) => (e.type === "session.turn" && e.state === "failed" ? [e.error?.message] : []))[0];
const said = (events: ProviderEvent[], itemId: string) =>
  events.flatMap((e) =>
    e.type === "timeline.item" && e.item.type === "assistant_message" && e.item.id === itemId ? [e.item.text] : [],
  )[0];
const filesOf = async (box: string, id: string) => (await readdir(box)).filter((name) => parseName(name)?.id === id);

// Опрос плагина виден по уборке файла чужого id: она идёт в начале каждого опроса.
async function pollPassed(box: string) {
  const stale = newTaskId();
  await writeFile(join(box, fileName("claim", stale)), "");
  await vi.waitFor(async () => expect(await filesOf(box, stale)).toEqual([]));
  await sleep(50); // опрос дочитал ответ, до следующего далеко
}

describe("провайдер codexpro, протокол v2", () => {
  it("задача — ровно текст сообщения; ответ из reply-<id>.md уходит в чат как есть, файлы хода убраны", async () => {
    const { events, box, id, file } = await startTurn();
    const hint = said(events, "wait-turn-1");
    expect(hint).toContain("Задача ждёт ChatGPT");
    expect(hint).toContain("Use CodexPro Sandbox");
    expect(hint).toContain(`.ai-bridge/paseo/s1/${fileName("task", id)}`);
    expect(hint).toContain(`.ai-bridge/paseo/s1/${fileName("reply", id)}`);

    await writeFile(file("reply"), "Готово: `README.md` добавлен\n");

    await vi.waitFor(() => expect(turnStates(events)).toEqual(["started", "completed"]));
    expect(said(events, "reply-turn-1")).toBe("Готово: `README.md` добавлен\n");
    expect(events.filter((e) => e.type === "session.prompt_result")).toHaveLength(1);
    await vi.waitFor(async () => expect(await filesOf(box, id)).toEqual([]));
  });

  it("файлы чужих id — остатки прошлых ходов: не принимаются и удаляются, посторонние не трогаются", async () => {
    const { events, box, file } = await startTurn();
    const old = newTaskId();
    for (const kind of ["task", "claim", "reply", "error"] as const) await writeFile(join(box, fileName(kind, old)), "старое");
    await writeFile(join(box, "notes.txt"), "заметки");

    await vi.waitFor(async () => expect(await filesOf(box, old)).toEqual([]));
    expect(turnStates(events)).toEqual(["started"]);
    expect(await readFile(join(box, "notes.txt"), "utf8")).toBe("заметки");

    await writeFile(file("reply"), "новое");
    await vi.waitFor(() => expect(turnStates(events)).toEqual(["started", "completed"]));
    expect(said(events, "reply-turn-1")).toBe("новое");
  });

  it("недописанный ответ не принимается, пока не перестанет меняться между опросами", async () => {
    const { events, box, file } = await startTurn({ pollMs: 200 });
    await pollPassed(box);

    await writeFile(file("reply"), "Гот");
    await pollPassed(box); // плагин видел «Гот» один раз
    await appendFile(file("reply"), "ово");

    await vi.waitFor(() => expect(turnStates(events)).toEqual(["started", "completed"]));
    expect(said(events, "reply-turn-1")).toBe("Готово");
  });

  it("error-<id>.md: ход падает с текстом ошибки", async () => {
    const { events, box, id, file } = await startTurn();

    await writeAtomic(file("error"), "мост остановлен оператором");

    await vi.waitFor(() => expect(turnStates(events)).toEqual(["started", "failed"]));
    expect(turnError(events)).toBe("мост остановлен оператором");
    await vi.waitFor(async () => expect(await filesOf(box, id)).toEqual([]));
  });

  it("«Стоп» отменяет ход и удаляет все файлы задачи, включая захват моста", async () => {
    const { connection, events, box, id, file } = await startTurn();
    expect(await acquire(file("claim"), "токен моста")).toBe("created");

    await connection.send({ type: "session.interrupt", requestId: "stop-1", sessionId: "s1" });

    await vi.waitFor(() => expect(events).toContainEqual({ type: "request.completed", requestId: "stop-1" }));
    expect(turnStates(events)).toEqual(["started", "canceled"]);
    expect(await filesOf(box, id)).toEqual([]);
  });

  it("пока ход идёт, mtime задачи пульсирует, а текст не меняется", async () => {
    const { file } = await startTurn();
    const old = new Date(Date.now() - 60_000);

    await utimes(file("task"), old, old);

    await vi.waitFor(async () => expect(await isFresh(file("task"), 1000)).toBe(true));
    expect(await readFile(file("task"), "utf8")).toBe(TEXT);
  });

  it("свежий .bridge.lock: подсказка — задача ушла мосту", async () => {
    const { events, id } = await startTurn({ bridge: true });
    const hint = said(events, "wait-turn-1");
    expect(hint).toMatch(/мост/);
    expect(hint).toContain(fileName("task", id));
    expect(hint).not.toContain("Задача ждёт ChatGPT");
  });

  it("reply-<id>.md — ссылка: по ней не идём, ход падает", async () => {
    const { cwd, events, file } = await startTurn();
    const secret = join(cwd, "secret.txt");
    await writeFile(secret, "секрет");

    await symlink(secret, file("reply"));

    await vi.waitFor(() => expect(turnStates(events)).toEqual(["started", "failed"]));
    expect(turnError(events)).toMatch(/ссылка/);
    expect(JSON.stringify(events)).not.toContain("секрет");
    expect(await readFile(secret, "utf8")).toBe("секрет");
  });

  it("файл задачи удалён — ход падает", async () => {
    const { events, file } = await startTurn();

    await rm(file("task"));

    await vi.waitFor(() => expect(turnStates(events)).toEqual(["started", "failed"]));
    expect(turnError(events)).toBe("файл задачи удалён");
  });

  it("файл задачи удалён между проверкой и пульсом — тоже «файл задачи удалён», а не ошибка чтения ответа", async () => {
    const { events } = await startTurn();
    const { pulse: real } = await vi.importActual<typeof import("./protocol")>("./protocol");
    vi.mocked(pulse).mockImplementationOnce(async (path) => {
      await rm(path); // ровно в окне после lstat плагина
      return real(path);
    });

    await vi.waitFor(() => expect(turnStates(events)).toEqual(["started", "failed"]));
    expect(turnError(events)).toBe("файл задачи удалён");
  });

  it("закрытие сессии отменяет ход и удаляет папку сессии", async () => {
    const { connection, events, box } = await startTurn();

    await connection.send({ type: "session.close", requestId: "close-1", sessionId: "s1" });

    await vi.waitFor(() => expect(events).toContainEqual({ type: "request.completed", requestId: "close-1" }));
    expect(turnStates(events)).toEqual(["started", "canceled"]);
    await expect(access(box)).rejects.toThrow();
  });
});
