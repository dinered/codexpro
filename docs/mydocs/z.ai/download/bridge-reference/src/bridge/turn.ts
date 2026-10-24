// Автомат хода (birdview §2): фазы claimed → preparing → typing → sending → sent →
// generating → harvesting → result → подтверждён. Точка невозврата — строго в этом
// порядке: state=sending (атомарно) → journal.jsonl (fsync) → нажатие «Отправить».
// Отмена и снятие проверяются между фазами и каждые 500 мс в ожиданиях; владение —
// перед каждой записью. Все отказные состояния — по матрице birdview §3.

import type { Clock } from "../core/clock.ts";
import type { Logger } from "../core/log.ts";
import { EVENT } from "../core/log.ts";
import type { Random } from "../core/random.ts";
import { BridgeFatalError, errorMessage, isCrash, isSpoolError, TurnError } from "../core/errors.ts";
import { FATAL_REASON, TURN_ERROR, type AnswerSnapshot, type Phase, type TurnOutcome, type TurnTask } from "../core/types.ts";
import type { BridgeConfig } from "../config.ts";
import type { Pacer } from "../pace/pace.ts";
import { aliveAge, isCancelled } from "../protocol/alive.ts";
import { LeasePulser, stillOwned } from "../protocol/claim.ts";
import { checkJournal, journalSend } from "../protocol/journal.ts";
import { hasAck, writeResult } from "../protocol/result.ts";
import { writeState } from "../protocol/state.ts";
import { htmlToMarkdown, normalizeText } from "../md/markdown.ts";
import type { Metrics } from "../metrics/metrics.ts";
import { CompletionDetector } from "./completion.ts";
import type { ChatDriver, DriverFailure } from "../driver/types.ts";
import type { NetworkProbe } from "../driver/cdp-stream.ts";

/** Контроль мягкой остановки (Н-6): первый сигнал — stop.stopped = true. */
export interface StopControl {
  readonly stopped: boolean;
}

/** Точки для модельного теста Н-1: крючок бросает CrashError — процесс «умирает». */
export type CrashPoint =
  | "after-claim"
  | "preparing"
  | "pace-wait"
  | "typing"
  | "before-state-write"
  | "after-state-write"
  | "before-journal"
  | "before-click"
  | "after-click"
  | "generating"
  | "before-result"
  | "after-result";

export interface TurnDeps {
  cfg: BridgeConfig;
  clock: Clock;
  rand: Random;
  log: Logger;
  pacer: Pacer;
  driver: ChatDriver;
  metrics: Metrics;
  probe: NetworkProbe | null;
  stop: StopControl;
  /** Хаос-крючок Н-1: вызывается в размеченных точках; бросает CrashError или молчит. */
  crash?: (point: CrashPoint) => void;
}

export interface TurnJob {
  dir: string;
  task: TurnTask;
  epoch: number;
  /** фаза предыдущей эпохи, если ход перехвачен; typing — в поле наш черновик */
  prevPhase: Phase | null;
}

type StopCause = "cancel" | "alive" | "signal";

export async function executeTurn(deps: TurnDeps, job: TurnJob): Promise<TurnOutcome> {
  const engine = new TurnEngine(deps, job);
  const pulser = new LeasePulser(job.dir, job.epoch, deps.clock, deps.cfg.leaseEveryMs, (error) => {
    // spool недоступен — пульс мёртв: фатально (birdview §3)
    engine.pulserFailure = error;
  });
  const startedAt = deps.clock.now();
  try {
    pulser.start();
    return await engine.run(startedAt);
  } catch (error) {
    if (isCrash(error)) throw error; // смерть: никакой уборки, кроме остановки пульса (finally)
    if (error instanceof BridgeFatalError) {
      // закрытие фатально прерванного хода — у цикла моста (владение там ещё раз проверят)
      throw error;
    }
    if (engine.pulserFailure) {
      throw new BridgeFatalError(FATAL_REASON.SPOOL_UNAVAILABLE, `пульс хода не пишется: ${errorMessage(engine.pulserFailure)}`);
    }
    if (isSpoolError(error)) {
      // EACCES/EROFS/EIO на файлах хода — spool недоступен, это не ошибка хода (birdview §3)
      throw new BridgeFatalError(FATAL_REASON.SPOOL_UNAVAILABLE, `spool недоступен: ${errorMessage(error)}`);
    }
    return await engine.closeWithError(error);
  } finally {
    pulser.stop(); // владение освобождается всегда (Ф-2): lease протухнет — ход перехватят
  }
}

