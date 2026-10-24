// Часы. В бою — системные; в тестах — подставные (birdview §5: «формулы темпа
// на подставных часах», «модельный тест Н-1»). Весь код моста получает время
// только через Clock — ни одного прямого Date.now()/setTimeout в логике.

export interface Clock {
  now(): number;
  /** Пауза с поддержкой отмены: сигнал прерывает ожидание. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Периодическая задача; возвращает функцию остановки. Колбек — синхронный, асинхронную работу он планирует сам. */
  interval(fn: () => void, ms: number): () => void;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (ms <= 0 || signal?.aborted) return resolve();
      const timer = setTimeout(done, ms);
      const onAbort = () => done();
      function done(): void {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  interval(fn: () => void, ms: number): () => void {
    const timer = setInterval(fn, ms);
    return () => clearInterval(timer);
  }
}

interface SleepWaiter {
  at: number;
  resolve: () => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface IntervalTask {
  fn: () => void;
  every: number;
  nextAt: number;
  stopped: boolean;
}

/**
 * Подставные часы для тестов: время двигает только тест (advanceAsync),
 * реальных ожиданий нет. Интервалы срабатывают при продвижении времени —
 * пульс lease в тестах ходит так же, как в бою.
 */
export class ManualClock implements Clock {
  private nowMs: number;
  private waiters: SleepWaiter[] = [];
  private intervals: IntervalTask[] = [];

  constructor(start = 0) {
    this.nowMs = start;
  }

  now(): number {
    return this.nowMs;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0 || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter: SleepWaiter = { at: this.nowMs + ms, resolve, signal };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve();
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  interval(fn: () => void, ms: number): () => void {
    const task: IntervalTask = { fn, every: ms, nextAt: this.nowMs + ms, stopped: false };
    this.intervals.push(task);
    return () => {
      task.stopped = true;
    };
  }

  /** Продвинуть время и дождаться, пока проснувшиеся цепочки уйдут на новые ожидания. */
  async advanceAsync(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    for (;;) {
      this.advanceTo(target);
      await settle();
      if (!this.waiters.some((w) => w.at <= target) && !this.intervals.some((t) => !t.stopped && t.nextAt <= target)) break;
    }
  }

  /** Синхронно прожечь всё, что должно случиться до target включительно, и встать в target. */
  private advanceTo(target: number): void {
    for (;;) {
      let next = Infinity;
      for (const t of this.intervals) if (!t.stopped) next = Math.min(next, t.nextAt);
      for (const w of this.waiters) next = Math.min(next, w.at);
      if (next > target) break;
      this.nowMs = Math.max(this.nowMs, next);
      for (const t of [...this.intervals]) {
        if (t.stopped) continue;
        while (!t.stopped && t.nextAt <= this.nowMs) {
          t.nextAt += t.every;
          t.fn();
        }
      }
      const due = this.waiters.filter((w) => w.at <= this.nowMs);
      this.waiters = this.waiters.filter((w) => w.at > this.nowMs);
      for (const w of due) {
        if (w.onAbort && w.signal) w.signal.removeEventListener("abort", w.onAbort);
        w.resolve();
      }
    }
    // время доходит до цели, даже если событий по пути не было — иначе часы стоят
    this.nowMs = Math.max(this.nowMs, target);
  }

  /** Ждущие, но не сработавшие паузы — для диагностических утверждений в тестах. */
  pendingWaits(): number {
    return this.waiters.length;
  }
}

/** Дать микрозадачам и отложенным цепочкам разойтись. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
