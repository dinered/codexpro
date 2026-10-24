// Имена протокола v3 (birdview §2). Каталог хода spool/<id>/, где
// id = время постановки UTC + случайный суффикс: очередь — по id (FIFO),
// тай-брейк равных секунд — по createdAt из task.json.

import type { Random } from "../core/random.ts";

export const TASK_FILE = "task.json";
export const ALIVE_FILE = "alive";
export const CANCEL_FILE = "cancel";
export const RESULT_FILE = "result.json";
export const ACK_FILE = "result.ack";
export const JOURNAL_FILE = "journal.jsonl";
export const CLAIM_PREFIX = "claim.";
export const LEASE_PREFIX = "lease.";
export const STATE_PREFIX = "state.";

const SUFFIX_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz"; // без 0/1 — не путаются глазами
const SUFFIX_LENGTH = 6;

/** Новый id хода: 20261023T101500Z-k3m9x2 — сортировка по строке = порядок очереди. */
export function newTurnId(nowMs: number, rand: Random): string {
  const d = new Date(nowMs);
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  const stamp =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  let suffix = "";
  for (let i = 0; i < SUFFIX_LENGTH; i++) suffix += SUFFIX_ALPHABET[rand.int(SUFFIX_ALPHABET.length)];
  return `${stamp}-${suffix}`;
}

export interface ParsedTurnId {
  stamp: string; // 20261023T101500Z
  suffix: string;
}

export function parseTurnId(id: string): ParsedTurnId | null {
  const match = /^(\d{8}T\d{6}Z)-([2-7a-z]{6})$/.exec(id);
  return match ? { stamp: match[1]!, suffix: match[2]! } : null;
}

/** Эпоха из имени claim.3 / lease.3 / state.3; null — имя не эпохи. */
export function epochOf(name: string, prefix: string): number | null {
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  if (!/^\d+$/.test(rest)) return null;
  return Number(rest);
}