class TurnEngine {
  pulserFailure: unknown = null;
  private readonly deps: TurnDeps;
  private readonly job: TurnJob;
  private readonly log: Logger;
  private typed = false;

  constructor(deps: TurnDeps, job: TurnJob) {
    this.deps = deps;
    this.job = job;
    this.log = fieldsLogger(deps.log, { trace: job.task.traceId, turn: job.task.id });
  }

  private get cfg(): BridgeConfig {
    return this.deps.cfg;
  }

  private get dir(): string {
    return this.job.dir;
  }

  private get epoch(): number {
    return this.job.epoch;
  }

  async run(startedAt: number): Promise<TurnOutcome> {
    const { task } = this.job;

    // ── claimed ──
    await this.toPhase("claimed");
    this.deps.crash?.("after-claim");

    // ── preparing: валидация, чат свободен, темп (П-2/П-3) ──
    await this.toPhase("preparing");
    this.deps.crash?.("preparing");
    if (!task.text.trim()) throw new TurnError(TURN_ERROR.EMPTY_TASK, "пустая задача (Ф-3)");
    await this.checkChallenge();
    await this.deps.driver.bind(); // переход внутри домена — перепривязка (Ф-7)
    await this.deps.driver.ensureReady(this.cfg.composerWaitMs); // composer-missing → фатально в closeWithError
    if (this.job.prevPhase === "typing") {
      // в поле черновик нашей прошлой эпохи: он наш, его можно стереть (birdview §2)
      await this.deps.driver.clearComposer();
      this.typed = false;
    }
    // Н-4: чужой ход или чужой черновик — ждём, в чужой ход не вмешиваемся
    await this.waitChatFree(startedAt);

    const gate = this.deps.pacer.limitCheck(this.deps.clock.now());
    if (gate.gate === "limited") {
      this.log.event(EVENT.PACE_STOP, `часовой предел ${this.deps.pacer.cfg.hourlyMax} сообщений достигнут — отправка отменяется (П-3)`);
      throw new TurnError(TURN_ERROR.RATE_LIMIT, `часовой лимит отправок (${this.deps.pacer.cfg.hourlyMax}/ч) достигнут`);
    }
    if (gate.warn) {
      this.log.event(EVENT.PACE_WARN, `в часовом окне ${gate.sentInWindow} отправок (жёлтый порог ${this.deps.pacer.cfg.hourlyWarn})`);
    }
    const delayMs = this.deps.pacer.delayFor(task.text, this.deps.clock.now());
    if (delayMs > 0) {
      this.log.event(EVENT.PACE_PAUSE, `пауза темпа ${Math.round(delayMs / 1000)} с перед набором (П-2)`);
      const cause = await this.pause(delayMs, { challenge: true });
      this.deps.crash?.("pace-wait");
      if (cause) return await this.closeCancelled(cause, false);
    }

    // ── typing: ввод и сверка без разметки (Ф-4) ──
    await this.toPhase("typing");
    this.deps.crash?.("typing");
    for (let attempt = 0; ; attempt++) {
      await this.deps.driver.typeText(task.text);
      this.typed = true;
      if (normalizeText(await this.deps.driver.composerText()) === normalizeText(task.text)) break;
      await this.deps.driver.clearComposer();
      if (attempt >= this.cfg.typeRetries) {
        throw new TurnError(TURN_ERROR.TEXT_MISMATCH, `введённый текст не совпал с задачей после ${this.cfg.typeRetries} повторов (Ф-4)`);
      }
    }

    const stopCause = await this.guard(); // отмена до отправки — стереть поле (Ф-1)
    if (stopCause) return await this.closeCancelled(stopCause, false);

    // ── ТОЧКА НЕВОЗВРАТА (birdview §2): state=sending → journal → клик ──
    await this.toPhase("sending");
    this.deps.crash?.("before-journal");
    await journalSend(this.dir, task.id, this.deps.clock.now());
    this.deps.crash?.("before-click");
    await this.deps.driver.pressSend();
    this.deps.pacer.recordSend(this.deps.clock.now());
    const sendsTotal = gate.sentInWindow + 1;
    await this.deps.metrics.recordSend(sendsTotal, sendsTotal).catch(() => {});
    this.log.event(EVENT.TURN_SEND, "сообщение отправлено в платформу");
    this.deps.crash?.("after-click");
    await this.toPhase("sent");

    // ── generating: совокупность признаков конца ответа (Ф-6) ──
    await this.toPhase("generating");
    const detector = new CompletionDetector(this.deps.rand);
    const answer = await this.waitAnswer(detector, startedAt);
    this.deps.crash?.("generating");

    // ── harvesting: markdown (Ф-5); пустой «готовый» ответ — ошибка хода (Ф-6) ──
    await this.toPhase("harvesting");
    if (!answer.trim()) throw new TurnError(TURN_ERROR.EMPTY_ANSWER, "платформа закончила ход пустым ответом — ошибка или лимит на стороне платформы");

    // ── result: ровно один раз, с проверкой владения (Н-1) ──
    this.deps.crash?.("before-result");
    if (!(await stillOwned(this.dir, this.epoch))) {
      throw new BridgeFatalError(FATAL_REASON.OWNERSHIP_LOST, "владение утрачено перед записью результата", false);
    }
    const written = await writeResult(this.dir, { status: "ok", markdown: answer, traceId: task.traceId });
    if (!written) throw new BridgeFatalError(FATAL_REASON.OWNERSHIP_LOST, "результат уже создан другим исполнителем", false);
    await this.toPhase("result");
    this.deps.pacer.recordSuccess();
    await this.deps.metrics.record({ kind: "ok", ms: this.deps.clock.now() - startedAt }, task.id).catch(() => {});
    this.log.event(EVENT.TURN_OK, `ответ отдан (${answer.length} символов markdown)`);
    this.deps.crash?.("after-result");

    // ── подтверждён: плагин атомарно переименовал result.json (birdview §2) ──
    if (await this.waitAck()) {
      await this.toPhase("confirmed");
      this.log.event(EVENT.TURN_ACK, "плагин подтвердил результат");
    } else if (!this.deps.stop.stopped) {
      this.log.event(EVENT.TURN_ACK_TIMEOUT, `нет result.ack за ${this.cfg.ackWaitMs / 1000} с — каталог хода оставлен плагину`);
    }
    return { kind: "ok", markdown: answer, ms: this.deps.clock.now() - startedAt };
  }

