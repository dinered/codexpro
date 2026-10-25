// У-3: порционный ввод — разбивка на порции (конкатенция = исходный текст, Ф-4)
// и разбор BRIDGE_INPUT_MODE (Д-5: все переменные в одном месте).

import assert from "node:assert/strict";
import { test } from "node:test";
import { splitChunks } from "../../src/bridge/turn.ts";
import { bridgeConfigFromEnv } from "../../src/config.ts";

test("splitChunks: предложения с сохранением разделителей (У-3)", () => {
  const text = "Первое предложение. Второе! Третий вопрос? Четвёртый…";
  const chunks = splitChunks(text);
  assert.equal(chunks.length, 4);
  assert.equal(chunks.join(""), text, "конкатенция порций равна исходному тексту (Ф-4)");
});

test("splitChunks: сокращения и кавычки не рвут предложение зря", () => {
  // «т.д.» без пробела после точки внутри слова — граница только там, где за точкой пробел
  const text = "Пункт первый, и т.д. Пункт второй.";
  const chunks = splitChunks(text);
  assert.deepEqual(chunks, ["Пункт первый, и т.д. ", "Пункт второй."]);
  assert.equal(chunks.join(""), text);
});

test("splitChunks: длинное предложение режется по словам, текст сохраняется", () => {
  const text = "слово ".repeat(60).trimEnd() + "."; // 366 символов одним предложением
  const chunks = splitChunks(text, 200);
  assert.ok(chunks.length > 1, "длинный текст не едет одной порцией");
  assert.equal(chunks.join(""), text, "срез по словам сохраняет текст");
  for (const chunk of chunks) assert.ok(chunk.length <= 200, `порция длиннее лимита: ${chunk.length}`);
});

test("splitChunks: многострочный текст — переносы внутри порций (Shift+Enter)", () => {
  const text = "Строка раз.\nСтрока два.\nСтрока три.";
  const chunks = splitChunks(text);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks[0]!.endsWith("\n"), "перевод строки остаётся с предложением");
});

test("splitChunks: пустой и короткий текст — одна порция", () => {
  assert.deepEqual(splitChunks(""), [""]);
  assert.deepEqual(splitChunks("одна фраза без точки"), ["одна фраза без точки"]);
});

test("BRIDGE_INPUT_MODE: instant по умолчанию, chunks валиден, мусор — ошибка (Д-5)", () => {
  const base = { BRIDGE_SPOOL: "/tmp/spool" };
  assert.equal(bridgeConfigFromEnv("/tmp/spool", base).inputMode, "instant");
  assert.equal(bridgeConfigFromEnv("/tmp/spool", { ...base, BRIDGE_INPUT_MODE: "chunks" }).inputMode, "chunks");
  assert.throws(
    () => bridgeConfigFromEnv("/tmp/spool", { ...base, BRIDGE_INPUT_MODE: "turbo" }),
    /BRIDGE_INPUT_MODE=turbo/,
  );
});
