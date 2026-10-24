// alive — живость плагина (birdview §2): плагин обновляет mtime каждые 10 с,
// молчание дольше 70 с (2 × LEASE_MS) — ход снят плагином. Мост не работает
// с ходом, чей плагин умер: результата никто не прочитает.

import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pulse } from "./atomic.ts";
import { ALIVE_FILE, CANCEL_FILE } from "./names.ts";
import { isErrno } from "../core/errors.ts";
import type { Clock } from "../core/clock.ts";

/** Возраст пульса плагина; null — пульса нет вовсе (task.json ещё пишется или битый ход). */
export async function aliveAge(dir: string, clock: Clock): Promise<number | null> {
  let info;
  try {
    info = await stat(join(dir, ALIVE_FILE));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error; // недоступность spool — не «плагин молчит» (birdview §3)
  }
  return Math.max(0, clock.now() - info.mtimeMs);
}

/** Плагин на связи? Отсутствие файла трактуем как молчание — ход не берём. */
export async function aliveFresh(dir: string, ttlMs: number, clock: Clock): Promise<boolean> {
  const age = await aliveAge(dir, clock);
  return age !== null && age <= ttlMs;
}

/** Сторона плагина: пульс живости (каждые 10 с, пока ход в работе); первый пульс создаёт файл. */
export async function touchAlive(dir: string, clock: Clock): Promise<void> {
  await pulse(join(dir, ALIVE_FILE), clock.now());
}

/** Сторона плагина: маркер отмены («Стоп» в Paseo, Ф-1). Время — из Clock (Ф-8, тестируемость). */
export async function markCancelled(dir: string, clock: Clock): Promise<void> {
  await writeFile(join(dir, CANCEL_FILE), `${new Date(clock.now()).toISOString()}\n`, { flag: "wx" }).catch(() => {});
}

/** Проверка маркера отмены. */
export async function isCancelled(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, CANCEL_FILE));
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}
