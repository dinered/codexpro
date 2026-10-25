// Сторона плагина (Ф-9): тайм-аут ожидания не трогает ход, гонка читателей,
// явная ошибка на битом результате, охрана удаления каталога (Н-1).
// Регресс-матрица аудита: R01, R02, R15.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock } from "../../src/core/clock.ts";
import { SeededRandom } from "../../src/core/random.ts";
import { createLogger } from "../../src/core/log.ts";
import { PluginClient } from "../../plugin-client/client.ts";
import { writeResult, ackResult, hasAck } from "../../src/protocol/result.ts";
import { RESULT_FILE } from "../../src/protocol/names.ts";

async function makeClient(seed = 1): Promise<{ root: string; clock: ManualClock; client: PluginClient }> {
  const root = await mkdtemp(join(tmpdir(), "plugin-client-"));
  const clock = new ManualClock(1_700_000_000_000);
  const client = new PluginClient(root, clock, new SeededRandom(seed), createLogger(() => {}, () => clock.now()));
  return { root, clock, client };
}

test("тайм-аут ожидания не трогает ход: каталог и журнал живы, пульс продолжается (R01, Н-1)", async () => {
  const { root, clock, client } = await makeClient();
  // реальный fs работает вне подставных часов — пульсам даём дозаписаться
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
  try {
    const task = await client.put("ход в работе моста", { aliveEveryMs: 2_000 });
    const dir = join(root, task.id);
    let timedOut = false;
    void client.waitResult(task.id, 5_000, 500).then((value) => {
      timedOut = value === null;
    });
    for (let i = 0; i < 60 && !timedOut; i++) await clock.advanceAsync(500);
    await flush();
    assert.ok(timedOut, "waitResult вернул null по тайм-ауту");
    assert.ok(await stat(join(dir, "task.json")).then(() => true, () => false), "каталог хода не удалён по тайм-ауту");
    assert.ok(await stat(join(dir, "journal.jsonl")).then(() => true, () => false) === false, "журнала отправок у неотправленного хода нет — ничего не снесено");
    // пульс продолжается, пока клиент жив: время идёт — alive обновляется
    const aliveAt = (await stat(join(dir, "alive"))).mtimeMs;
    await clock.advanceAsync(4_000);
    await flush();
    assert.ok((await stat(join(dir, "alive"))).mtimeMs > aliveAt, "пульс не остановился сам");
    client.stopPulse(task.id);
    await flush();
    const stoppedAt = (await stat(join(dir, "alive"))).mtimeMs;
    await clock.advanceAsync(30_000);
    await flush();
    assert.equal((await stat(join(dir, "alive"))).mtimeMs, stoppedAt, "после stopPulse пульс остановлен");
  } finally {
    client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("два читателя одного хода: результат отдаётся ровно одному (R02, Н-1)", async () => {
  const { root, clock, client } = await makeClient(2);
  const second = new PluginClient(root, clock, new SeededRandom(102), createLogger(() => {}, () => clock.now()));
  try {
    const task = await client.put("ход с двумя читателями", { aliveEveryMs: 2_000 });
    await writeResult(join(root, task.id), { status: "ok", markdown: "ответ", traceId: "t" });
    // Результат уже опубликован: оба читателя завершают реальное FS-чтение и
    // гонку rename без продвижения ManualClock быстрее, чем работает диск.
    const [readByFirst, readBySecond] = await Promise.all([
      client.waitResult(task.id, 5_000, 100),
      second.waitResult(task.id, 5_000, 100),
    ]);
    assert.equal((readByFirst !== null) !== (readBySecond !== null), true, "ровно один читатель получил результат");
    assert.ok(await hasAck(join(root, task.id)), "result.ack создан");
  } finally {
    client.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("битый result.json — явная ошибка ожидания, а не тихий тайм-аут (R15)", async () => {
  const { root, clock, client } = await makeClient(3);
  try {
    const task = await client.put("ход с битым результатом", { aliveEveryMs: 2_000 });
    const dir = join(root, task.id);
    await writeFile(join(dir, RESULT_FILE), "{}");
    let failed: unknown = null;
    void client.waitResult(task.id, 30_000, 200).catch((error: unknown) => {
      failed = error;
    });
    for (let i = 0; i < 50 && failed === null; i++) await clock.advanceAsync(200);
    assert.ok(failed instanceof Error, "waitResult бросил ошибку");
    assert.match((failed as Error).message, /повреждён/);
  } finally {
    client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("dispose: без ack запрещён, после ack удаляет каталог (Н-1)", async () => {
  const { root, clock, client } = await makeClient(4);
  try {
    const task = await client.put("ход на удаление", { aliveEveryMs: 2_000 });
    const dir = join(root, task.id);
    await assert.rejects(
      () => client.dispose(task.id),
      /не подтверждён/,
      "удаление неподтверждённого хода запрещено: журнал идемпотентности нельзя сносить",
    );
    assert.ok(await stat(join(dir, "task.json")).then(() => true, () => false), "каталог на месте после отказа");
    await writeResult(dir, { status: "ok", markdown: "ответ", traceId: "t" });
    await ackResult(dir);
    await client.dispose(task.id);
    assert.ok(!(await stat(dir).then(() => true, () => false)), "после ack каталог удалён");
  } finally {
    client.close();
    await rm(root, { recursive: true, force: true });
  }
});
