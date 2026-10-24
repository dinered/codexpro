// task.json — постановка хода плагином и чтение мостом (birdview §2).
// Создаётся атомарно (tmp + rename), поэтому мост никогда не видит половину файла.

import { readFile, stat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "./atomic.ts";
import { TASK_FILE } from "./names.ts";
import { isErrno } from "../core/errors.ts";
import type { TurnTask } from "../core/types.ts";

/** Поставить задачу: каталог хода + task.json атомарно. Возвращает id. */
export async function putTask(root: string, task: TurnTask): Promise<string> {
  const dir = join(root, task.id);
  await mkdir(dir, { recursive: true });
  await writeAtomic(dir, TASK_FILE, JSON.stringify(task, null, "\t") + "\n");
  return task.id;
}

export type TaskRead = { ok: true; task: TurnTask } | { ok: false; reason: "missing" | "broken" };

/**
 * Прочитать задачу и сверить с каталогом. broken — битый элемент очереди:
 * мост пропускает его с предупреждением (Ф-3), не останавливаясь.
 */
export async function readTask(dir: string, id: string): Promise<TaskRead> {
  let raw: string;
  try {
    const info = await stat(join(dir, TASK_FILE));
    if (!info.isFile()) return { ok: false, reason: "broken" };
    raw = await readFile(join(dir, TASK_FILE), "utf8");
  } catch (error) {
    // только ENOENT — «ход ещё пишется»; недоступность spool — наружу как фатальная (birdview §3)
    if (isErrno(error, "ENOENT")) return { ok: false, reason: "missing" };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "broken" };
  }
  const task = parsed as TurnTask | null;
  if (
    !task ||
    typeof task !== "object" ||
    task.v !== 3 ||
    typeof task.id !== "string" ||
    task.id !== id ||
    typeof task.createdAt !== "number" ||
    typeof task.traceId !== "string" ||
    typeof task.text !== "string"
  ) {
    return { ok: false, reason: "broken" };
  }
  return { ok: true, task };
}
