// Заглушка «человек» (Ф-9): исполняет сторону платформы без браузера и сети.
// Контрактный набор протокола прогоняется и по мосту, и по этой заглушке —
// замена моста на другого исполнителя не требует правок плагина. Она же —
// демо-режим моста (npm run demo) и стенд для контрактных тестов.

import type { AnswerSnapshot, Challenge } from "../core/types.ts";
import type { Clock } from "../core/clock.ts";
import { driverFailure, type ChatDriver } from "./types.ts";

export interface HumanScenario {
  /** markdown-ответ «платформы»; по умолчанию — эхо задачи с заголовком */
  answerMarkdown?: string;
  /** сколько мс «платформа генерирует» после отправки */
  generationMs?: number;
  /** чужая генерация в чате до этого момента времени Clock (Н-4) */
  busyUntil?: number;
  /** чужой черновик в поле (Н-4) — очищается внешним миром не будет */
  foreignDraft?: string;
  /** платформа отказывает при отправке (ошибка хода, Н-3) */
  platformErrorOnSend?: boolean;
  /** первый ввод теряет последний символ — проверка повторов ввода (Ф-4) */
  glitchFirstType?: boolean;
  /** «готовый» ответ пуст — ошибка или лимит на стороне платформы (Ф-6) */
  emptyAnswer?: boolean;
  /** признаки ограничения аккаунта с этого момента времени (П-6) */
  challengeAt?: number;
}

/**
 * Платформа-имитация. Вся «жизнь» идёт по Clock: в тестах время двигает тест,
 * в демо — SystemClock. Генерация срабатывает по моменту отправки.
 */
export class HumanDriver implements ChatDriver {
  readonly name = "human";

  // наблюдаемые для тестов и демо
  sendCount = 0;
  stopCount = 0;
  bindCount = 0;
  typeCount = 0;
  composer = "";
  lastSentText = "";
  generationStoppedEarly = false;

  private sentAt: number | null = null;
  private readonly scenario: HumanScenario;
  private readonly clock: Clock;

  constructor(scenario: HumanScenario, clock: Clock) {
    this.scenario = scenario;
    this.clock = clock;
    if (scenario.foreignDraft !== undefined) this.composer = scenario.foreignDraft;
  }

  async bind(): Promise<void> {
    this.bindCount += 1;
  }

  async onDomain(): Promise<boolean> {
    return true;
  }

  async ensureReady(_timeoutMs: number): Promise<void> {
    /* поле ввода всегда доступно */
  }

  async chatBusy(): Promise<boolean> {
    if (this.scenario.busyUntil !== undefined && this.clock.now() < this.scenario.busyUntil) return true;
    return this.composer.trim().length > 0 || this.isGenerating();
  }

  async typeText(text: string): Promise<void> {
    this.typeCount += 1;
    this.composer = this.scenario.glitchFirstType && this.typeCount === 1 ? text.slice(0, -1) : text;
  }

  async composerText(): Promise<string> {
    return this.composer;
  }

  async clearComposer(): Promise<void> {
    this.composer = "";
  }

  async pressSend(): Promise<void> {
    if (this.scenario.platformErrorOnSend) {
      throw driverFailure("platform", "платформа отклонила отправку (имитация отказа)");
    }
    this.sendCount += 1;
    this.lastSentText = this.composer;
    this.composer = "";
    this.sentAt = this.clock.now();
    this.generationStoppedEarly = false;
  }

  async readAnswer(): Promise<AnswerSnapshot> {
    const busy = this.isGenerating();
    if (busy || this.sentAt === null) return { html: "", busy, sendIdle: !busy };
    if (this.scenario.emptyAnswer) return { html: "", busy: false, sendIdle: true };
    const markdown = this.scenario.answerMarkdown ?? `**Ответ.** Принято: «${this.lastSentText.slice(0, 80)}»`;
    const html = markdown
      .split(/\n\n+/)
      .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
      .join("");
    return { html, busy: false, sendIdle: true };
  }

  async stopGeneration(): Promise<void> {
    if (this.isGenerating()) {
      this.stopCount += 1;
      this.generationStoppedEarly = true;
      this.sentAt = null; // генерация прекращена: чат в холостом состоянии
    }
  }

  async challenge(): Promise<Challenge | null> {
    if (this.scenario.challengeAt !== undefined && this.clock.now() >= this.scenario.challengeAt) {
      return { kind: "restriction", detail: "платформа сообщает об ограничении аккаунта (имитация П-6)" };
    }
    return null;
  }

  async selftest(): Promise<void> {}

  async close(): Promise<void> {}

  private isGenerating(): boolean {
    if (this.sentAt === null || this.generationStoppedEarly) return false;
    const gen = this.scenario.generationMs ?? 0;
    return this.clock.now() < this.sentAt + gen;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
