// Метрики для эксплуатации (birdview §1, модуль metrics): счётчики ходов,
// отправки часового окна, серия ошибок. Пишутся в файл состояния рядом со spool.
// Отказ записи метрик не останавливает мост — это наблюдаемость, а не бизнес-путь.

import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { writeAtomic } from "../protocol/atomic.ts";
import type { Clock } from "../core/clock.ts";
import type { Logger } from "../core/log.ts";
import type { TurnOutcome } from "../core/types.ts";

export interface MetricsFile {
  updatedAt: string;
  turns: { ok: number; error: number; cancelled: number };
  sends: { total: number; lastHour: number };
  pace: { errorStreak: number };
  lastTurn?: { id: string; status: string; ms: number };
  fatal?: string;
}

function empty(): MetricsFile {
  return {
    updatedAt: "",
    turns: { ok: 0, error: 0, cancelled: 0 },
    sends: { total: 0, lastHour: 0 },
    pace: { errorStreak: 0 },
  };
}

export class Metrics {
  private readonly file: string | null;
  private readonly clock: Clock;
  private readonly log: Logger;
  private state: MetricsFile | null = null;
  private warned = false;

  /** dir/name — путь файла состояния; null — метрики выключены. */
  constructor(dir: string | null, name: string, clock: Clock, log: Logger) {
    this.file = dir ? join(dir, name) : null;
    this.clock = clock;
    this.log = log;
  }

  /** Обновить файл метрик. */
  async record(outcome: Pick<TurnOutcome, "kind"> & { ms?: number }, turnId: string): Promise<void> {
    if (!this.file) return;
    const state = await this.load();
    state.turns[outcome.kind] += 1;
    state.lastTurn = { id: turnId, status: outcome.kind, ms: outcome.ms ?? 0 };
    state.updatedAt = new Date(this.clock.now()).toISOString();
    await this.save(state);
  }

  async recordSend(total: number, lastHour: number): Promise<void> {
    if (!this.file) return;
    const state = await this.load();
    state.sends = { total, lastHour };
    state.updatedAt = new Date(this.clock.now()).toISOString();
    await this.save(state);
  }

  async recordPace(errorStreak: number): Promise<void> {
    if (!this.file) return;
    const state = await this.load();
    state.pace.errorStreak = errorStreak;
    state.updatedAt = new Date(this.clock.now()).toISOString();
    await this.save(state);
  }

  async recordFatal(reason: string): Promise<void> {
    if (!this.file) return;
    const state = await this.load();
    state.fatal = reason;
    state.updatedAt = new Date(this.clock.now()).toISOString();
    await this.save(state);
  }

  private async load(): Promise<MetricsFile> {
    if (this.state) return this.state;
    const raw = await readFile(this.file!, "utf8").catch(() => null);
    let parsed: Partial<MetricsFile> | null = null;
    if (raw !== null) {
      try {
        parsed = JSON.parse(raw) as Partial<MetricsFile>;
      } catch {
        // битый файл метрик — не бизнес-путь: WARN один раз, счётчики с нуля (birdview §1)
        this.warnOnce(`файл метрик повреждён (${this.file}) — счётчики начаты с нуля`);
        parsed = null;
      }
    }
    const base = empty();
    this.state = {
      ...base,
      ...parsed,
      turns: { ...base.turns, ...parsed?.turns },
      sends: { ...base.sends, ...parsed?.sends },
      pace: { ...base.pace, ...parsed?.pace },
    };
    return this.state;
  }

  private warnOnce(message: string): void {
    if (this.warned) return;
    this.warned = true;
    this.log.raw(message);
  }

  private async save(state: MetricsFile): Promise<void> {
    try {
      // node:path — разделители каталогов для любой ОС (учебные запуски и вне macOS)
      await writeAtomic(dirname(this.file!), basename(this.file!), JSON.stringify(state, null, "\t") + "\n");
      this.warned = false;
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        this.log.raw(`метрики не записаны (${error instanceof Error ? error.message : error}) — мост продолжает работу`);
      }
    }
  }
}
