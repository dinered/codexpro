// Конец ответа (Ф-6, birdview §3): совокупность признаков, окно стабильности 3–5 с,
// рандомизированные опросы (П-5). Пауза стрима не принимается за конец ответа.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CompletionDetector } from "../../src/bridge/completion.ts";
import { SeededRandom } from "../../src/core/random.ts";

test("busy сбрасывает стабильность: пауза стрима 10 с — не конец ответа (e2e birdview §5)", () => {
  const detector = new CompletionDetector(new SeededRandom(1), 3_000);
  let now = 0;
  // текст печатается частями, busy между частями
  now += 1_500;
  assert.equal(detector.push({ busy: true, sendIdle: false, text: "часть 1" }, now), "continue");
  now += 10_000; // стрим молчит, но busy — конец не засчитан
  assert.equal(detector.push({ busy: true, sendIdle: false, text: "часть 1" }, now), "continue");
  now += 1_500;
  assert.equal(detector.push({ busy: true, sendIdle: false, text: "часть 1 продолжение" }, now), "continue");
  now += 1_500;
  assert.equal(detector.push({ busy: false, sendIdle: true, text: "часть 1 продолжение" }, now), "continue");
  // после busy нужен свой полный цикл стабильности
  assert.equal(detector.stableText, "часть 1 продолжение");
});

test("совокупность признаков: не busy + sendIdle + 3 опроса + окно 3–5 с", () => {
  const detector = new CompletionDetector(new SeededRandom(2), 3_000);
  let now = 0;
  assert.equal(detector.push({ busy: false, sendIdle: true, text: "готово" }, now), "continue"); // 1-й опрос
  now += 1_400;
  assert.equal(detector.push({ busy: false, sendIdle: true, text: "готово" }, now), "continue"); // 2-й
  now += 1_400;
  assert.equal(detector.push({ busy: false, sendIdle: true, text: "готово" }, now), "continue"); // 3-й, но окно не заполнено (2,8 с < 3 с)
  now += 400;
  assert.equal(detector.push({ busy: false, sendIdle: true, text: "готово" }, now), "complete"); // окно 3,2 с
});

test("вторичные признаки обязательны: sendIdle=false блокирует решение", () => {
  const detector = new CompletionDetector(new SeededRandom(3), 3_000);
  let now = 0;
  for (let i = 0; i < 5; i++) {
    now += 1_500;
    assert.equal(detector.push({ busy: false, sendIdle: false, text: "стабильно" }, now), "continue");
  }
});

test("усиление по сетевому стриму: streamIdle=false блокирует (birdview §3)", () => {
  const detector = new CompletionDetector(new SeededRandom(4), 3_000);
  let now = 0;
  for (let i = 0; i < 5; i++) {
    now += 1_500;
    assert.equal(detector.push({ busy: false, sendIdle: true, text: "стабильно", streamIdle: false }, now), "continue");
  }
  now += 1_500;
  assert.equal(detector.push({ busy: false, sendIdle: true, text: "стабильно", streamIdle: true }, now), "complete");
});

test("изменение текста обнуляет стабильность", () => {
  const detector = new CompletionDetector(new SeededRandom(5), 3_000);
  let now = 0;
  now += 1_400;
  detector.push({ busy: false, sendIdle: true, text: "а" }, now);
  now += 1_400;
  detector.push({ busy: false, sendIdle: true, text: "а" }, now);
  now += 1_400;
  assert.equal(detector.push({ busy: false, sendIdle: true, text: "а б" }, now), "continue"); // текст сменился
  now += 1_400;
  assert.equal(detector.push({ busy: false, sendIdle: true, text: "а б" }, now), "continue");
});

test("окно случайное в границах 3–5 с; опросы рандомизированы вокруг базы (П-5)", () => {
  for (const seed of [10, 11, 12]) {
    const detector = new CompletionDetector(new SeededRandom(seed));
    const poll = detector.nextPollMs(1_500);
    assert.ok(poll >= 1_500 * 0.6 && poll <= 1_500 * 1.4, `опрос ${poll} вне разброса`);
  }
});
