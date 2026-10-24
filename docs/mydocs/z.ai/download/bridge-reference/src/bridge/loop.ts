// Цикл моста: сканирует очередь (Ф-3), решает — захватить, перехватить или
// подождать (Н-1), исполняет ход (bridge/turn.ts), применяет отказную матрицу
// (birdview §3): серия ошибок — backoff (Н-5), часовой предел — ожидание окна
// (П-3), фатальные состояния — остановка моста.

import { mkdir } from "node:fs/promises";
import type { Clock } from "../core/clock.ts";
import { EVENT, type Logger } from "../core/log.ts";
import type { Random } from "../core/random.ts";
import { BridgeFatalError, errorMessage, isCrash } from "../core/errors.ts";
import { FATAL_REASON, TURN_ERROR, type Phase, type TurnOutcome } from "../core/types.ts";
import type { BridgeConfig } from "../config.ts";
import type { Pacer } from "../pace/pace.ts";
import { aliveFresh } from "../protocol/alive.ts";
import { createClaim, freshestLease, maxClaimEpoch, stillOwned } from "../protocol/claim.ts";
import { checkJournal } from "../protocol/journal.ts";
import { writeResult } from "../protocol/result.ts";
import { readLatestState } from "../protocol/state.ts";
import { scanQueue, type QueueEntry } from "../protocol/queue.ts";
import type { Metrics } from "../metrics/metrics.ts";
import type { ChatDriver } from "../driver/types.ts";
import type { NetworkProbe } from "../driver/cdp-stream.ts";
import { executeTurn, type CrashPoint, type StopControl, type TurnDeps } from "./turn.ts";

export interface BridgeDeps {
  cfg: BridgeConfig;
  driver: ChatDriver;
  pacer: Pacer;
  clock: Clock;
  rand: Random;
  log: Logger;
  metrics: Metrics;
  probe: NetworkProbe | null;
  stop: StopControl;
  /** Хаос-крючки модельного теста Н-1 (bridge/turn.ts). */
  crash?: (point: CrashPoint) => void;
}

export interface BridgeResult {
  sentTotal: number;
  fatal: string | null;
}

type PrevPhase = Phase | null;

type Decision =
  | { action: "take"; epoch: number; prevPhase: PrevPhase }
  | { action: "skip" }
  | { action: "closed" };

export class Bridge {
  private readonly deps: BridgeDeps;
  private readonly warned = new Set<string>();
  fatal: string | null = null;
  sentTotal = 0;

  constructor(deps: BridgeDeps) {
    this.deps = deps;
  }

  private get cfg(): BridgeConfig {
    return this.deps.cfg;
  }

  async run(): Promise<BridgeResult> {
    await mkdir(this.cfg.root, { recursive: true });
    this.deps.log.raw(`мост запущен: spool=${this.cfg.root} driver=${this.deps.driver.name} lease=${this.cfg.leaseMs} мс`);
    while (!this.deps.stop.stopped && !this.fatal) {
      await this.step();
    }
    if (this.fatal) this.deps.log.event(EVENT.BRIDGE_FATAL, `мост остановлен: ${this.fatal}`);
    else this.deps.log.event(EVENT.BRIDGE_STOP, "мост остановлен оператором");
    return { sentTotal: this.sentTotal, fatal: this.fatal };
  }

  private async step(): Promise<void> {
    let pending: QueueEntry[];
    try {
      const scan = await scanQueue(this.cfg.root);
      pending = scan.pending;
      for (const broken of scan.broken) {
        if (this.warned.has(broken.id)) continue;
        this.warned.add(broken.id);
        this.deps.log.event(EVENT.QUEUE_SKIP, `битый элемент очереди пропущен: ${broken.reason}`, { turn: broken.id });
      }
      // элемент, починившийся между проходами, снова имеет право на предупреждение (Ф-3)
      for (const entry of pending) this.warned.delete(entry.task.id);
    } catch (error) {
      this.fail(new BridgeFatalError(FATAL_REASON.SPOOL_UNAVAILABLE, `spool недоступен: ${errorMessage(error)}`));
      return;
    }

    for (const entry of pending) {
      const decision = await this.decide(entry);
      if (decision.action === "skip") continue;
      if (decision.action === "closed") return; // ход закрыт без исполнения — очередь перечитается
      await this.runTurn(entry, decision.epoch, decision.prevPhase);
      return; // после каждого хода очередь читается заново (Ф-3)
    }

    // пусто — пауза опроса с рандомизацией (П-5). Стоп мог прийти, пока шаг
    // был в работе (скан очереди — реальный fs): не засыпаем после остановки,
    // иначе мост засыпает без будущих продвижений часов и не завершается (Н-6)
    if (this.deps.stop.stopped || this.fatal) return;
    const pollMs = Math.round(this.cfg.pollBaseMs * (0.8 + 0.4 * this.deps.rand.next()));
    await this.deps.clock.sleep(pollMs);
  }

