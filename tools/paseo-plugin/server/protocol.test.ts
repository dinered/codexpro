import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquire, fileName, isFresh, LEASE_MS, owns, parseName, readRegular, release, writeAtomic } from "./protocol";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const tempDir = () => mkdtemp(join(tmpdir(), "protocol-"));
const age = (path: string, ms: number) => {
  const time = new Date(Date.now() - ms);
  return utimes(path, time, time);
};

describe("протокол v2", () => {
  it("имена файлов: сборка и разбор, чужое — null", () => {
    for (const kind of ["task", "claim", "reply", "error"] as const) {
      expect(parseName(fileName(kind, ID))).toEqual({ kind, id: ID });
    }
    for (const name of [`claim-${ID}.md`, `task-${ID}`, `.task-${ID}.md.1.x.tmp`, "task.md", `task-${ID.toUpperCase()}.md`]) {
      expect(parseName(name)).toBeNull();
    }
  });

  it("writeAtomic: пишет целиком, не оставляет временных файлов, ссылку заменяет, а не пишет по ней", async () => {
    const dir = await tempDir();
    const outside = join(dir, "outside.txt");
    await writeFile(outside, "не трогать");
    await symlink(outside, join(dir, "reply.md"));

    await writeAtomic(join(dir, "reply.md"), "ответ");

    expect(await readFile(outside, "utf8")).toBe("не трогать");
    expect(await readRegular(join(dir, "reply.md"))).toBe("ответ");
    expect((await readdir(dir)).sort()).toEqual(["outside.txt", "reply.md"]);
  });

  it("readRegular: нет файла — null, ссылка вместо файла — ошибка, FIFO — ошибка без зависания", async () => {
    const dir = await tempDir();
    expect(await readRegular(join(dir, "nope"))).toBeNull();
    await writeFile(join(dir, "secret"), "ключ");
    await symlink(join(dir, "secret"), join(dir, "task.md"));
    await expect(readRegular(join(dir, "task.md"))).rejects.toThrow(/ссылка/);
    execFileSync("mkfifo", [join(dir, "reply.md")]);
    await expect(readRegular(join(dir, "reply.md"))).rejects.toThrow(/не обычный файл/);
  });

  it("isFresh: свежий файл — да; старый, ссылка или нет файла — нет", async () => {
    const dir = await tempDir();
    const file = join(dir, "task.md");
    expect(await isFresh(file)).toBe(false);
    await writeFile(file, "задача");
    expect(await isFresh(file)).toBe(true);
    await symlink(file, join(dir, "link.md"));
    expect(await isFresh(join(dir, "link.md"))).toBe(false);
    await age(file, LEASE_MS + 1000);
    expect(await isFresh(file)).toBe(false);
  });

  it("acquire: живой захват не отдаёт, брошенный перехватывает; release снимает только своё", async () => {
    const dir = await tempDir();
    const claim = join(dir, fileName("claim", ID));
    expect(await acquire(claim, "A")).toBe("created");
    expect(await acquire(claim, "B")).toBe(false);
    expect(await owns(claim, "A")).toBe(true);

    await age(claim, LEASE_MS + 1000);
    expect(await acquire(claim, "B")).toBe("taken-over");
    expect(await owns(claim, "A")).toBe(false);

    await release(claim, "A");
    expect(await owns(claim, "B")).toBe(true);
    await release(claim, "B");
    expect(await readRegular(claim)).toBeNull();
  });
});
