// Темп «как человек» (birdview §4, ТЗ §10): мост не отправляет сообщения быстрее,
// чем их отправил бы человек. Формулы — чистые функции (проверяются на подставных
// часах), состояние окна и серии ошибок — в Pacer. Ожидание выполняет движок хода:
// на паузах темпа мост продолжает проверять cancel/alive/владение и пульсировать lease.

import type { Random } from "../core/random.ts";

export interface PaceConfig {
  /** минимальная пауза между отправками (П-1) */
  minIntervalMs: number;
  /** скорость «набора»: время на сообщение = длина / charsPerSec (П-1) */
  charsPerSec: number;
  /** потолок времени набора: длинные задачи не растягиваются бесконечно (П-1) */
  maxTypingMs: number;
  /** доля растяжения паузы 0..1 — джиттер только растягивает (birdview §4, П-5) */
  jitter: number;
  /** сообщений за час — предупреждение в журнал (П-3) */
  hourlyWarn: number;
  /** сообщений за час — отказ отправки (П-3) */
  hourlyMax: number;
  /** ошибок платформы подряд, после которых включается пауза (Н-5) */
  errorStreakLimit: number;
  /** база паузы после серии ошибок; удваивается за каждую следующую (Н-5) */
  errorBackoffMs: number;
  /** потолок паузы после серии ошибок (Н-5) */
  maxBackoffMs: number;
}

export const DEFAULT_PACE: PaceConfig = {
  minIntervalMs: 20_000,
  charsPerSec: 5,
  maxTypingMs: 120_000,
  jitter: 0.2,
  hourlyWarn: 30,
  hourlyMax: 60,
  errorStreakLimit: 3,
  errorBackoffMs: 300_000,
  maxBackoffMs: 1_800_000,
};

export const PACE_ENV: Record<keyof PaceConfig, string> = {
  minIntervalMs: "PACE_MIN_INTERVAL_MS",
  charsPerSec: "PACE_CHARS_PER_SEC",
  maxTypingMs: "PACE_MAX_TYPING_MS",
  jitter: "PACE_JITTER",
  hourlyWarn: "PACE_HOURLY_WARN",
  hourlyMax: "PACE_HOURLY_MAX",
  errorStreakLimit: "PACE_ERROR_STREAK",
  errorBackoffMs: "PACE_ERROR_BACKOFF_MS",
  maxBackoffMs: "PACE_MAX_BACKOFF_MS",
};

