// Интерфейс платформы чата. ЕДИСТВЕННАЯ точка соприкосновения моста с «вёрсткой»:
// движок хода, протокол, темп и журнал не знают, с чем работают — web-платформа это,
// нативное приложение или заглушка. Добавление новой платформы — новая реализация
// ChatDriver + свой файл селекторов; ядро не меняется (см. ARCHITECTURE.md).

import type { AnswerSnapshot, Challenge } from "../core/types.ts";

/** Сбой драйвера. composer-missing — поле ввода не появилось (фатально у моста, birdview §3). */
export interface DriverFailure extends Error {
  kind: "composer-missing" | "platform";
  detail: string;
}

export function driverFailure(kind: DriverFailure["kind"], detail: string): DriverFailure {
  const error = new Error(`${kind}: ${detail}`) as DriverFailure;
  error.kind = kind;
  error.detail = detail;
  return error;
}

export interface ChatDriver {
  readonly name: string;

  /** Привязаться к чату (Ф-7): переход внутри домена — перепривязка; уход с домена мост увидит через onDomain(). */
  bind(): Promise<void>;

  /** Поле ввода доступно; timeoutMs — лимит «нет поля ввода» (10 с, birdview §3). */
  ensureReady(timeoutMs: number): Promise<void>;

  /** Чат занят: идёт генерация или в поле чужой текст (Н-4) — мост ждёт и не вмешивается. */
  chatBusy(): Promise<boolean>;

  /** Многострочный ввод без отправки (Ф-4). */
  typeText(text: string): Promise<void>;

  /** Дописать порцию в поле без очистки (У-3, порционный ввод). */
  appendText(text: string): Promise<void>;

  /** Текущее содержимое поля — для сверки с задачей (Ф-4). */
  composerText(): Promise<string>;

  clearComposer(): Promise<void>;

  /**
   * Только нажать «Отправить». Точка невозврата (state=sending → journal → pressSend)
   * целиком у моста — драйвер не знает про протокол.
   */
  pressSend(): Promise<void>;

  /** Момент состояния страницы для детектора конца ответа (Ф-6). */
  readAnswer(): Promise<AnswerSnapshot>;

  /** Остановить генерацию средствами платформы («Стоп», Ф-1). */
  stopGeneration(): Promise<void>;

  /** Вкладка в домене чат-платформы? (Ф-7; false — фатальная остановка моста). */
  onDomain(): Promise<boolean>;

  /** Признаки капчи / принудительного выхода / ограничения аккаунта (П-6). */
  challenge(): Promise<Challenge | null>;

  /** Самопроверка на старте: селекторы на месте, чат откликается (birdview §1). */
  selftest(): Promise<void>;

  close(): Promise<void>;
}
