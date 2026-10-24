// Ошибки моста. Три сорта — ровно как в отказной матрице (birdview §3):
//  - TurnError      — ход падает, мост берёт следующий (Н-3);
//  - BridgeFatalError — мост останавливается целиком; ход закрывается ошибкой, если владение ещё есть;
//  - CrashError     — имитация смерти процесса в модельных тестах Н-1: никакой уборки, владение теряется.

import type { FatalReason } from "./types.ts";

export class TurnError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TurnError";
    this.code = code;
  }
}

export class BridgeFatalError extends Error {
  readonly reason: FatalReason;
  readonly detail: string;
  /** true — при остановке попытаться закрыть ход ошибкой (владение ещё может быть у нас). */
  readonly closeTurnIfOwned: boolean;
  constructor(reason: FatalReason, detail: string, closeTurnIfOwned = true) {
    super(`фатально (${reason}): ${detail}`);
    this.name = "BridgeFatalError";
    this.reason = reason;
    this.detail = detail;
    this.closeTurnIfOwned = closeTurnIfOwned;
  }
}

/** Бросается хаос-крючками в тестах: изображает смерть процесса на выбранной фазе (Н-1). */
export class CrashError extends Error {
  readonly point: string;
  constructor(point: string) {
    super(`падение процесса: ${point}`);
    this.name = "CrashError";
    this.point = point;
  }
}

export function isCrash(error: unknown): error is CrashError {
  return error instanceof CrashError;
}

/** Ошибка fs с конкретным кодом (ENOENT, EEXIST, …)? */
export function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

/** Коды fs, означающие «хранилище недоступно», а не «файла нет» (birdview §3). */
const SPOOL_ERRNOS = new Set(["EACCES", "EPERM", "EROFS", "EIO", "EBUSY", "ESTALE", "ENOTDIR", "EMFILE", "ENFILE"]);

/** Недоступность spool (права, ввод-вывод) — не путать с отсутствием файла: это фатально. */
export function isSpoolError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && SPOOL_ERRNOS.has(code);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