  /**
   * Смена фазы с проверкой владения (birdview §2). Проверки ДО и ПОСЛЕ записи:
   * гонка «проверили — перехватили — записали» оставила бы файл устаревшей эпохи;
   * повторная проверка её ловит. Краш-точки — для модельного теста Н-1.
   */
  private async toPhase(phase: Phase): Promise<void> {
    if (!(await stillOwned(this.dir, this.epoch))) {
      throw new BridgeFatalError(FATAL_REASON.OWNERSHIP_LOST, `эпоха ${this.epoch} больше не максимальная при фазе ${phase}`, false);
    }
    this.deps.crash?.("before-state-write");
    await writeState(this.dir, this.epoch, phase);
    this.deps.crash?.("after-state-write");
    if (!(await stillOwned(this.dir, this.epoch))) {
      throw new BridgeFatalError(FATAL_REASON.OWNERSHIP_LOST, `владение утрачено при записи фазы ${phase}`, false);
    }
    this.log.event(EVENT.TURN_PHASE, `фаза: ${phase}`, { phase });
  }

  /**
   * Проверки между фазами и в ожиданиях (birdview §2): владение, сигнал оператора,
   * маркер cancel, живость плагина. Возвращает причину снятия или null.
   */
  private async guard(): Promise<StopCause | null> {
    if (this.pulserFailure) {
      throw new BridgeFatalError(FATAL_REASON.SPOOL_UNAVAILABLE, `пульс хода не пишется: ${errorMessage(this.pulserFailure)}`);
    }
    if (!(await stillOwned(this.dir, this.epoch))) {
      throw new BridgeFatalError(FATAL_REASON.OWNERSHIP_LOST, "владение утрачено (эпоха перехвачена)", false);
    }
    if (this.deps.stop.stopped) return "signal";
    if (await isCancelled(this.dir)) return "cancel";
    const age = await aliveAge(this.dir, this.deps.clock);
    if (age === null || age > this.cfg.aliveTtlMs) return "alive"; // плагин молчит > 70 с — ход снят
    return null;
  }

  /** Пауза с проверками каждые cancelPollMs (birdview §2). Возвращает причину прерывания. */
  private async pause(ms: number, opts: { challenge?: boolean } = {}): Promise<StopCause | null> {
    const until = this.deps.clock.now() + ms;
    let lastChallengeCheck = 0;
    for (;;) {
      const cause = await this.guard();
      if (cause) return cause;
      if (opts.challenge) {
        const now = this.deps.clock.now();
        if (now - lastChallengeCheck >= 2_000) {
          lastChallengeCheck = now;
          await this.checkChallenge();
        }
      }
      const now = this.deps.clock.now();
      if (now >= until) return null;
      await this.deps.clock.sleep(Math.min(this.cfg.cancelPollMs, until - now));
    }
  }

