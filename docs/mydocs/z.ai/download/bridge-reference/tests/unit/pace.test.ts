// Формулы темпа (birdview §4, ТЗ §10): чистые функции и состояние Pacer —
// на подставных часах и сеемом ГСЧ (birdview §5, unit).

import assert from "node:assert/strict";
import { test } from "node:test";
import { SeededRandom } from "../../src/core/random.ts";
import {
  DEFAULT_PACE,
  Pacer,
  backoffAfterErrors,
  countInWindow,
  pauseBeforeSend,
  requiredBaseMs,
  typingTimeMs,
  type PaceConfig,
} from "../../src/pace/pace.ts";

const cfg: PaceConfig = { ...DEFAULT_PACE, jitter: 0.2 };
const zero = new SeededRandom(0); // next() > 0, но для точных значений подставляем свои

test("время набора: длина / charsPerSec, потолок maxTypingMs", () => {
  assert.equal(typingTimeMs(100, cfg), 20_000); // 100 / 5 = 20 с
  assert.equal(typingTimeMs(10_000, cfg), cfg.maxTypingMs); // длинные не растягиваются бесконечно
  assert.equal(typingTimeMs(0, cfg), 0);
});

test("база паузы: max(minIntervalMs, время набора с потолком) (П-2)", () => {
  assert.equal(requiredBaseMs(10, cfg), cfg.minIntervalMs); // короткий текст — интервал
  assert.equal(requiredBaseMs(1_000, cfg), cfg.maxTypingMs); // набор 200 с упирается в потолок 120 с
});

test("первая отправка вычитает 0 — мгновенной отправки нет (П-2)", () => {
  const rand = { next: () => 0, int: (n: number) => 0, pick: <T,>(xs: readonly T[]) => xs[0]! };
  const pause = pauseBeforeSend({ now: 1_000, lastSentAt: null, textLength: 10, cfg, rand });
  assert.equal(pause, cfg.minIntervalMs); // полная база, ничего не вычтено
});

test("джиттер односторонний: пауза не опускается ниже minIntervalMs (birdview §4)", () => {
  for (let i = 0; i < 200; i++) {
    const value = i / 200;
    const rand = { next: () => value, int: (n: number) => 0, pick: <T,>(xs: readonly T[]) => xs[0]! };
    const pause = pauseBeforeSend({ now: 1_000, lastSentAt: null, textLength: 10, cfg, rand });
    assert.ok(pause >= cfg.minIntervalMs, `пауза ${pause} ниже норматива при rand=${value}`);
    assert.ok(pause <= cfg.minIntervalMs * (1 + cfg.jitter) + 1);
  }
});

test("вычет времени с прошлой отправки, но не ниже нуля (П-2)", () => {
  const rand = { next: () => 0, int: (n: number) => 0, pick: <T,>(xs: readonly T[]) => xs[0]! };
  assert.equal(pauseBeforeSend({ now: 15_000, lastSentAt: 0, textLength: 10, cfg, rand }), 5_000);
  assert.equal(pauseBeforeSend({ now: 30_000, lastSentAt: 0, textLength: 10, cfg, rand }), 0);
});

test("часовое окно скользящее, по фактическим отправкам (П-3)", () => {
  const now = 3_600_000;
  const cutoff = now - 3_600_000;
  assert.equal(countInWindow([cutoff, cutoff - 1], now), 0); // граница окна и старше — вышли
  assert.equal(countInWindow([now - 1, now - 3_599_999, cutoff], now), 2);
  assert.equal(countInWindow([now], now), 1);
});

test("серия ошибок: 0 до лимита, дальше ×2, потолок (Н-5)", () => {
  assert.equal(backoffAfterErrors(2, cfg), 0);
  assert.equal(backoffAfterErrors(3, cfg), cfg.errorBackoffMs);
  assert.equal(backoffAfterErrors(4, cfg), cfg.errorBackoffMs * 2);
  const capped: PaceConfig = { ...cfg, maxBackoffMs: cfg.errorBackoffMs * 3 };
  assert.equal(backoffAfterErrors(9, capped), capped.maxBackoffMs);
});

test("Pacer: окно, отказ при пределе, ожидание освобождения (П-3)", () => {
  const pacer = new Pacer({ ...cfg, hourlyWarn: 2, hourlyMax: 3 }, zero);
  pacer.recordSend(0);
  pacer.recordSend(1_000);
  const check = pacer.limitCheck(2_000);
  assert.equal(check.gate, "ok"); // 2 из 3 — ещё можно
  pacer.recordSend(2_000);
  assert.equal(pacer.limitCheck(3_000).gate, "limited"); // 3 — предел
  // старейшая отправка в 0 выйдет из окна в 3_600_000
  assert.equal(pacer.windowSlotWaitMs(3_000), 3_600_000 - 3_000);
  assert.equal(pacer.limitCheck(3_600_001).gate, "ok"); // остались двое — можно снова
});

test("Pacer: жёлтый порог — ровно одно предупреждение на подъём счётчика (П-3)", () => {
  const pacer = new Pacer({ ...cfg, hourlyWarn: 2, hourlyMax: 5 }, zero);
  pacer.recordSend(0);
  pacer.recordSend(1_000);
  assert.equal(pacer.limitCheck(2_000).warn, true, "порог достигнут — предупредить");
  assert.equal(pacer.limitCheck(2_500).warn, false, "повторно на том же счётчике — молчание");
  assert.equal(pacer.limitCheck(3_000).warn, false);
  pacer.recordSend(3_000); // счётчик вырос — предупреждение обновляется ровно один раз
  assert.equal(pacer.limitCheck(3_500).warn, true);
  assert.equal(pacer.limitCheck(3_600).warn, false);
});

test("Pacer: час спустя окно свободно — счётчик падает, ход проходит (R09)", () => {
  const pacer = new Pacer({ ...cfg, hourlyWarn: 2, hourlyMax: 3 }, zero);
  for (let i = 0; i < 3; i++) pacer.recordSend(i); // отправки в 0, 1, 2
  assert.equal(pacer.limitCheck(3_000).gate, "limited");
  const afterHour = pacer.limitCheck(3_600_001); // граница: отметка 1 вышла (1 > 1 — нет), 2 ещё внутри
  assert.equal(afterHour.gate, "ok");
  assert.equal(afterHour.sentInWindow, 1, "отметки выходят строго по старшинству");
  const free = pacer.limitCheck(3_600_003); // все три вышли из окна
  assert.equal(free.gate, "ok");
  assert.equal(free.sentInWindow, 0, "устаревшие отметки вышли из окна");
  assert.equal(pacer.windowSlotWaitMs(3_600_003), 0);
});

test("Pacer: часовой лимит не трогает серию ошибок (R10, П-3)", () => {
  const pacer = new Pacer(cfg, zero);
  pacer.recordError();
  pacer.recordError();
  pacer.recordError();
  const streakBefore = pacer.errorStreak;
  pacer.noteRateLimit();
  pacer.limitCheck(0);
  assert.equal(pacer.errorStreak, streakBefore);
});

test("Pacer: успех сбрасывает серию ошибок, пауза растёт от серии (Н-5)", () => {
  const pacer = new Pacer(cfg, zero);
  assert.equal(pacer.recordError(), 0);
  assert.equal(pacer.recordError(), 0);
  assert.equal(pacer.recordError(), cfg.errorBackoffMs); // третья подряд — пауза
  pacer.recordSuccess();
  assert.equal(pacer.errorStreak, 0);
  assert.equal(pacer.recordError(), 0); // серия началась заново
});
