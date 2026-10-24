// Общие типы моста — словарь протокола v3 (birdview §2) и коды отказов (birdview §3).
// Этот модуль не знает ни о диске, ни о браузере: его импортируют все слои.

/** Фазы хода в порядке жизненного цикла. Имена — содержимое файлов state.<N>. */
export const PHASES = [
  "claimed",
  "preparing",
  "typing",
  "sending",
  "sent",
  "generating",
  "harvesting",
  "result",
  "confirmed",
] as const;
export type Phase = (typeof PHASES)[number];

/** Фазы до точки невозврата: ход можно исполнять заново (birdview §2, «Перехват»). */
export const PRE_SEND_PHASES: readonly Phase[] = ["claimed", "preparing", "typing"];
/** Фазы после точки невозврата: повторная отправка запрещена (Н-1, Ф-7). */
export const POST_SEND_PHASES: readonly Phase[] = ["sending", "sent", "generating", "harvesting"];

export const RESULT_STATUSES = ["ok", "error", "cancelled"] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

/** task.json — ставит плагин (birdview §2). */
export interface TurnTask {
  v: 3;
  id: string;
  /** время постановки, мс от эпохи — тай-брейк очереди при равных секундах id */
  createdAt: number;
  traceId: string;
  text: string;
}

/** result.json — пишет мост ровно один раз (O_EXCL); плагин подтверждает result.ack. */
export interface TurnResult {
  status: ResultStatus;
  markdown?: string;
  code?: string;
  message?: string;
  traceId?: string;
}

/** Коды ошибок хода: ход падает, мост работает дальше (birdview §3, Н-3). */
export const TURN_ERROR = {
  /** пустая задача (Ф-3) */
  EMPTY_TASK: "EMPTY_TASK",
  /** введённый текст не совпал с задачей после повторов (Ф-4) */
  TEXT_MISMATCH: "TEXT_MISMATCH",
  /** чат занят чужим ходом/черновиком дольше лимита (Н-4) */
  CHAT_BUSY: "CHAT_BUSY",
  /** ошибка платформы (считается в серию ошибок, Н-5) */
  PLATFORM_ERROR: "PLATFORM_ERROR",
  /** платформа закончила ход пустым «готовым» ответом (Ф-6) */
  EMPTY_ANSWER: "EMPTY_ANSWER",
  /** ход дольше BRIDGE_MAX_TURN_MS (Н-2, Д-5) */
  TURN_TIMEOUT: "TURN_TIMEOUT",
  /** часовой лимит отправок достигнут (П-3, П-4); в серию ошибок не входит */
  RATE_LIMIT: "RATE_LIMIT",
  /** task_id уже в журнале отправок — повторная отправка запрещена (Н-1) */
  IDEMPOTENCY_REJECT: "IDEMPOTENCY_REJECT",
  /** владение утрачено на sending или позже — состояние отправки неизвестно (Н-6) */
  SEND_STATE_UNKNOWN: "SEND_STATE_UNKNOWN",
  /** журнал идемпотентности повреждён — решение за оператором (birdview §3) */
  JOURNAL_CORRUPT: "JOURNAL_CORRUPT",
  /** мост остановлен оператором после отправки (Н-6) */
  STOPPED: "STOPPED",
} as const;
export type TurnErrorCode = (typeof TURN_ERROR)[keyof typeof TURN_ERROR];

/** Причины фатальной остановки моста (birdview §3, Н-3 — минимальный список и дополнения birdview). */
export const FATAL_REASON = {
  /** ход перехвачен другим исполнителем (эпоха ушла вперёд) */
  OWNERSHIP_LOST: "OWNERSHIP_LOST",
  /** вкладка ушла с домена чат-платформы (Ф-7) */
  LEFT_DOMAIN: "LEFT_DOMAIN",
  /** поле ввода не появилось за лимит (10 с) */
  NO_COMPOSER: "NO_COMPOSER",
  /** платформа не остановила генерацию за 30 с */
  GEN_NOT_STOPPED: "GEN_NOT_STOPPED",
  /** капча / принудительный выход / ограничение аккаунта (П-6) */
  CHALLENGE: "CHALLENGE",
  /** spool недоступен */
  SPOOL_UNAVAILABLE: "SPOOL_UNAVAILABLE",
  /** диск полон или запись результата не удалась (birdview §3) */
  DISK_WRITE: "DISK_WRITE",
} as const;
export type FatalReason = (typeof FATAL_REASON)[keyof typeof FATAL_REASON];

/** Момент состояния страницы, который драйвер отдаёт мосту на каждом опросе (Ф-6). */
export interface AnswerSnapshot {
  /** HTML последнего ответа платформы; пусто, пока ответа нет */
  html: string;
  /** платформа генерирует (индикатор/кнопка «Стоп») — первичный признак (birdview §3) */
  busy: boolean;
  /** кнопка отправки в холостом состоянии — вторичный признак */
  sendIdle: boolean;
}

/** Признак противодействия платформы (П-6). */
export interface Challenge {
  kind: "captcha" | "logout" | "restriction";
  detail: string;
}

/** Итог хода для журнала моста и метрик. */
export type TurnOutcome =
  | { kind: "ok"; markdown: string; ms: number }
  | { kind: "error"; code: string; message: string; ms: number }
  | { kind: "cancelled"; cause: "cancel" | "alive" | "signal"; afterSend: boolean; ms: number };
