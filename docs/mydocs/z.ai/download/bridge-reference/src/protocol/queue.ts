// Очередь ходов (Ф-3): старые первыми — по id (время UTC в имени), тай-брейк
// равных секунд — по createdAt из task.json. Битые элементы (не каталоги,
// без task.json, с несверяющимся id) пропускаются с предупреждением —
// решение о них принимает вызывающая сторона (журнал моста).

import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { readTask } from "./task.ts";
import { hasAck, readResultOutcome } from "./result.ts";
import { parseTurnId } from "./names.ts";
import type { TurnTask } from "../core/types.ts";

export interface QueueEntry {
  task: TurnTask;
  dir: string;
}

export interface ScanResult {
  /** Ходы без результата, отсортированные по очереди. */
  pending: QueueEntry[];
  /** Битые элементы очереди: {id, причина} — вызывающий предупреждает и больше не трогает. */
  broken: Array<{ id: string; reason: string }>;
}

/**
 * Один проход по spool: каталоги с task.json и без закрытия (нет result.json,
 * нет result.ack). Каталог без task.json — ход ещё пишется или сломан; в оба
 * случая сюда не претендуем. Битый result.json — закрытым ход НЕ считается:
 * элемент уходит в broken с причиной, а не в очередь и не в молчаливый пропуск.
 */
export async function scanQueue(root: string): Promise<ScanResult> {
  const pending: QueueEntry[] = [];
  const broken: ScanResult["broken"] = [];
  const entries: Dirent[] = await readdir(root, { withFileTypes: true }); // ENOENT наружу: spool недоступен — фатально (birdview §3)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    if (!parseTurnId(id)) {
      broken.push({ id, reason: "имя каталога не соответствует формату id" });
      continue;
    }
    const dir = join(root, id);
    if (await hasAck(dir)) continue; // подтверждён плагином — закрыт, ждёт удаления; «воскреснуть» не может
    const result = await readResultOutcome(dir);
    if (result.kind === "corrupt") {
      // битый результат — не «ход закрыт» и не «хода нет»: явная битость с событием в журнал (Н-1)
      broken.push({ id, reason: `result.json повреждён (${result.reason})` });
      continue;
    }
    if (result.kind === "ok") continue; // результат записан — закрыт, плагин подтвердит
    const read = await readTask(dir, id);
    if (!read.ok) {
      if (read.reason === "broken") broken.push({ id, reason: "task.json не разобрать или не сходится с каталогом" });
      continue; // missing — ход ещё создаётся, это не битость
    }
    pending.push({ task: read.task, dir });
  }
  pending.sort((a, b) => {
    const stampA = parseTurnId(a.task.id)!.stamp;
    const stampB = parseTurnId(b.task.id)!.stamp;
    if (stampA !== stampB) return stampA < stampB ? -1 : 1; // FIFO по id
    if (a.task.createdAt !== b.task.createdAt) return a.task.createdAt - b.task.createdAt; // тай-брейк
    return a.task.id < b.task.id ? -1 : 1;
  });
  return { pending, broken };
}
