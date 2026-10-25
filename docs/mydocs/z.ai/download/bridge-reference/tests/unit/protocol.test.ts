// Протокол v3 на диске: захват и эпохи, пульс аренды, фазы, результат O_EXCL,
// журнал идемпотентности, очередь FIFO с тай-брейком (birdview §2, §5 unit).

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock } from "../../src/core/clock.ts";
import { SeededRandom } from "../../src/core/random.ts";
import { ACK_FILE, ALIVE_FILE, CANCEL_FILE, CLAIM_PREFIX, JOURNAL_FILE, LEASE_PREFIX, RESULT_FILE, STATE_PREFIX, TASK_FILE, newTurnId, parseTurnId } from "../../src/protocol/names.ts";
import { putTask, readTask } from "../../src/protocol/task.ts";
import { createClaim, freshestLease, LeasePulser, maxClaimEpoch, stillOwned } from "../../src/protocol/claim.ts";
import { readLatestState, writeState } from "../../src/protocol/state.ts";
import { ackResult, hasAck, readResult, readResultOutcome, waitForAck, writeResult } from "../../src/protocol/result.ts";
import { checkJournal, journalSend } from "../../src/protocol/journal.ts";
import { scanQueue } from "../../src/protocol/queue.ts";
import { touch } from "../../src/protocol/atomic.ts";

async function freshRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "protocol-test-"));
}

test("имена файлов протокола без пробелов и ровно как в документе Д-7 (R03)", () => {
  assert.equal(TASK_FILE, "task.json");
  assert.equal(ALIVE_FILE, "alive");
  assert.equal(CANCEL_FILE, "cancel");
  assert.equal(RESULT_FILE, "result.json");
  assert.equal(ACK_FILE, "result.ack");
  assert.equal(JOURNAL_FILE, "journal.jsonl");
  assert.equal(CLAIM_PREFIX, "claim.");
  assert.equal(LEASE_PREFIX, "lease.");
  assert.equal(STATE_PREFIX, "state.");
  for (const name of [TASK_FILE, ALIVE_FILE, CANCEL_FILE, RESULT_FILE, ACK_FILE, JOURNAL_FILE]) {
    assert.ok(!/\s/.test(name), `имя «${name}» содержит пробельный символ`);
  }
});

test("id хода: время UTC + случайный суффикс; сортировка по строке = FIFO (birdview §2)", () => {
  const rand = new SeededRandom(7);
  const id1 = newTurnId(Date.UTC(2026, 9, 23, 10, 0, 0), rand);
  const id2 = newTurnId(Date.UTC(2026, 9, 23, 10, 0, 1), rand);
  assert.match(id1, /^20261023T100000Z-[2-7a-z]{6}$/);
  assert.match(parseTurnId(id2)!.stamp, /^20261023T100001Z$/);
  assert.ok(id1 < id2); // лексикографический порядок — порядок очереди
  assert.equal(parseTurnId("не-id"), null);
  assert.equal(parseTurnId("20261023T100000Z-01abad"), null); // 0/1 в суффиксе не допускаются
});

