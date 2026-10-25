// Метрики (birdview §1, У-6): файл состояния, счётчики сопротивления,
// отказ записи не останавливает мост, битый файл — счётчики с нуля.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock } from "../../src/core/clock.ts";
import { createLogger } from "../../src/core/log.ts";
import { Metrics } from "../../src/metrics/metrics.ts";

function logger(): ReturnType<typeof createLogger> {
  return createLogger(() => {}, () => 0);
}

test("метрики: счётчики сопротивления пишутся по событиям (У-6)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "metrics-"));
  try {
    const clock = new ManualClock(1_700_000_000_000);
    const metrics = new Metrics(dir, "bridge-metrics.json", clock, logger());
    await metrics.recordResistance("challenge");
    await metrics.recordResistance("challenge");
    await metrics.recordResistance("rateLimit");
    await metrics.recordResistance("backoff");
    await metrics.recordResistance("backoff");
    await metrics.recordResistance("backoff");
    const state = JSON.parse(await readFile(join(dir, "bridge-metrics.json"), "utf8"));
    assert.deepEqual(state.resistance, { challenge: 2, rateLimit: 1, backoff: 3 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("метрики: состав файла — ходы, отправки, темп, сопротивление (У-6)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "metrics-"));
  try {
    const clock = new ManualClock(1_700_000_000_000);
    const metrics = new Metrics(dir, "bridge-metrics.json", clock, logger());
    await metrics.record({ kind: "ok", ms: 100 }, "t1");
    await metrics.record({ kind: "error" }, "t2");
    await metrics.recordSend(3, 3);
    await metrics.recordPace(2);
    const state = JSON.parse(await readFile(join(dir, "bridge-metrics.json"), "utf8"));
    assert.deepEqual(state.turns, { ok: 1, error: 1, cancelled: 0 });
    assert.deepEqual(state.sends, { total: 3, lastHour: 3 });
    assert.equal(state.pace.errorStreak, 2);
    assert.deepEqual(state.resistance, { challenge: 0, rateLimit: 0, backoff: 0 }, "счётчик сопротивления есть всегда");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("метрики: битый файл — счётчики с нуля, мост не падает (birdview §1)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "metrics-"));
  try {
    await writeFile(join(dir, "bridge-metrics.json"), "{ обрыв", "utf8");
    const clock = new ManualClock(1_700_000_000_000);
    const metrics = new Metrics(dir, "bridge-metrics.json", clock, logger());
    await metrics.recordResistance("challenge");
    const state = JSON.parse(await readFile(join(dir, "bridge-metrics.json"), "utf8"));
    assert.deepEqual(state.resistance, { challenge: 1, rateLimit: 0, backoff: 0 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("метрики: выключенные метрики — вызовы безопасны, файла нет", async () => {
  const clock = new ManualClock(1_700_000_000_000);
  const metrics = new Metrics(null, "bridge-metrics.json", clock, logger());
  await metrics.recordResistance("challenge"); // не бросает
  await metrics.record({ kind: "ok", ms: 0 }, "t"); // не бросает
  assert.ok(true);
});
