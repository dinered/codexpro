// Атомарные операции над файлами хода — единственное место, знающее про tmp+rename+fsync.
// Протокол v3 требует: task.json и state.<N> пишутся атомарно, result.json и claim.<N>
// создаются эксклюзивно (O_EXCL), пульсы (alive, lease.<N>) — обновлением mtime.

import { open, rename, utimes } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

/** Атомарная запись: tmp → fsync файла → rename → fsync каталога (birdview §2). */
export async function writeAtomic(dir: string, name: string, data: string): Promise<void> {
  const tmp = join(dir, `.${name}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fh = await open(tmp, "wx", 0o644);
  try {
    await fh.writeFile(data, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, join(dir, name));
  await fsyncDir(dir);
}

/** Эксклюзивное создание (O_EXCL): true — файл наш, false — уже существует (кто-то опередил). */
export async function createExclusive(path: string, data: string): Promise<boolean> {
  try {
    const fh = await open(path, "wx", 0o644);
    try {
      await fh.writeFile(data, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsyncDir(dirname(path));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/**
 * Обновить mtime — пульс живости (alive плагина, lease.<N> моста).
 * Время берётся из часов вызывающей стороны: в бою — системные, в тестах —
 * подставные. Пишущий и читающий согласованы об одном времени в любой среде.
 */
export async function touch(path: string, atMs: number): Promise<void> {
  const at = new Date(atMs);
  await utimes(path, at, at);
}

/**
 * Пульс живости: создать файл (если его ещё нет) и поставить mtime на момент atMs.
 * utimes не создаёт файлы, поэтому первый пульс идёт через open("a").
 * Без fsync: содержимое пустое и не меняется — значим только mtime, а fsync
 * на каждом пульсе делает тысячи сбросов на диск за прогон.
 */
export async function pulse(path: string, atMs: number): Promise<void> {
  const fh = await open(path, "a");
  await fh.close();
  await touch(path, atMs);
}

async function fsyncDir(dir: string): Promise<void> {
  // fsync каталога — страховка от потери rename при отключении питания; где не поддерживается — молча пропускаем
  try {
    const fh = await open(dir, "r");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    /* каталог может не открываться на чтение — это не ошибка записи */
  }
}
