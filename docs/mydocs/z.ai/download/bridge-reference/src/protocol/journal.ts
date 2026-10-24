// journal.jsonl — журнал идемпотентности: task_id, фактически ушедшие в платформу
// (birdview §2). Порядок точки невозврата: state=sending → запись в журнал (fsync) →
// клик. Отсюда два следствия: перед отправкой журнал проверяется (task_id уже есть —
// IDEMPOTENCY_REJECT без открытия браузера), а падение между журналом и кликом даёт
// IDEMPOTENCY_REJECT для неотправленного хода — осознанная цена запрета дубля (Н-1).

import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { JOURNAL_FILE } from "./names.ts";

export type JournalCheck = "absent" | "present" | "corrupt";

interface JournalLine {
  ts: number;
  taskId: string;
}

/** Проверка журнала хода перед работой с платформой. */
export async function checkJournal(dir: string, taskId: string): Promise<JournalCheck> {
  const raw = await readFile(join(dir, JOURNAL_FILE), "utf8").catch(() => null);
  if (raw === null) return "absent";
  let seen = false;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: JournalLine;
    try {
      parsed = JSON.parse(line) as JournalLine;
    } catch {
      return "corrupt"; // ретроградно не переписываем — решение за оператором (birdview §3)
    }
    if (typeof parsed?.taskId !== "string") return "corrupt";
    if (parsed.taskId === taskId) seen = true;
  }
  return seen ? "present" : "absent";
}

/** Зафиксировать отправку. Вызывается строго между state=sending и нажатием кнопки. */
export async function journalSend(dir: string, taskId: string, ts: number): Promise<void> {
  const fh = await open(join(dir, JOURNAL_FILE), "a");
  try {
    await fh.writeFile(JSON.stringify({ ts, taskId } satisfies JournalLine) + "\n", "utf8");
    await fh.sync(); // fsync до клика: падение между journal и кликом должно оставить след
  } finally {
    await fh.close();
  }
}

/** Сколько отправок зафиксировано (модельный тест Н-1: не более одной). */
export async function journalSize(dir: string): Promise<number> {
  const info = await stat(join(dir, JOURNAL_FILE)).catch(() => null);
  if (!info) return 0;
  const raw = await readFile(join(dir, JOURNAL_FILE), "utf8").catch(() => "");
  return raw.split("\n").filter((line) => line.trim()).length;
}
