// Владение ходом: claim.<N> (O_EXCL, N — эпоха: предыдущая + 1) и lease.<N>
// (пульс владельца каждые ~10 с, отдельным таймером, вне цепочки фаз — Н-1).
// Перехват брошенного хода: lease максимальной эпохи не обновлялся ≥ LEASE_MS
// (birdview §2). Старые lease.<N> игнорируются.

import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createExclusive, pulse } from "./atomic.ts";
import { CLAIM_PREFIX, LEASE_PREFIX } from "./names.ts";
import type { Clock } from "../core/clock.ts";

/** Максимальная эпоха захвата в каталоге хода; 0 — захватов нет. */
export async function maxClaimEpoch(dir: string): Promise<number> {
  let max = 0;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.startsWith(CLAIM_PREFIX)) continue;
    const epoch = Number(name.slice(CLAIM_PREFIX.length));
    if (Number.isInteger(epoch) && epoch > max) max = epoch;
  }
  return max;
}

/** Захватить ход эпохой N (O_EXCL). false — каталог уже занят: проигравший гонку отступает. */
export async function createClaim(dir: string, epoch: number): Promise<boolean> {
  return createExclusive(join(dir, `${CLAIM_PREFIX}${epoch}`), `${epoch}\n`);
}

/** Владение на момент проверки: наша эпоха существует и остаётся максимальной (birdview §2). */
export async function stillOwned(dir: string, epoch: number): Promise<boolean> {
  if (epoch <= 0) return false;
  if (!(await stat(join(dir, `${CLAIM_PREFIX}${epoch}`)).catch(() => null))) return false;
  return (await maxClaimEpoch(dir)) === epoch;
}

export interface LeaseInfo {
  epoch: number;
  ageMs: number;
}

/** Свежесть lease максимальной эпохи; null — пульса нет вовсе (мост умер до первого пульса). */
export async function freshestLease(dir: string, clock: Clock): Promise<LeaseInfo | null> {
  let max = 0;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.startsWith(LEASE_PREFIX)) continue;
    const epoch = Number(name.slice(LEASE_PREFIX.length));
    if (Number.isInteger(epoch) && epoch > max) max = epoch;
  }
  if (max === 0) return null;
  const info = await stat(join(dir, `${LEASE_PREFIX}${max}`)).catch(() => null);
  if (!info) return null;
  return { epoch: max, ageMs: Math.max(0, clock.now() - info.mtimeMs) };
}

/**
 * Пульс владельца. Запускается как отдельный таймер — продолжает работать
 * на паузах темпа и в ожидании ответа, поэтому пауза больше аренды не даёт
 * перехватить живой ход (Н-1, приёмка Т-2).
 */
export class LeasePulser {
  private readonly clock: Clock;
  private readonly dir: string;
  private readonly epoch: number;
  private readonly everyMs: number;
  private readonly onError: (error: unknown) => void;
  private stopFn: (() => void) | null = null;
  private busy = false;
  private queued = false;
  private stopped = false;

  constructor(dir: string, epoch: number, clock: Clock, everyMs: number, onError: (error: unknown) => void) {
    this.dir = dir;
    this.epoch = epoch;
    this.clock = clock;
    this.everyMs = everyMs;
    this.onError = onError;
  }

  start(): void {
    if (this.stopFn) return;
    // первый пульс сразу: ход считается захваченным с этого момента
    void this.beat();
    this.stopFn = this.clock.interval(() => void this.beat(), this.everyMs);
  }

  /** Остановка пульса — владение освобождается всегда, включая аварийные пути (Ф-2). */
  stop(): void {
    this.stopped = true;
    this.stopFn?.();
    this.stopFn = null;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  private async beat(): Promise<void> {
    if (this.stopped) return;
    if (this.busy) {
      this.queued = true; // пульс, пришедший во время предыдущего, исполняется хвостовым
      return;
    }
    this.busy = true;
    try {
      do {
        this.queued = false;
        // момент пульса фиксируем в момент срабатывания таймера, а не завершения записи:
        // на подставных часах burst интервалов оставит свежий след последнего пульса
        await pulse(join(this.dir, `${LEASE_PREFIX}${this.epoch}`), this.clock.now());
      } while (this.queued && !this.stopped);
    } catch (error) {
      if (!this.stopped) this.onError(error); // spool недоступен — фатально (birdview §3)
    } finally {
      this.busy = false;
    }
  }
}