export function paceFromEnv(env: Record<string, string | undefined> = process.env): PaceConfig {
  const value = (key: keyof PaceConfig): number | undefined => {
    const raw = env[PACE_ENV[key]];
    if (raw === undefined || raw === "") return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${PACE_ENV[key]}=${raw} — ожидалось неотрицательное число`);
    return parsed;
  };
  return {
    minIntervalMs: value("minIntervalMs") ?? DEFAULT_PACE.minIntervalMs,
    charsPerSec: value("charsPerSec") ?? DEFAULT_PACE.charsPerSec,
    maxTypingMs: value("maxTypingMs") ?? DEFAULT_PACE.maxTypingMs,
    jitter: value("jitter") ?? DEFAULT_PACE.jitter,
    hourlyWarn: value("hourlyWarn") ?? DEFAULT_PACE.hourlyWarn,
    hourlyMax: value("hourlyMax") ?? DEFAULT_PACE.hourlyMax,
    errorStreakLimit: value("errorStreakLimit") ?? DEFAULT_PACE.errorStreakLimit,
    errorBackoffMs: value("errorBackoffMs") ?? DEFAULT_PACE.errorBackoffMs,
    maxBackoffMs: value("maxBackoffMs") ?? DEFAULT_PACE.maxBackoffMs,
  };
}

/** Время «набора» текста человеком (П-1): длина / charsPerSec, потолок maxTypingMs. */
export function typingTimeMs(textLength: number, cfg: PaceConfig): number {
  return Math.min(cfg.maxTypingMs, Math.ceil((textLength / cfg.charsPerSec) * 1000));
}

/** База паузы (П-2): max(minIntervalMs, время набора). Джиттер применяется поверх. */
export function requiredBaseMs(textLength: number, cfg: PaceConfig): number {
  return Math.max(cfg.minIntervalMs, typingTimeMs(textLength, cfg));
}

/**
 * Пауза перед отправкой (П-2 + birdview §4):
 *   base · (1 + U[0; jitter]) − время с прошлой отправки, не меньше 0.
 * Джиттер односторонний — база никогда не опускается ниже minIntervalMs (birdview §4).
 * Первая отправка в запуске вычитает ноль: мгновенной отправки после старта нет (П-2).
 */
export function pauseBeforeSend(options: {
  now: number;
  lastSentAt: number | null;
  textLength: number;
  cfg: PaceConfig;
  rand: Random;
}): number {
  const { now, lastSentAt, textLength, cfg, rand } = options;
  const base = requiredBaseMs(textLength, cfg);
  const stretched = Math.round(base * (1 + cfg.jitter * rand.next()));
  const since = lastSentAt === null ? 0 : Math.max(0, now - lastSentAt);
  return Math.max(0, stretched - since);
}

/** Пауза после серии ошибок платформы (Н-5): 0 до лимита серии, дальше ×2, потолок. */
export function backoffAfterErrors(streak: number, cfg: PaceConfig): number {
  if (streak < cfg.errorStreakLimit) return 0;
  const extra = streak - cfg.errorStreakLimit;
  return Math.min(cfg.maxBackoffMs, cfg.errorBackoffMs * 2 ** extra);
}

/** Часовое окно П-3 в миллисекундах — единое для всех методов Pacer. */
const HOUR_MS = 3_600_000;

/** Сколько отправок в скользящем часовом окне, заканчивающемся в now (П-3). */
export function countInWindow(timestamps: number[], now: number, windowMs = HOUR_MS): number {
  const cutoff = now - windowMs;
  let count = 0;
  for (const ts of timestamps) if (ts > cutoff) count++;
  return count;
}

export type LimitGate = "ok" | "limited";

/**
 * Темп хода. Хранит окно отправок и серию ошибок; спит только вызывающий код —
 * паузы хода прерываемы (cancel/alive/сигнал проверяются каждые 500 мс, birdview §2).
 */
export class Pacer {
  readonly cfg: PaceConfig;
  private readonly rand: Random;
  private lastSentAt: number | null = null;
  private window: number[] = [];
  private streak = 0;
  private warnedAtCount = -1;

  constructor(cfg: PaceConfig, rand: Random) {
    this.cfg = cfg;
    this.rand = rand;
  }

  /** Часовое окно по фактическим отправкам (П-3): жёлтый порог — предупреждение, предел — отказ.
   *  warn — порог достигнут на ЭТОЙ проверке впервые на текущий подъём счётчика
   *  (дедупликация внутри Pacer: предупреждение ровно одно на каждое пересечение порога). */
  limitCheck(now: number): { gate: LimitGate; sentInWindow: number; warn: boolean } {
    this.pruneWindow(now);
    const sentInWindow = this.window.length;
    if (sentInWindow >= this.cfg.hourlyMax) return { gate: "limited", sentInWindow, warn: false };
    const warn = sentInWindow >= this.cfg.hourlyWarn && this.warnedAtCount < sentInWindow;
    if (warn) this.warnedAtCount = sentInWindow;
    return { gate: "ok", sentInWindow, warn };
  }

  /** Пауза перед отправкой text в момент now (мс; 0 — ждать не нужно). */
  delayFor(text: string, now: number): number {
    return pauseBeforeSend({ now, lastSentAt: this.lastSentAt, textLength: text.length, cfg: this.cfg, rand: this.rand });
  }

  /** Отметить фактическую отправку — вызывается строго после клика (точка невозврата пройдена). */
  recordSend(now: number): void {
    this.lastSentAt = now;
    this.window.push(now);
  }

  /** Успешный ход сбрасывает серию ошибок (Н-5). */
  recordSuccess(): void {
    this.streak = 0;
  }

  /** Ошибка платформы. Возвращает паузу серии (0 — серия не достигла лимита). */
  recordError(): number {
    this.streak += 1;
    return backoffAfterErrors(this.streak, this.cfg);
  }

  /** Часовой предел не считается ошибкой платформы (П-3) — серия не трогается. */
  noteRateLimit(): void {}

  /** Сколько ждать освобождения часового окна (П-3): до выхода старейшей отправки. */
  windowSlotWaitMs(now: number): number {
    this.pruneWindow(now);
    if (this.window.length < this.cfg.hourlyMax) return 0;
    return Math.max(0, this.window[0]! + HOUR_MS - now);
  }

  get errorStreak(): number {
    return this.streak;
  }

  get lastSendAt(): number | null {
    return this.lastSentAt;
  }

  /** Срез для файла метрик (birdview §1, модуль metrics). */
  snapshot(now: number): { sentLastHour: number; streak: number; backoffUntilMs: number | null } {
    return { sentLastHour: countInWindow(this.window, now), streak: this.streak, backoffUntilMs: null };
  }

  /** Окно без устаревших отметок: единая точка обрезки для всех проверок (П-3). */
  private pruneWindow(now: number): void {
    this.window = this.window.filter((ts) => ts > now - HOUR_MS);
  }
}
