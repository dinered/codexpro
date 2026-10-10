// Сверка каталога docs/training-vs-production.md с метками учебных отличий в репозитории.
// Без сети и зависимостей, нужен git: node --test tools/docs-check/markers.test.mjs
// Проверяется рабочая копия: файлы из git и новые, ещё не добавленные (git ls-files --cached --others
// --exclude-standard), без игнорируемых. Так проверка до коммита и после него даёт один результат.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const git = (args, cwd = import.meta.dirname) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" });
  } catch (error) {
    throw new Error(`проверке нужен git-клон репозитория: git ${args.join(" ")} — ${error.message}`);
  }
};

const ROOT = git(["rev-parse", "--show-toplevel"]).trim();
const CATALOG = "docs/training-vs-production.md";
// сам скрипт: префикс метки в нём — данные, а не метка (git отдаёт пути через «/» на любой ОС)
const SELF = relative(ROOT, import.meta.filename).split(sep).join("/");
const TAG = ["#учебно", "не", "боевое"].join("-");
const MARK = new RegExp(`${TAG}-(\\d{2,})(?!\\d)`, "g");

const catalog = readFileSync(join(ROOT, CATALOG), "utf8");

// Разделы каталога: «### NN. Заголовок» и абзац «**Где:** `путь`, `путь`» (может переноситься на следующие строки).
// Снятый раздел — «### NN. (снято) …»: номер занят навсегда, меток на него быть не должно.
const sections = [...catalog.matchAll(/^### (\d{2,})\. (.+)$/gm)].map((m, i, all) => {
  const body = catalog.slice(m.index, all[i + 1]?.index ?? catalog.length);
  const where = /^\*\*Где:\*\* ([\s\S]*?)(?:\n\s*\n|(?![\s\S]))/m.exec(body)?.[1] ?? ""; // до пустой строки или конца
  return {
    id: m[1],
    heading: `${m[1]}. ${m[2]}`,
    retired: m[2].startsWith("(снято)"),
    where: [...where.matchAll(/`([^`]+)`/g)].map((w) => w[1]).sort(),
  };
});
const active = sections.filter((s) => !s.retired);
const byNumber = (a, b) => Number(a) - Number(b);

// Метки в файлах рабочей копии, кроме каталога и самого скрипта: номер → файлы.
// пути ls-files — от каталога запуска, поэтому запуск из корня
const files = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], ROOT)
  .split("\0")
  .filter((file) => file && file !== CATALOG && file !== SELF && !file.endsWith("package-lock.json"));
const marks = new Map();
const bare = [];
for (const file of new Set(files)) {
  let text;
  try {
    text = readFileSync(join(ROOT, file), "utf8");
  } catch {
    continue; // удалён в рабочей копии, но ещё в индексе
  }
  for (const m of text.matchAll(MARK)) marks.set(m[1], new Set([...(marks.get(m[1]) ?? []), file]));
  // в коде метка всегда с номером; в markdown допустимы пояснения вида `#учебно-не-боевое-NN`
  if (!file.endsWith(".md") && text.replace(MARK, "").includes(TAG)) bare.push(file);
}

test("номера разделов не повторяются и идут без пропусков от 01", () => {
  assert.ok(sections.length > 0, `в ${CATALOG} нет разделов «### NN. …»`);
  const ids = sections.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, `номера повторяются: ${ids.join(", ")}`);
  assert.deepEqual(
    [...ids].sort(byNumber),
    ids.map((_, i) => String(i + 1).padStart(2, "0")),
  );
});

test("у каждого действующего раздела есть строка «Где» и хотя бы одна метка в репозитории", () => {
  for (const s of active) {
    assert.ok(s.where.length, `${s.id}: нет строки **Где:**`);
    assert.ok(marks.has(s.id), `«${s.heading}»: метки ${TAG}-${s.id} нет ни в одном файле`);
  }
});

test("«Где» совпадает с файлами, в которых стоит метка", () => {
  for (const s of active) {
    assert.deepEqual([...(marks.get(s.id) ?? [])].sort(), s.where, `«${s.heading}»`);
  }
});

test("метки ссылаются только на существующие и не снятые разделы", () => {
  const known = new Set(active.map((s) => s.id));
  const retired = new Set(sections.filter((s) => s.retired).map((s) => s.id));
  for (const [id, where] of marks) {
    const why = retired.has(id) ? "раздел снят — уберите метку" : "такого раздела нет";
    assert.ok(known.has(id), `${TAG}-${id} в ${[...where].join(", ")}: ${why}`);
  }
});

test("в коде метка всегда с номером", () => {
  assert.deepEqual(bare, []);
});

// Якоря заголовков. GitHub: строчные, всё кроме букв, цифр, «_», «-» и пробела выбрасывается, пробел → «-».
// GitLab: то же, а затем «--» и длиннее сжимаются в «-». Ссылка должна работать на обеих площадках.
const github = (heading) =>
  heading.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "").replace(/ /g, "-");
const gitlab = (heading) => github(heading).replace(/-{2,}/g, "-");

test("якорь каждого раздела одинаков на GitHub и GitLab", () => {
  for (const s of sections) {
    assert.equal(
      github(s.heading),
      gitlab(s.heading),
      `«${s.heading}»: на GitHub якорь ${github(s.heading)}, на GitLab ${gitlab(s.heading)} — уберите знак препинания между пробелами (« — », « → », « / ») или двойной пробел`,
    );
  }
});

test("сводная таблица: по строке на раздел, по порядку номеров, ссылка — на свой раздел", () => {
  const rows = [...catalog.matchAll(/^\| \[(\d{2,})\]\(#([^)]+)\) \|/gm)].map((m) => ({ id: m[1], link: m[2] }));
  assert.deepEqual(
    rows.map((r) => r.id),
    sections.map((s) => s.id).sort(byNumber),
  );
  for (const r of rows) {
    const s = sections.find((x) => x.id === r.id);
    assert.equal(r.link, github(s.heading), `строка ${r.id} ведёт не на «${s.heading}»`);
  }
});