  /**
   * Решение по ходу из очереди (birdview §2):
   *  - захватов нет и плагин жив → захват claim.1;
   *  - плагин молчит > 70 с → ход снят плагином: закрываем cancelled (birdview §3);
   *  - lease максимальной эпохи свеж → владелец жив, ждём (Н-1, в т.ч. паузы темпа);
   *  - lease протух → перехват: claim.<N+1> через O_EXCL, победитель исполняет.
   */
  private async decide(entry: QueueEntry): Promise<Decision> {
    const { dir, task } = entry;
    const maxClaim = await maxClaimEpoch(dir);

    if (maxClaim === 0) {
      if (!(await aliveFresh(dir, this.cfg.aliveTtlMs, this.deps.clock))) {
        await this.closeWithoutDriver(entry, { status: "cancelled", code: "ALIVE_EXPIRED", message: "плагин не пульсирует — ход снят (birdview §3)" });
        return { action: "closed" };
      }
      if (!(await createClaim(dir, 1))) return { action: "skip" }; // проиграли гонку захвата
      this.deps.log.event(EVENT.TURN_CLAIM, "ход захвачен", { trace: task.traceId, turn: task.id, epoch: 1 });
      return { action: "take", epoch: 1, prevPhase: null };
    }

    const lease = await freshestLease(dir, this.deps.clock);
    if (lease && lease.ageMs < this.cfg.leaseMs) return { action: "skip" }; // владелец жив или рестарт < аренды (birdview §3)

    if (!(await aliveFresh(dir, this.cfg.aliveTtlMs, this.deps.clock))) {
      // брошен и плагин мёртв: снятый ход — cancelled; черновик сотрёт исполняющий мост,
      // а без исполнения поле чистое (birdview §3, «alive истёк»)
      await this.closeWithoutDriver(entry, { status: "cancelled", code: "ALIVE_EXPIRED", message: "плагин не пульсирует, ход брошен — снят (birdview §3)" });
      return { action: "closed" };
    }

    const epoch = maxClaim + 1;
    if (!(await createClaim(dir, epoch))) return { action: "skip" }; // проиграли гонку перехвата — отступаем
    const latest = await readLatestState(dir);
    this.deps.log.event(EVENT.TURN_INTERCEPT, `брошенный ход перехвачен, эпоха ${epoch}`, {
      trace: task.traceId,
      turn: task.id,
      epoch,
      prev_phase: latest?.phase ?? "-",
    });

    // Точка невозврата пройдена прошлой эпохой: повторная отправка запрещена (Н-1, Ф-7)
    if (latest && (latest.phase === "sending" || latest.phase === "sent" || latest.phase === "generating" || latest.phase === "harvesting")) {
      await this.closeWithoutDriver(entry, {
        status: "error",
        code: TURN_ERROR.SEND_STATE_UNKNOWN,
        message: `перехват после точки невозврата (фаза ${latest.phase}) — состояние отправки неизвестно (Н-6)`,
      });
      return { action: "closed" };
    }

    // Журнал: task_id уже записан — повторная отправка запрещена, браузер не открываем (Н-1)
    const journal = await checkJournal(dir, task.id);
    if (journal === "corrupt") {
      await this.closeWithoutDriver(entry, { status: "error", code: TURN_ERROR.JOURNAL_CORRUPT, message: "journal.jsonl повреждён — решение за оператором (birdview §3)" });
      return { action: "closed" };
    }
    if (journal === "present") {
      await this.closeWithoutDriver(entry, { status: "error", code: TURN_ERROR.IDEMPOTENCY_REJECT, message: "task_id уже в журнале отправок — повторная отправка запрещена (Н-1)" });
      return { action: "closed" };
    }

    return { action: "take", epoch, prevPhase: latest?.phase ?? null };
  }

  private async runTurn(entry: QueueEntry, epoch: number, prevPhase: PrevPhase): Promise<void> {
    const deps: TurnDeps = {
      cfg: this.cfg,
      clock: this.deps.clock,
      rand: this.deps.rand,
      log: this.deps.log,
      pacer: this.deps.pacer,
      driver: this.deps.driver,
      metrics: this.deps.metrics,
      probe: this.deps.probe,
      stop: this.deps.stop,
      crash: this.deps.crash,
    };
    try {
      const outcome = await executeTurn(deps, { dir: entry.dir, task: entry.task, epoch, prevPhase });
      await this.afterTurn(entry, outcome);
    } catch (error) {
      if (isCrash(error)) throw error; // смерть процесса — наружу (модельный тест Н-1)
      if (error instanceof BridgeFatalError) {
        // фатально: ход закрывается ошибкой, если владение ещё есть; мост останавливается (birdview §3)
        if (error.closeTurnIfOwned && (await stillOwned(entry.dir, epoch).catch(() => false))) {
          await writeResult(entry.dir, { status: "error", code: error.reason, message: error.detail, traceId: entry.task.traceId }).catch(() => {});
        }
        this.fail(error);
        return;
      }
      // остальное уже закрыто как ошибка хода — сюда попадаем редко
      this.deps.log.event(EVENT.TURN_ERROR, errorMessage(error), { trace: entry.task.traceId, turn: entry.task.id });
    }
  }

