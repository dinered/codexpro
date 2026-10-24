// Референс-клиент стороны плагина (Ф-9, Д-7): ставит ход, пульсирует alive каждые
// 10 с, умеет снять ход («Стоп»), читает result.json и подтверждает его (result.ack).
// По этому файлу видно, что вторая сторона протокола реализуется независимо от моста:
// плагин не знает про Chrome, драйверы и темп — только про каталог spool.

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ManualClock, SystemClock, type Clock } from "../src/core/clock.ts";
import { CryptoRandom, type Random } from "../src/core/random.ts";
import { EVENT, createLogger, type Logger } from "../src/core/log.ts";
import { newTurnId } from "../src/protocol/names.ts";
import { putTask } from "../src/protocol/task.ts";
import { markCancelled, touchAlive } from "../src/protocol/alive.ts";
import { hasAck, readResultOutcome, ackResult } from "../src/protocol/result.ts";
import { writeAtomic } from "../src/protocol/atomic.ts";
import type { TurnTask, TurnResult } from "../src/core/types.ts";

export interface PutOptions {
  traceId?: string;
  /** период пульса alive (норматив: 10 с, birdview §2) */
  aliveEveryMs?: number;
}

/**
 * Клиент плагина. Пульс живёт, пока клиент не закрыт (stop/close) — ровно как
 * живой плагин: молчание дольше 70 с означает «ход снят» для моста.
 */
export class PluginClient {
  readonly root: string;
  private readonly clock: Clock;
  private readonly rand: Random;
  private readonly log: Logger;
  private readonly pulsers = new Map<string, () => void>();

  constructor(
    root: string,
    clock: Clock = new SystemClock(),
    rand: Random = new CryptoRandom(),
    log: Logger = createLogger(),
  ) {
    this.root = root;
    this.clock = clock;
    this.rand = rand;
    this.log = log;
  }

  /** Поставить задачу и начать пульсировать alive. */
  async put(text: string, options: PutOptions = {}): Promise<TurnTask> {
    await mkdir(this.root, { recursive: true });
    const id = newTurnId(this.clock.now(), this.rand);
    const task: TurnTask = {
      v: 3,
      id,
      createdAt: this.clock.now(),
      traceId: options.traceId ?? crypto.randomUUID(),
      text,
    };
    await putTask(this.root, task);
    await touchAlive(join(this.root, id), this.clock);
    this.startPulse(id, options.aliveEveryMs ?? 10_000);
    this.log.event(EVENT.TURN_CLAIM, "ход поставлен в очередь", { trace: task.traceId, turn: id });
    return task;
  }

  /** «Стоп» в Paseo: маркер отмены; пульс продолжается — плагин ждёт результат. */
  async cancel(id: string): Promise<void> {
    await markCancelled(join(this.root, id), this.clock);
  }

  /**
   * Ждать result.json (poll). Ожидающий клиент — живой плагин: если своего пульса
   * ещё нет, он включается (норматив 10 с). Битый result.json — явная ошибка, а не
   * тихое ожидание до тайм-аута (Н-1). Гонку читателей решает атомарный rename
   * (ackResult): результат получает ровно один читатель (Н-1).
   */
  async waitResult(id: string, timeoutMs: number, pollMs = 500): Promise<TurnResult | null> {
    const dir = join(this.root, id);
    this.ensurePulse(id);
    const deadline = this.clock.now() + timeoutMs;
    for (;;) {
      const read = await readResultOutcome(dir);
      if (read.kind === "corrupt") {
        throw new Error(`result.json повреждён (${read.reason}) — ход ${id} требует разбирательства оператора`);
      }
      if (read.kind === "ok") {
        if (await ackResult(dir)) return read.result; // подтвердили мы — отдаём ровно один раз
        return null; // подтвердил другой читатель: второй раз не отдаём (Н-1)
      }
      if (await hasAck(dir)) return null; // ack без result — подтвердил другой читатель
      if (this.clock.now() >= deadline) return null; // тайм-аут ≠ конец хода: каталог НЕ трогаем
      await this.clock.sleep(Math.min(pollMs, Math.max(1, deadline - this.clock.now())));
    }
  }

  /**
   * Убрать каталог хода. Разрешён ТОЛЬКО после result.ack (ход подтверждён и
   * прочитан): удаление неподтверждённого хода сносит журнал идемпотентности
   * и живой пульс — путь к повторной отправке (Н-1). force — осознанный обход
   * для разбирательства оператором.
   */
  async dispose(id: string, options: { force?: boolean } = {}): Promise<void> {
    const dir = join(this.root, id);
    this.stopPulse(id);
    if (!options.force && !(await hasAck(dir))) {
      throw new Error(`ход ${id} не подтверждён (нет result.ack) — удаление запрещено (Н-1); дождитесь результата или снимите ход командой stop`);
    }
    await rm(dir, { recursive: true, force: true });
  }

  stopPulse(id: string): void {
    const stop = this.pulsers.get(id);
    if (stop) {
      stop();
      this.pulsers.delete(id);
    }
  }

  /** Прекратить все пульсы (плагин закрылся — ходы станут «снятыми» через 70 с). */
  close(): void {
    for (const stop of this.pulsers.values()) stop();
    this.pulsers.clear();
  }

  private startPulse(id: string, everyMs: number): void {
    this.pulsers.set(
      id,
      this.clock.interval(() => {
        void touchAlive(join(this.root, id), this.clock).catch((error) => {
          this.log.event(EVENT.TURN_ERROR, `alive не пульсирует: ${error instanceof Error ? error.message : error}`, { turn: id });
        });
      }, everyMs),
    );
  }

  /** У ожидающего клиента свой пульс уже есть — второй не заводим. */
  private ensurePulse(id: string): void {
    if (!this.pulsers.has(id)) this.startPulse(id, 10_000);
  }

  /** Утилита для тестов: подложить битый элемент очереди (Ф-3). */
  async putBroken(name: string): Promise<void> {
    await mkdir(join(this.root, name), { recursive: true });
    await writeAtomic(join(this.root, name), "task.json", "{ не json");
  }
}

export { ManualClock };