  /** Н-4: чат занят чужим ходом/черновиком — ждём освобождения, лимит chatBusyWaitMs. */
  private async waitChatFree(startedAt: number): Promise<void> {
    const deadline = startedAt + this.cfg.chatBusyWaitMs;
    for (;;) {
      if (!(await this.deps.driver.chatBusy())) return;
      const cause = await this.pause(Math.min(this.cfg.cancelPollMs, deadline - this.deps.clock.now()), { challenge: true });
      if (cause) throw new CancelledDuringWait(cause, false); // до отправки: поле чистое — стирать нечего
      if (this.deps.clock.now() >= deadline) {
        throw new TurnError(TURN_ERROR.CHAT_BUSY, "чат занят чужим ходом или черновиком дольше 120 с (Н-4)");
      }
    }
  }

  /** П-6: капча / принудительный выход / ограничение аккаунта — фатальная остановка. */
  private async checkChallenge(): Promise<void> {
    const challenge = await this.deps.driver.challenge();
    if (challenge) {
      this.log.event(EVENT.CHALLENGE, `${challenge.kind}: ${challenge.detail} — мост прекращает отправки (П-6)`);
      throw new BridgeFatalError(FATAL_REASON.CHALLENGE, challenge.detail);
    }
  }

  /**
   * Ожидание конца ответа (Ф-6): первичный признак + вторичные в окне стабильности.
   * Пауза опроса зажата остатком срока хода: выход по maxTurnMs без хвоста в один интервал (Н-2).
   */
  private async waitAnswer(detector: CompletionDetector, startedAt: number): Promise<string> {
    for (;;) {
      const remainingMs = this.cfg.maxTurnMs - (this.deps.clock.now() - startedAt);
      if (remainingMs <= 0) {
        // Н-2: ход дольше BRIDGE_MAX_TURN_MS — ошибка хода; генерацию останавливаем
        await this.stopGenerationOrFatal();
        throw new TurnError(TURN_ERROR.TURN_TIMEOUT, `ход дольше BRIDGE_MAX_TURN_MS (${this.cfg.maxTurnMs / 1000} с)`);
      }
      const pauseMs = Math.min(detector.nextPollMs(this.cfg.pollBaseMs), remainingMs);
      const cause = await this.pause(pauseMs, { challenge: true });
      if (cause) {
        // отмена/снятие/сигнал после отправки: остановить генерацию, ответ не отдавать
        throw new CancelledDuringWait(cause, true);
      }
      const snapshot: AnswerSnapshot = await this.deps.driver.readAnswer();
      if (!(await this.deps.driver.onDomain())) {
        throw new BridgeFatalError(FATAL_REASON.LEFT_DOMAIN, `вкладка ушла из домена платформы (Ф-7)`);
      }
      await this.checkChallenge();
      const markdown = htmlToMarkdown(snapshot.html);
      const streamIdle = this.deps.probe ? this.deps.probe.idleMs() > 1_500 : undefined;
      if (detector.push({ busy: snapshot.busy, sendIdle: snapshot.sendIdle, text: markdown, streamIdle }, this.deps.clock.now()) === "complete") {
        return detector.stableText;
      }
    }
  }

  /** «Стоп» + ожидание холостого состояния ≤ 30 с (Ф-1, birdview §2). */
  private async stopGenerationOrFatal(): Promise<void> {
    await this.deps.driver.stopGeneration();
    const deadline = this.deps.clock.now() + this.cfg.stopWaitMs;
    for (;;) {
      const snapshot = await this.deps.driver.readAnswer().catch(() => ({ busy: false, sendIdle: true, html: "" }));
      if (!snapshot.busy) return;
      if (this.deps.clock.now() >= deadline) {
        throw new BridgeFatalError(FATAL_REASON.GEN_NOT_STOPPED, "платформа не остановила генерацию за 30 с");
      }
      await this.deps.clock.sleep(this.cfg.cancelPollMs);
    }
  }

  /** Ожидание result.ack (фаза «подтверждён»); мягкая остановка прекращает ожидание. */
  private async waitAck(): Promise<boolean> {
    const deadline = this.deps.clock.now() + this.cfg.ackWaitMs;
    for (;;) {
      if (await hasAck(this.dir)) return true;
      if (this.deps.stop.stopped) return false;
      if (this.deps.clock.now() >= deadline) return false;
      await this.deps.clock.sleep(Math.min(this.cfg.cancelPollMs, deadline - this.deps.clock.now()));
    }
  }

