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
  typingSharesMs,
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
  pacer.recordError(0);
  pacer.recordError(0);
  pacer.recordError(0);
  const streakBefore = pacer.errorStreak;
  pacer.noteRateLimit();
  pacer.limitCheck(0);
  assert.equal(pacer.errorStreak, streakBefore);
});

test("Pacer: успех сбрасывает серию ошибок, пауза растёт от серии (Н-5)", () => {
  const pacer = new Pacer(cfg, zero);
  assert.equal(pacer.recordError(0), 0);
  assert.equal(pacer.recordError(0), 0);
  assert.equal(pacer.recordError(0), cfg.errorBackoffMs); // третья подряд — пауза
  pacer.recordSuccess();
  assert.equal(pacer.errorStreak, 0);
  assert.equal(pacer.recordError(0), 0); // серия началась заново
});

test("Pacer: backoffUntilMs в срезе — пауза серии видна и гаснет по времени (У-7)", () => {
  const pacer = new Pacer(cfg, zero);
  assert.equal(pacer.snapshot(10_000).backoffUntilMs, null, "без ошибок паузы нет");
  pacer.recordError(10_000);
  pacer.recordError(10_000);
  assert.equal(pacer.snapshot(10_000).backoffUntilMs, null, "серия ниже лимита — паузы нет");
  const pauseMs = pacer.recordError(10_000);
  assert.equal(pauseMs, cfg.errorBackoffMs);
  assert.equal(pacer.snapshot(10_000).backoffUntilMs, 10_000 + cfg.errorBackoffMs);
  assert.equal(pacer.snapshot(10_000 + cfg.errorBackoffMs).backoffUntilMs, null, "пауза истекла — null");
  pacer.recordSuccess();
  pacer.recordError(20_000); // серия заново — ниже лимита
  assert.equal(pacer.snapshot(20_000).backoffUntilMs, null);
});

test("Pacer: физический набор (У-3) — typingTimeMs исключён из базы паузы", () => {
  const noJitter = { next: () => 0, int: (n: number) => 0, pick: <T,>(xs: readonly T[]) => xs[0]! };
  const pacer = new Pacer(cfg, noJitter);
  const long = "x".repeat(1_000); // typingTimeMs упирается в maxTypingMs (120 с)
  assert.equal(pacer.delayFor(long, 0), cfg.maxTypingMs, "instant: база = время набора");
  assert.equal(pacer.delayFor(long, 0, true), cfg.minIntervalMs, "chunks: база = minIntervalMs без typingTime");
});

// R5 ревью PR #10: один общий бюджет набора на всё сообщение, включая первую
// порцию; потолок maxTypingMs — на сообщение, а не на порцию.

test("typingSharesMs (R5): одна порция платит весь бюджет, включая потолок", () => {
  const slow: PaceConfig = { ...DEFAULT_PACE, charsPerSec: 1, maxTypingMs: 10_000, jitter: 0 };
  // 180 символов @1 симв/с — 180 с, упирается в потолок 10 с: одна порция платит все 10 с
  assert.deepEqual(typingSharesMs(["х".repeat(180)], slow, 0), [10_000]);
});

test("typingSharesMs (R5): потолок общий на сообщение, а не на каждую порцию", () => {
  const slow: PaceConfig = { ...DEFAULT_PACE, charsPerSec: 1, maxTypingMs: 1_000, jitter: 0 };
  const chunks = ["а".repeat(36), "б".repeat(36), "в".repeat(36), "г".repeat(36), "д".repeat(36)];
  const shares = typingSharesMs(chunks, slow, 0);
  assert.equal(shares.reduce((sum, ms) => sum + ms, 0), 1_000, "сумма долей = общему бюджету (было 4×1000)");
  for (const share of shares) assert.ok(share > 0, "каждая порция платит, включая первую");
});

test("typingSharesMs (R5): джиттер растягивается один раз на сообщение, сумма сходится", () => {
  const stretch: PaceConfig = { ...DEFAULT_PACE, charsPerSec: 2, maxTypingMs: 60_000, jitter: 0.5 };
  const chunks = ["Первое предложение. ", "Второе предложение подлиннее."];
  const total = Math.round(typingTimeMs(chunks.join("").length, stretch) * (1 + 0.5 * 1));
  const shares = typingSharesMs(chunks, stretch, 1);
  assert.equal(shares.reduce((sum, ms) => sum + ms, 0), total, "сумма долей = бюджет с джиттером");
  assert.ok(shares[0]! > 0, "первая порция не бесплатна");
});

test("typingSharesMs (R5): пустые порции и пустой список безопасны", () => {
  assert.deepEqual(typingSharesMs([], cfg, 0), []);
  assert.deepEqual(typingSharesMs([""], cfg, 0), [0]);
});

test("typingSharesMs: много коротких и пустых порций — целые неотрицательные доли, один бюджет", () => {
  for (const count of [0, 1, 2, 5, 2_000]) {
    const chunks = ["", ...Array.from({ length: count }, () => "A. "), ""];
    for (const maxTypingMs of [0, 1, 7, 1_000]) {
      for (const draw of [0, 0.5, 1]) {
        const cfg: PaceConfig = { ...DEFAULT_PACE, charsPerSec: 1, maxTypingMs, jitter: 0.5 };
        const shares = typingSharesMs(chunks, cfg, draw);
        const budget = Math.round(typingTimeMs(chunks.join("").length, cfg) * (1 + cfg.jitter * draw));
        assert.equal(shares.length, chunks.length);
        assert.ok(shares.every((ms) => Number.isInteger(ms) && ms >= 0), `count=${count}, budget=${budget}: отрицательная доля`);
        assert.equal(shares.filter((ms) => ms > 0).reduce((sum, ms) => sum + ms, 0), budget,
          "именно оплачиваемая положительная сумма равна единому бюджету");
        assert.equal(shares[0], 0, "пустая порция не платит");
        assert.equal(shares.at(-1), 0, "пустой хвост не получает остаток округления");
      }
    }
  }
  assert.deepEqual(typingSharesMs(["", ""], { ...DEFAULT_PACE, charsPerSec: 0 }, 0), [0, 0]);
});
