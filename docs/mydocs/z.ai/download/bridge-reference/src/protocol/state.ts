// state.<N> — фаза хода для эпохи N (birdview §2). Записывается атомарно
// (tmp + rename + fsync); каждая запись сверяет эпоху: расхождение — утрата
// владения (фатально, birdview §3).

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "./atomic.ts";
import { STATE_PREFIX } from "./names.ts";
import { isErrno } from "../core/errors.ts";
import { PHASES, type Phase } from "../core/types.ts";

function isValidPhase(value: string): value is Phase {
  return (PHASES as readonly string[]).includes(value);
}

export async function writeState(dir: string, epoch: number, phase: Phase): Promise<void> {
  await writeAtomic(dir, `${STATE_PREFIX}${epoch}`, `${phase}\n`);
}

/** Фаза конкретной эпохи; null — эпоха не дошла до записи фазы. */
export async function readState(dir: string, epoch: number): Promise<Phase | null> {
  let raw: string | null = null;
  try {
    raw = await readFile(join(dir, `${STATE_PREFIX}${epoch}`), "utf8");
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error; // недоступность spool — не «фазы нет» (birdview §3)
  }
  if (raw === null) return null;
  const phase = raw.trim();
  return isValidPhase(phase) ? phase : null;
}

export interface LatestState {
  epoch: number;
  phase: Phase;
}

/**
 * Фаза максимальной эпохи — первое, что читает перехватчик: если ход уже
 * за точкой невозврата (sending и позже), повторная отправка запрещена (Н-1).
 */
export async function readLatestState(dir: string): Promise<LatestState | null> {
  let max = 0;
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.startsWith(STATE_PREFIX)) continue;
    const epoch = Number(name.slice(STATE_PREFIX.length));
    if (Number.isInteger(epoch) && epoch > max) max = epoch;
  }
  if (max === 0) return null;
  const phase = await readState(dir, max);
  if (phase === null) return null;
  return { epoch: max, phase };
}

/** Есть ли файл фазы эпохи вообще (без чтения содержимого). */
export async function stateExists(dir: string, epoch: number): Promise<boolean> {
  return !!(await stat(join(dir, `${STATE_PREFIX}${epoch}`)).catch(() => null));
}