  /** Отказная матрица после хода (birdview §3). */
  private async afterTurn(entry: QueueEntry, outcome: TurnOutcome): Promise<void> {
    const { task } = entry;
    await this.deps.metrics.record(outcome, task.id).catch(() => {});
    switch (outcome.kind) {
      case "ok":
        this.sentTotal += 1;
        break;
      case "cancelled":
        this.deps.log.event(EVENT.TURN_CANCEL, "ход снят", { trace: task.traceId, turn: task.id });
        break;
      case "error":
        this.deps.log.event(EVENT.TURN_ERROR, `${outcome.code}: ${outcome.message}`, { trace: task.traceId, turn: task.id });
        if (outcome.code === TURN_ERROR.RATE_LIMIT) {
          await this.deps.metrics.recordResistance("rateLimit").catch(() => {}); // У-6
          await this.waitForWindowSlot();
        } else if (outcome.code === TURN_ERROR.PLATFORM_ERROR) {
          await this.recordPlatformError();
        }
        break;
    }
  }

  /** Н-5: серия ошибок платформы — пауза 5 мин с удвоением, потолок 30 мин, сброс после успеха. */
  private async recordPlatformError(): Promise<void> {
    const pauseMs = this.deps.pacer.recordError(this.deps.clock.now());
    await this.deps.metrics.recordPace(this.deps.pacer.errorStreak).catch(() => {});
    if (pauseMs <= 0) return;
    await this.deps.metrics.recordResistance("backoff").catch(() => {}); // У-6
    this.deps.log.event(EVENT.PACE_BACKOFF, `серия ошибок платформы: ${this.deps.pacer.errorStreak} — пауза ${Math.round(pauseMs / 60_000)} мин (Н-5)`);
    await this.waitStoppable(pauseMs);
  }

  /** П-3: часовой предел — очередь ждёт до освобождения окна, отказы не каскадятся. */
  private async waitForWindowSlot(): Promise<void> {
    const waitMs = this.deps.pacer.windowSlotWaitMs(this.deps.clock.now());
    if (waitMs <= 0) return;
    this.deps.log.event(EVENT.RATE_LIMIT, `очередь ждёт освобождения часового окна: ${Math.round(waitMs / 60_000)} мин (П-3)`);
    await this.waitStoppable(waitMs);
  }

  /** Пауза, прерываемая мягкой остановкой (Н-6). */
  private async waitStoppable(ms: number): Promise<void> {
    const until = this.deps.clock.now() + ms;
    for (;;) {
      if (this.deps.stop.stopped || this.fatal) return;
      const now = this.deps.clock.now();
      if (now >= until) return;
      await this.deps.clock.sleep(Math.min(this.cfg.cancelPollMs, until - now));
    }
  }

  /** Закрыть ход без драйвера (бесплатные проверки до открытия браузера). */
  private async closeWithoutDriver(entry: QueueEntry, result: { status: "error" | "cancelled"; code: string; message: string }): Promise<void> {
    let written: boolean;
    try {
      written = await writeResult(entry.dir, { ...result, traceId: entry.task.traceId });
    } catch (error) {
      // запись результата не удалась (диск полон) — фатально (birdview §3)
      this.fail(new BridgeFatalError(FATAL_REASON.DISK_WRITE, `result.json не записан для ${entry.task.id}: ${errorMessage(error)}`));
      return;
    }
    if (!written) return; // ход уже закрыл другой мост — гонка O_EXCL
    if (result.code === "ALIVE_EXPIRED") {
      this.deps.log.event(EVENT.ALIVE_EXPIRED, result.message, { trace: entry.task.traceId, turn: entry.task.id });
    } else {
      this.deps.log.event(EVENT.TURN_ERROR, `${result.code}: ${result.message}`, { trace: entry.task.traceId, turn: entry.task.id });
    }
    await this.deps.metrics.record({ kind: result.status === "error" ? "error" : "cancelled" }, entry.task.id).catch(() => {});
  }

  /** Фатальная остановка (birdview §3): ход закрывается ошибкой, если владение ещё есть. */
  private fail(error: BridgeFatalError): void {
    if (this.fatal) return;
    this.fatal = error.reason;
    this.deps.log.event(EVENT.BRIDGE_FATAL, `${error.reason}: ${error.detail}`);
    void this.deps.metrics.recordFatal(error.reason).catch(() => {});
  }
}