  /** Закрытие отменённого/снятого хода (Ф-1): до отправки — стереть поле; после — «Стоп». */
  private async closeCancelled(cause: StopCause, afterSend: boolean): Promise<TurnOutcome> {
    if (afterSend) {
      await this.stopGenerationOrFatal();
    } else if (this.typed) {
      await this.deps.driver.clearComposer().catch(() => {});
    }
    // Н-6: ход, уже отправленный в платформу, при остановке закрывается ОШИБКОЙ хода
    if (cause === "signal" && afterSend) {
      const message = "мост остановлен оператором после отправки (Н-6)";
      await this.writeClose({ status: "error", code: TURN_ERROR.STOPPED, message });
      this.log.event(EVENT.TURN_ERROR, `STOPPED: ${message}`);
      return { kind: "error", code: TURN_ERROR.STOPPED, message, ms: 0 };
    }
    const outcome: TurnOutcome = { kind: "cancelled", cause, afterSend, ms: 0 };
    await this.writeClose({
      status: "cancelled",
      code: cause === "alive" ? "ALIVE_EXPIRED" : cause === "signal" ? "SIGNAL" : "CANCEL",
      message: cause === "alive" ? "плагин не пульсирует — ход снят (birdview §3)" : cause === "signal" ? "мост остановлен оператором до отправки" : "ход отменён плагином",
    });
    this.log.event(EVENT.TURN_CANCEL, `ход снят (${cause}${afterSend ? ", после отправки" : ""}), ответ не отдан`);
    return outcome;
  }

  /** Закрытие хода ошибкой (Н-3): ход падает, мост работает дальше. */
  async closeWithError(error: unknown): Promise<TurnOutcome> {
    if (error instanceof CancelledDuringWait) {
      return this.closeCancelled(error.cause, error.afterSend);
    }
    let code: string;
    let message: string;
    if (isDriverFailure(error)) {
      // composer-missing → фатально (birdview §3); прочие сбои страницы — ошибка хода
      if (error.kind === "composer-missing") {
        throw new BridgeFatalError(FATAL_REASON.NO_COMPOSER, error.detail);
      }
      code = TURN_ERROR.PLATFORM_ERROR;
      message = error.detail;
    } else if (error instanceof TurnError) {
      code = error.code;
      message = error.message;
    } else {
      code = TURN_ERROR.PLATFORM_ERROR;
      message = errorMessage(error);
    }
    await this.writeClose({ status: "error", code, message });
    this.log.event(EVENT.TURN_ERROR, `${code}: ${message}`);
    return { kind: "error", code, message, ms: 0 };
  }

  private async writeClose(result: { status: "error" | "cancelled"; code: string; message: string }): Promise<void> {
    if (!(await stillOwned(this.dir, this.epoch))) return; // ход уже не наш — результат пишет перехватчик
    let written: boolean;
    try {
      written = await writeResult(this.dir, { ...result, traceId: this.job.task.traceId });
    } catch (error) {
      // запись не удалась по вине диска (полон, ввод-вывод) — фатально (birdview §3)
      throw new BridgeFatalError(FATAL_REASON.DISK_WRITE, `result.json не записан: ${result.code}: ${errorMessage(error)}`);
    }
    if (!written) return; // результат уже создал перехватчик — штатная гонка O_EXCL, не ошибка диска (Н-1)
    await writeState(this.dir, this.epoch, "result").catch(() => {});
  }
}

/** Внутренний сигнал «ход снят во время ожидания» — превращается в closeCancelled. */
class CancelledDuringWait extends Error {
  readonly cause: StopCause;
  readonly afterSend: boolean;
  constructor(cause: StopCause, afterSend: boolean) {
    super(`ход снят во время ожидания: ${cause}`);
    this.cause = cause;
    this.afterSend = afterSend;
  }
}

/** Сбой драйвера распознаётся структурно: Error с полем kind (driverFailure()). */
function isDriverFailure(error: unknown): error is DriverFailure {
  return (
    error instanceof Error &&
    "kind" in error &&
    "detail" in error &&
    ((error as DriverFailure).kind === "composer-missing" || (error as DriverFailure).kind === "platform")
  );
}

function fieldsLogger(log: Logger, fields: { trace: string; turn: string }): Logger {
  return {
    event: (code, message, extra) => log.event(code, message, { ...fields, ...extra }),
    raw: (message) => log.raw(message),
  };
}
