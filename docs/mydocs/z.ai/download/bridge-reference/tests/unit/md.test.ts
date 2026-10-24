// Конвертер HTML → markdown (Ф-5) и сверка текста «без разметки» (Ф-4).
// Оговорённые потери проверяются тут же: картинки пропадают, блоки в ячейках склеиваются.

import assert from "node:assert/strict";
import { test } from "node:test";
import { htmlToMarkdown, normalizeText } from "../../src/md/markdown.ts";

test("абзацы, заголовки, инлайн-разметка", () => {
  const md = htmlToMarkdown("<h2>План</h2><p>Первый <strong>жирный</strong> и <em>наклонный</em>.</p><p>Второй абзац.</p>");
  assert.equal(md, "## План\n\nПервый **жирный** и _наклонный_.\n\nВторой абзац.");
});

test("список: маркеры, плотные пункты, продолжение с отступом (CommonMark)", () => {
  const md = htmlToMarkdown(
    "<ul><li>первый</li><li>второй<p>с абзацем</p><p>и ещё</p></li></ul>",
  );
  assert.equal(md, "- первый\n- второй\n\n  с абзацем\n\n  и ещё");
});

test("нумерованный список уважает start", () => {
  const md = htmlToMarkdown('<ol start="3"><li>три</li><li>четыре</li></ol>');
  assert.equal(md, "3. три\n4. четыре");
});

test("код: фенс длиннее внутреннего забора, язык из class", () => {
  const md = htmlToMarkdown('<pre><code class="language-js">const a = `x`;</code></pre>');
  assert.equal(md, "```js\nconst a = `x`;\n```");
  const tricky = htmlToMarkdown("<pre><code>```\nдвойной фенс</code></pre>");
  assert.match(tricky, /^````\n/); // четыре тильды... нет — четыре бэктика
});

test("таблица: разделители, экранирование пайпов; блоки в ячейках склеиваются (оговорённая потеря)", () => {
  const md = htmlToMarkdown("<table><tr><th>имя</th><th>зн|ачение</th></tr><tr><td>раз<div>склеили</div></td><td>2</td></tr></table>");
  const lines = md.split("\n");
  assert.equal(lines[0], "| имя | зн\\|ачение |");
  assert.equal(lines[1], "| --- | --- |");
  assert.equal(lines[2], "| разсклеили | 2 |");
});

test("цитата, линия, ссылка", () => {
  const md = htmlToMarkdown("<blockquote><p>мысль</p></blockquote><hr><p><a href=\"https://x\">ссыл</a></p>");
  assert.equal(md, "> мысль\n\n---\n\n[ссыл](https://x)");
});

test("оговорённые потери: картинки пропадают, кнопки не текст (Ф-5, README)", () => {
  const md = htmlToMarkdown("<p>до<img src=\"x.png\">после</p><p><button>копировать</button>текст</p>");
  assert.equal(md, "допосле\n\nтекст");
});

test("normalizeText (Ф-4, правило Д-7): экранирование снято, пробелы схлопнуты, разметка остаётся (R13)", () => {
  // литеральные символы не выбрасываются — разные тексты не «склеиваются» сверкой
  assert.equal(normalizeText("2 * 3 = 6"), "2 * 3 = 6");
  assert.notEqual(normalizeText("2 * 3"), normalizeText("2 3"));
  // переводы строк и CRLF — к одному пробелу
  assert.equal(normalizeText("a\n\nb"), normalizeText("a b"));
  assert.equal(normalizeText("a\r\nb"), normalizeText("a b"));
  assert.equal(normalizeText("a\t b"), "a b");
  // платформенное экранирование снято
  assert.equal(normalizeText("\\*не маркер\\*"), "*не маркер*");
  assert.equal(normalizeText("\\_подчёрк_"), "_подчёрк_");
  // разметка и служебные символы сохраняются как есть
  assert.equal(normalizeText("> цитата #тег"), "> цитата #тег");
  assert.equal(normalizeText("https://x/~a#b"), "https://x/~a#b");
  assert.equal(normalizeText("привет  *мир* `код`"), "привет *мир* `код`");
  assert.notEqual(normalizeText("разные"), normalizeText("тексты"));
});

test("инлайн-код и ссылки переносятся (Ф-5, R14)", () => {
  const md = htmlToMarkdown("<p>формула <code>a &lt; b</code> и <a href=\"https://x/~#\">ссылка</a></p>");
  assert.equal(md, "формула `a < b` и [ссылка](https://x/~#)");
});

test("таблица с секциями: заголовок из thead, строки не задваиваются (R14)", () => {
  const md = htmlToMarkdown(
    "<table><thead><tr><th>имя</th><th>значение</th></tr></thead><tbody><tr><td>раз</td><td>2</td></tr><tr><td>два</td><td>3</td></tr></tbody></table>",
  );
  const lines = md.split("\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[0], "| имя | значение |");
  assert.equal(lines[2], "| раз | 2 |");
  assert.equal(lines[3], "| два | 3 |");
});

test("вложенная таблица спрямляется в ячейке внешней (оговорённая потеря, R14)", () => {
  const md = htmlToMarkdown(
    "<table><tr><th>внеш</th></tr><tr><td>до<table><tr><td>внутр</td></tr></table>после</td></tr></table>",
  );
  const lines = md.split("\n");
  assert.equal(lines.length, 3, "строки внутренней таблицы не развели внешнюю");
  assert.equal(lines[2], "| довнутрпосле |");
});

test("figure/aside/details — блоки: содержимое не теряется и не склеивается с соседями", () => {
  const md = htmlToMarkdown("<p>до</p><aside>замечание</aside><p>после</p>");
  assert.equal(md, "до\n\nзамечание\n\nпосле");
});