test("claim: O_EXCL, эпохи, владение — максимальная эпоха (birdview §2)", async () => {
  const root = await freshRoot();
  try {
    const dir = join(root, "x");
    await mkdir(dir);
    assert.equal(await maxClaimEpoch(dir), 0);
    assert.ok(await createClaim(dir, 1));
    assert.ok(!(await createClaim(dir, 1))); // та же эпоха занята — проигравший отступает
    assert.ok(await stillOwned(dir, 1));
    assert.ok(await createClaim(dir, 2)); // перехватчик
    assert.ok(!(await stillOwned(dir, 1))); // прошлый владелец видит утрату
    assert.ok(await stillOwned(dir, 2));
    assert.equal(await maxClaimEpoch(dir), 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lease: пульс отдельным таймером живёт, после остановки протухает (Н-1)", async () => {
  const root = await freshRoot();
  // реальный fs работает вне подставных часов — между фазами даём пульсам дозаписаться
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
  try {
    const dir = join(root, "x");
    await mkdir(dir);
    const clock = new ManualClock(0);
    const pulser = new LeasePulser(dir, 1, clock, 10_000, () => {});
    pulser.start();
    await clock.advanceAsync(35_000);
    await flush();
    const fresh = await freshestLease(dir, clock);
    assert.ok(fresh, "файл аренды создан первым же пульсом");
    assert.ok(fresh && fresh.ageMs <= 10_000, `пульс продолжается (возраст ${fresh?.ageMs})`); // ход не перехватят
    pulser.stop();
    await flush();
    await clock.advanceAsync(40_000);
    const stale = await freshestLease(dir, clock);
    assert.ok(stale && stale.ageMs >= 35_000, `после остановки пульса аренда протухает (возраст ${stale?.ageMs})`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("freshestLease берёт максимальную эпоху, старые игнорируются (birdview §2)", async () => {
  const root = await freshRoot();
  try {
    const dir = join(root, "x");
    await mkdir(dir);
    const clock = new ManualClock(0);
    await writeFile(join(dir, "lease.1"), "1\n");
    await touch(join(dir, "lease.1"), clock.now());
    await clock.advanceAsync(30_000);
    await writeFile(join(dir, "lease.2"), "2\n");
    await touch(join(dir, "lease.2"), clock.now());
    const lease = await freshestLease(dir, clock);
    assert.equal(lease?.epoch, 2);
    assert.ok(lease && lease.ageMs < 1_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("state: атомарная запись/чтение, последняя эпоха (birdview §2)", async () => {
  const root = await freshRoot();
  try {
    const dir = join(root, "x");
    await mkdir(dir);
    await writeState(dir, 1, "preparing");
    await writeState(dir, 2, "typing");
    const latest = await readLatestState(dir);
    assert.equal(latest?.epoch, 2);
    assert.equal(latest?.phase, "typing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("result: создаётся ровно один раз (O_EXCL), ack переименовывает (Н-1, birdview §2)", async () => {
  const root = await freshRoot();
  try {
    const dir = join(root, "x");
    await mkdir(dir);
    assert.ok(await writeResult(dir, { status: "ok", markdown: "ответ", traceId: "t1" }));
    assert.ok(!(await writeResult(dir, { status: "error", code: "X", message: "дубль" }))); // второй раз нельзя
    const read = await readResult(dir);
    assert.equal(read?.status, "ok");
    assert.equal(read?.markdown, "ответ");
    assert.ok(!(await hasAck(dir)));
    assert.ok(await ackResult(dir));
    assert.ok(await hasAck(dir));
    assert.equal(await readResult(dir), null); // переименован — результата больше нет
    const clock = new ManualClock(0);
    assert.ok(await waitForAck(dir, 1_000, clock)); // ack уже на месте
    await rm(join(dir, "result.ack"));
    // тайм-аут ожидания: часы двигаем интерливингом, как в контрактных тестах
    let timedOut = false;
    void waitForAck(dir, 1_000, clock).then((value) => {
      timedOut = !value;
    });
    for (let i = 0; i < 30 && !timedOut; i++) {
      await clock.advanceAsync(200);
      await new Promise((resolve) => setTimeout(resolve, 5)); // let real stat I/O settle, as driveUntil does
    }
    assert.ok(timedOut, "waitForAck возвращает false по истечении лимита");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("result: валидация — битый result.json даёт corrupt с причиной, а не тихий null (R15)", async () => {
  const root = await freshRoot();
  try {
    const dir = join(root, "x");
    await mkdir(dir);
    assert.equal((await readResultOutcome(dir)).kind, "absent");
    await writeFile(join(dir, RESULT_FILE), "{}");
    let read = await readResultOutcome(dir);
    assert.equal(read.kind, "corrupt");
    if (read.kind === "corrupt") assert.match(read.reason, /статус|traceId/);
    await writeFile(join(dir, RESULT_FILE), JSON.stringify({ status: "ok", traceId: "t" }));
    read = await readResultOutcome(dir);
    assert.equal(read.kind, "corrupt"); // ok без markdown — битый результат
    await writeFile(join(dir, RESULT_FILE), JSON.stringify({ status: "cancelled", traceId: "t" }));
    read = await readResultOutcome(dir);
    assert.equal(read.kind, "corrupt"); // отменённый без кода — битый результат
    await writeFile(join(dir, RESULT_FILE), "{ не json");
    assert.equal((await readResultOutcome(dir)).kind, "corrupt");
    await writeFile(join(dir, RESULT_FILE), JSON.stringify({ status: "error", code: "STOPPED", traceId: "t", message: "м" }));
    read = await readResultOutcome(dir);
    assert.equal(read.kind, "ok");
    if (read.kind === "ok") assert.equal(read.result.code, "STOPPED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("journal: absent/present/corrupt; повреждение не переписывается (Н-1, birdview §3)", async () => {
  const root = await freshRoot();
  try {
    const dir = join(root, "x");
    await mkdir(dir);
    assert.equal(await checkJournal(dir, "id1"), "absent");
    await journalSend(dir, "id1", 1);
    assert.equal(await checkJournal(dir, "id1"), "present");
    assert.equal(await checkJournal(dir, "id2"), "absent");
    await writeFile(join(dir, "journal.jsonl"), "{обрыв строки\n", { flag: "a" });
    assert.equal(await checkJournal(dir, "id1"), "corrupt");
    assert.equal(await checkJournal(dir, "id2"), "corrupt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("очередь: FIFO по id, тай-брейк по createdAt, битое — в broken (Ф-3)", async () => {
  const root = await freshRoot();
  try {
    const rand = new SeededRandom(3);
    const a = await putTask(root, { v: 3, id: newTurnId(Date.UTC(2026, 0, 1, 10, 0, 0), rand), createdAt: 2, traceId: "t", text: "a" });
    const b = await putTask(root, { v: 3, id: newTurnId(Date.UTC(2026, 0, 1, 10, 0, 1), rand), createdAt: 1, traceId: "t", text: "b" });
    // одинаковая секунда: тай-брейк по createdAt
    const c = newTurnId(Date.UTC(2026, 0, 1, 10, 0, 1), rand);
    await putTask(root, { v: 3, id: c, createdAt: 0, traceId: "t", text: "c" });
    await putTask(root, { v: 3, id: newTurnId(Date.UTC(2026, 0, 1, 9, 59, 59), rand), createdAt: 9, traceId: "t", text: "первый" });
    await mkdir(join(root, "мусор"));
    const scan = await scanQueue(root);
    const ids = scan.pending.map((entry) => entry.task.id);
    assert.ok(ids.length === 4, `в очереди 4 хода, а не ${ids.length}`);
    // первый — самый ранний по времени, затем порядок секунд, при равных — createdAt
    assert.equal(scan.pending[0]!.task.text, "первый");
    const sameSecond = scan.pending.filter((entry) => parseTurnId(entry.task.id)!.stamp === "20260101T100001Z");
    assert.equal(sameSecond.length, 2);
    assert.equal(sameSecond[0]!.task.text, "c"); // createdAt 0 раньше 1
    assert.ok(scan.broken.some((broken) => broken.id === "мусор"));
    assert.ok(!scan.pending.some((entry) => entry.task.id === a && entry.task.text !== "a"));
    assert.ok(!scan.pending.some((entry) => entry.task.id === b && entry.task.text !== "b"));
    // закрытый ход (валидный result.json) из очереди исчезает
    await writeResult(join(root, a), { status: "cancelled", code: "CANCEL", traceId: "t" });
    const after = await scanQueue(root);
    assert.ok(!after.pending.some((entry) => entry.task.id === a));
    assert.ok(!after.broken.some((broken) => broken.id === a));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("очередь: битый result.json — broken с причиной; acked-ход не воскресает (R15, Н-1)", async () => {
  const root = await freshRoot();
  try {
    const rand = new SeededRandom(5);
    const corruptId = newTurnId(Date.UTC(2026, 0, 1, 10, 0, 0), rand);
    await putTask(root, { v: 3, id: corruptId, createdAt: 1, traceId: "t", text: "битый результат" });
    await writeFile(join(root, corruptId, RESULT_FILE), "{}");
    const ackedId = newTurnId(Date.UTC(2026, 0, 1, 10, 0, 1), rand);
    const ackedDir = join(root, await putTask(root, { v: 3, id: ackedId, createdAt: 1, traceId: "t", text: "подтверждён и ждёт удаления" }));
    await writeResult(ackedDir, { status: "ok", markdown: "ответ", traceId: "t" });
    await ackResult(ackedDir); // result.ack без result.json — подтверждённый ход
    const scan = await scanQueue(root);
    assert.ok(!scan.pending.some((entry) => entry.task.id === corruptId), "битый результат — не «ход закрыт»");
    assert.ok(scan.broken.some((broken) => broken.id === corruptId && /result\.json/.test(broken.reason)), "битый результат — явная битость");
    assert.ok(!scan.pending.some((entry) => entry.task.id === ackedId), "подтверждённый ход не встаёт в очередь снова");
    assert.ok(!scan.broken.some((broken) => broken.id === ackedId));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

if ((process as NodeJS.Process).getuid?.() !== 0) {
  test("очередь: EACCES на каталоге хода — ошибка наружу, а не «файла нет» (R16)", async () => {
    const root = await freshRoot();
    const rand = new SeededRandom(6);
    const id = newTurnId(Date.UTC(2026, 0, 1), rand);
    const dir = join(root, await putTask(root, { v: 3, id, createdAt: 1, traceId: "t", text: "закрытый каталог" }));
    await chmod(dir, 0o000);
    try {
      await assert.rejects(
        scanQueue(root),
        (error: unknown) => (error as NodeJS.ErrnoException)?.code === "EACCES",
        "недоступность spool не маскируется под отсутствие результата",
      );
    } finally {
      await chmod(dir, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("task: битый task.json — broken, а не остановка моста (Ф-3)", async () => {
  const root = await freshRoot();
  try {
    const rand = new SeededRandom(11);
    const id = newTurnId(Date.UTC(2026, 0, 1), rand);
    const dir = join(root, id);
    await putTask(root, { v: 3, id, createdAt: 1, traceId: "t", text: "норма" });
    assert.deepEqual(await readTask(dir, id), { ok: true, task: { v: 3, id, createdAt: 1, traceId: "t", text: "норма" } });
    await writeFile(join(dir, "task.json"), "{ поломано");
    assert.deepEqual(await readTask(dir, id), { ok: false, reason: "broken" });
    await writeFile(join(dir, "task.json"), JSON.stringify({ v: 2, id, createdAt: 1, traceId: "t", text: "старый протокол" }));
    assert.deepEqual(await readTask(dir, id), { ok: false, reason: "broken" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
