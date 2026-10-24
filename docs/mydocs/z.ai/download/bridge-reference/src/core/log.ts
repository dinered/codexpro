// Журнал в stdout (Ф-8): время UTC в ISO 8601 · код события · trace_id · текст.
// События отправки, ошибки, остановки и предупреждений темпа различимы
// эксплуатирующей командой без чтения кода — по таблице кодов в README.

export const EVENT = {
  BRIDGE_START: "BRIDGE_START", // мост запущен
  BRIDGE_STOP: "BRIDGE_STOP", // мост остановлен (сигнал оператора)
  BRIDGE_FATAL: "BRIDGE_FATAL", // фатальная остановка (birdview §3)
  SELFCHECK_FAIL: "SELFCHECK_FAIL", // самопроверка селекторов не прошла
  TURN_CLAIM: "TURN_CLAIM", // ход захвачен (эпоха N)
  TURN_INTERCEPT: "TURN_INTERCEPT", // брошенный ход перехвачен (эпоха N)
  TURN_PHASE: "TURN_PHASE", // смена фазы хода
  TURN_SEND: "TURN_SEND", // сообщение отправлено в платформу
  TURN_OK: "TURN_OK", // ответ отдан
  TURN_ERROR: "TURN_ERROR", // ошибка хода (Н-3)
  TURN_CANCEL: "TURN_CANCEL", // ход отменён/снят
  TURN_ACK: "TURN_ACK", // плагин подтвердил результат
  TURN_ACK_TIMEOUT: "TURN_ACK_TIMEOUT", // подтверждения нет — предупреждение
  QUEUE_SKIP: "QUEUE_SKIP", // битый элемент очереди пропущен (Ф-3)
  PACE_PAUSE: "PACE_PAUSE", // пауза темпа перед отправкой
  PACE_WARN: "PACE_WARN", // жёлтый порог часового окна (П-3)
  PACE_STOP: "PACE_STOP", // часовой предел достигнут (П-3)
  PACE_BACKOFF: "PACE_BACKOFF", // пауза после серии ошибок (Н-5)
  RATE_LIMIT: "RATE_LIMIT", // ход закрыт ошибкой RATE_LIMIT
  ALIVE_EXPIRED: "ALIVE_EXPIRED", // плагин не пульсирует — ход снят (birdview §3)
  CHALLENGE: "CHALLENGE", // противодействие платформы (П-6)
} as const;
export type EventCode = (typeof EVENT)[keyof typeof EVENT];

export interface LogFields {
  /** trace_id хода (task.json) — сквозная трассировка плагин → мост */
  trace?: string;
  /** id хода */
  turn?: string;
  [key: string]: string | number | boolean | undefined;
}

export type LogSink = (line: string) => void;

export interface Logger {
  event(code: EventCode, message: string, fields?: LogFields): void;
  /** Сырая строка без кода события — служебные сообщения старта/останова. */
  raw(message: string): void;
}

export function createLogger(sink: LogSink = console.log, clockNow: () => number = Date.now): Logger {
  const line = (body: string): string => `${new Date(clockNow()).toISOString()} ${body}`;
  return {
    event(code, message, fields) {
      const trace = fields?.trace ? ` trace=${fields.trace}` : "";
      const turn = fields?.turn ? ` turn=${fields.turn}` : "";
      const rest = Object.entries(fields ?? {})
        .filter(([key]) => key !== "trace" && key !== "turn" && fields![key] !== undefined)
        .map(([key, value]) => ` ${key}=${String(value)}`)
        .join("");
      sink(line(`${code}${trace}${turn}${rest} ${message}`));
    },
    raw(message) {
      sink(line(message));
    },
  };
}
