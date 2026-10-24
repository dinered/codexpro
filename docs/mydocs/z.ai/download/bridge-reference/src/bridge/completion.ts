// Конец ответа (Ф-6, birdview §3): первичный признак — нет индикатора генерации /
// кнопки «Стоп»; вторичные — кнопка отправки в холостом состоянии, текст не менялся
// 3 опроса подряд в окне стабильности 3–5 с. Интервалы опроса рандомизируются (П-5).
// Преждевременный «конец» не обрывает ответ: пока busy, счётчики сбрасываются —
// пауза стрима хоть 10 с не принимается за конец ответа.

import type { Random } from "../core/random.ts";

export interface CompletionPush {
  busy: boolean;
  sendIdle: boolean;
  /** текст ответа на этот момент (markdown); сравнивается между опросами */
  text: string;
  /** сетевой стрим молчит достаточно долго (усиление, birdview §3); true — если усиление не включено */
  streamIdle?: boolean;
}

const POLL_MIN_MS = 1_200;
const POLL_MAX_MS = 2_200;
const WINDOW_MIN_MS = 3_000;
const WINDOW_MAX_MS = 5_000;
const STABLE_POLLS = 3;

export class CompletionDetector {
  private readonly rand: Random;
  private readonly windowMs: number;
  private text = "";
  private firstSeenAt = 0;
  private stablePolls = 0;

  constructor(rand: Random, windowMs?: number) {
    this.rand = rand;
    this.windowMs =
      windowMs ?? Math.round(WINDOW_MIN_MS + this.rand.next() * (WINDOW_MAX_MS - WINDOW_MIN_MS));
  }

  /** Очередной интервал опроса — рандомизированный вокруг базы (П-5).
   *  База зажимается в [POLL_MIN_MS; POLL_MAX_MS]: ноль/отрицательные в конфиге
   *  не превращают опрос в бурный цикл. */
  nextPollMs(baseMs: number): number {
    const base = Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, Math.round(baseMs)));
    const spread = Math.max(200, Math.round(base * 0.4));
    return base - spread + this.rand.int(spread * 2 + 1);
  }

  /**
   * Очередной опрос. 'complete' — совокупность признаков сошлась:
   * не busy, кнопка отправки в холостом, текст стабилен ≥3 опросов в окне 3–5 с.
   */
  push(sample: CompletionPush, now: number): "complete" | "continue" {
    if (sample.busy) {
      // генерация идёт (или стрим встал на паузу) — любые признаки недействительны
      this.text = sample.text;
      this.firstSeenAt = now;
      this.stablePolls = 0;
      return "continue";
    }
    if (sample.text !== this.text) {
      this.text = sample.text;
      this.firstSeenAt = now;
      this.stablePolls = 1;
      return "continue";
    }
    this.stablePolls += 1;
    const windowFilled = now - this.firstSeenAt >= this.windowMs;
    const sendIdle = sample.sendIdle !== false;
    const streamIdle = sample.streamIdle !== false;
    if (this.stablePolls >= STABLE_POLLS && windowFilled && sendIdle && streamIdle) return "complete";
    return "continue";
  }

  /** Стабильный текст на момент решения — мост конвертирует его один раз. */
  get stableText(): string {
    return this.text;
  }
}
