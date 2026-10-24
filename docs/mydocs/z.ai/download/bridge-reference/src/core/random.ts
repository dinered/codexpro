// Источник случайности (П-5): ГСЧ засеивается из crypto при каждом запуске моста,
// «машинные» паттерны запрещены. В тестах — сеемый ГСЧ: воспроизводимость прогонов.

import { randomBytes } from "node:crypto";

export interface Random {
  /** [0; 1) */
  next(): number;
  /** Целое [0; max) */
  int(max: number): number;
  /** Случайный элемент */
  pick<T>(items: readonly T[]): T;
}

export class CryptoRandom implements Random {
  next(): number {
    return randomBytes(4).readUInt32LE(0) / 0x1_0000_0000;
  }
  int(max: number): number {
    return Math.floor(this.next() * max);
  }
  pick<T>(items: readonly T[]): T {
    if (!items.length) throw new Error("pick: пустой список — вызову предшествует ошибка в логике");
    return items[this.int(items.length)]!;
  }
}

/** mulberry32 — быстрый сеемый ГСЧ только для тестов. */
export class SeededRandom implements Random {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b_79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  }
  int(max: number): number {
    return Math.floor(this.next() * max);
  }
  pick<T>(items: readonly T[]): T {
    if (!items.length) throw new Error("pick: пустой список — вызову предшествует ошибка в логике");
    return items[this.int(items.length)]!;
  }
}
