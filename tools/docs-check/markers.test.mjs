// Сверка каталога docs/training-vs-production.md с метками #учебно-не-боевое-NN в репозитории.
// Без сети и зависимостей: node --test tools/docs-check/markers.test.mjs
// Источник файлов — git ls-files: проверяется то, что попадёт в коммит, а не node_modules и мусор рабочей копии.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: import.meta.dirname, encoding: "utf8" }).trim();
const CATALOG = "docs/training-vs-production.md";
const TAG = "#учебно-не-боевое";
const MARK = new RegExp(`${TAG}-(\\d{2})(?!\\d)`, "g");

const catalog = readFileSync(join(ROOT, CATALOG), "utf8");

// Разделы каталога: «### NN. Заголовок» и строка «**Где:** `путь`, `путь`».
const sections = [...catalog.matchAll(/^### (\d{2})\. (.+)$/gm)].map((m, i, all) => {
  const body = catalog.slice(m.index, all[i + 1]?.index ?? catalog.length);
  const where = /^\*\*Где:\*\* (.+)$/m.exec(body)?.[1] ?? "";
  return { id: m[1], title: m[2], where: [...where.matchAll(/`([^`]+)`/g)].map((w) => w[1]).sort() };
});

// Метки в файлах репозитория, кроме самого каталога: номер → файлы.
const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter((file) => file && file !== CATALOG && !file.endsWith("package-lock.json"));
const marks = new Map();
const bare = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(join(ROOT, file), "utf8");
  } catch {
    continue; // ссылка на каталог, удалённый в рабочей копии файл
  }
  for (const m of text.matchAll(MARK)) marks.set(m[1], new Set([...(marks.get(m[1]) ?? []), file]));
  // в коде метка всегда с номером; в markdown допустимы пояснения вида `#учебно-не-боевое-NN`
  if (!file.endsWith(".md") && text.replace(MARK, "").includes(TAG)) bare.push(file);
}

test("номера разделов идут подряд с 01 и не повторяются", () => {
  assert.ok(sections.length > 0, `в ${CATALOG} нет разделов «### NN. …»`);
  assert.deepEqual(
    sections.map((s) => s.id),
    sections.map((_, i) => String(i + 1).padStart(2, "0")),
  );
});

test("у каждого раздела есть строка «Где» и хотя бы одна метка в репозитории", () => {
  for (const s of sections) {
    assert.ok(s.where.length, `${s.id}: нет строки **Где:**`);
    assert.ok(marks.has(s.id), `${s.id} «${s.title}»: метки ${TAG}-${s.id} нет ни в одном файле`);
  }
});

test("«Где» совпадает с файлами, в которых стоит метка", () => {
  for (const s of sections) {
    assert.deepEqual([...(marks.get(s.id) ?? [])].sort(), s.where, `${s.id} «${s.title}»`);
  }
});

test("метки ссылаются только на существующие разделы", () => {
  const known = new Set(sections.map((s) => s.id));
  for (const [id, where] of marks) assert.ok(known.has(id), `${TAG}-${id} в ${[...where].join(", ")}: такого раздела нет`);
});

test("в коде метка всегда с номером", () => {
  assert.deepEqual(bare, []);
});

// Якоря сводной таблицы — по правилам GitHub и GitLab: строчные, без знаков препинания, пробел → «-».
test("ссылки сводной таблицы ведут на заголовки разделов", () => {
  const slug = (title) => title.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/ /g, "-");
  const anchors = new Set([...catalog.matchAll(/^#{2,3} (.+)$/gm)].map((m) => slug(m[1])));
  const links = [...catalog.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
  assert.equal(links.length, sections.length, "в сводной таблице — по ссылке на каждый раздел");
  for (const link of links) assert.ok(anchors.has(link), `нет заголовка для #${link}`);
});
