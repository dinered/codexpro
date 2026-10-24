// result.json + result.ack — ответ хода (birdview §2).
// Мост создаёт result.json ровно один раз (O_EXCL) — инвариант Н-1 «ответ ровно
// один раз» держится даже при гонке двух мостов. Плагин атомарно переименовывает
// result.json в result.ack после прочтения; каталог хода удаляется после ack.

import { readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { createExclusive } from "./atomic.ts";
import { ACK_FILE, RESULT_FILE } from "./names.ts";
import { isErrno } from "../core/errors.ts";
import type { Clock } from "../core/clock.ts";
import { RESULT_STATUSES, type TurnResult } from "../core/types.ts";

function serialize(result: TurnResult): string {
  // markdown и message — последними полями: человек читает журнал каталога глазами
  const head: Record<string, unknown> = { status: result.status, traceId: result.traceId };
  if (result.code !== undefined) head.code = result.code;
  if (result.message !== undefined) head.message = result.message;
  if (result.markdown !== undefined) head.markdown = result.markdown;
  return JSON.stringify(head, null, "\t") + "\n";
}

/** Эксклюзивная запись результата. false — результат уже создан (наш ход проиграл гонку). */
export async function writeResult(dir: string, result: TurnResult): Promise<boolean> {
  return createExclusive(join(dir, RESULT_FILE), serialize(result));
}

/** stat → true/false строго по ENOENT: недоступность spool — не «файла нет» (birdview §3). */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

export async function hasResult(dir: string): Promise<boolean> {
  return exists(join(dir, RESULT_FILE));
}

export async function hasAck(dir: string): Promise<boolean> {
  return exists(join(dir, ACK_FILE));
}

/** Итог чтения result.json: файла нет / повреждён (с причиной) / валиден. */
export type ResultRead =
  | { kind: "absent" }
  | { kind: "corrupt"; reason: string }
  | { kind: "ok"; result: TurnResult };

/**
 * Валидация результата протоколом v3 (Д-7): статус из словаря, traceId обязателен,
 * для ok — непустой markdown, для error/cancelled — код. Битый файл — это НЕ
 * «результ нет»: клиент и очередь получают явный corrupt, а не тихое ожидание.
 */
export async function readResultOutcome(dir: string): Promise<ResultRead> {
  let raw: string;
  try {
    raw = await readFile(join(dir, RESULT_FILE), "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { kind: "absent" };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt", reason: "файл не разобрать как JSON" };
  }
  if (!parsed || typeof parsed !== "object") return { kind: "corrupt", reason: "JSON не объект" };
  const record = parsed as Record<string, unknown>;
  if (typeof record.status !== "string" || !(RESULT_STATUSES as readonly string[]).includes(record.status)) {
    return { kind: "corrupt", reason: `неизвестный статус ${JSON.stringify(record.status)}` };
  }
  if (typeof record.traceId !== "string" || !record.traceId) {
    return { kind: "corrupt", reason: "нет traceId" };
  }
  if (record.status === "ok") {
    if (typeof record.markdown !== "string" || !record.markdown.trim()) {
      return { kind: "corrupt", reason: "status=ok без непустого markdown" };
    }
  } else if (typeof record.code !== "string" || !record.code) {
    return { kind: "corrupt", reason: `status=${record.status} без кода` };
  }
  return { kind: "ok", result: parsed as TurnResult };
}

/** Компактное чтение для проверок «есть ли результат»: corrupt маскируется в null. */
export async function readResult(dir: string): Promise<TurnResult | null> {
  const read = await readResultOutcome(dir);
  return read.kind === "ok" ? read.result : null;
}

/**
 * Ожидание подтверждения плагина (фаза «подтверждён», birdview §2).
 * true — ack получен; false — плагин не подтвердил за лимит: ход остаётся
 * в каталоге, решение за оператором (предупреждение в журнал).
 */
export async function waitForAck(dir: string, timeoutMs: number, clock: Clock, pollMs = 500): Promise<boolean> {
  const deadline = clock.now() + timeoutMs;
  for (;;) {
    if (await hasAck(dir)) return true;
    if (clock.now() >= deadline) return false;
    await clock.sleep(Math.min(pollMs, deadline - clock.now()));
  }
}

/**
 * Сторона плагина: подтвердить прочтение — атомарное переименование.
 * true — подтвердил этот читатель; false — результата нет или его уже подтвердил
 * другой читатель (гонка решается самим rename). Недоступность spool —
 * наружу, не маскируется в false (birdview §3).
 */
export async function ackResult(dir: string): Promise<boolean> {
  try {
    await rename(join(dir, RESULT_FILE), join(dir, ACK_FILE));
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}
