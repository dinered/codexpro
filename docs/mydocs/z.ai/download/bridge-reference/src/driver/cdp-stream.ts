// Сетевой стрим как усиление признака конца ответа (birdview §3: «усиление при
// стабильных эндпоинтах — перехват сетевого стрима (CDP Network)»). Опционален:
// включается флагом network_probe в профиле платформы и только добавляет
// подтверждение — единственным источником решения он не бывает (Ф-6).

import type { CDPSession, Page } from "playwright-core";
import { SystemClock, type Clock } from "../core/clock.ts";

export class NetworkProbe {
  private session: CDPSession | null = null;
  private lastActivityAt: number;
  private readonly clock: Clock;
  private readonly onEvent = (): void => {
    this.lastActivityAt = this.clock.now();
  };

  private constructor(clock: Clock) {
    this.clock = clock; // время — только через Clock: усиление тестируемо на подставных часах (birdview §5)
    this.lastActivityAt = clock.now();
  }

  /** Подключиться к стриму страницы; null — CDP недоступен (мост работает без усиления). */
  static async attach(page: Page, clock: Clock = new SystemClock()): Promise<NetworkProbe | null> {
    const probe = new NetworkProbe(clock);
    try {
      probe.session = await page.context().newCDPSession(page);
      await probe.session.send("Network.enable");
      probe.session.on("Network.dataReceived", probe.onEvent);
      probe.session.on("Network.responseReceived", probe.onEvent);
      return probe;
    } catch {
      return null;
    }
  }

  /** Сколько мс сеть молчит. */
  idleMs(): number {
    return this.clock.now() - this.lastActivityAt;
  }

  async detach(): Promise<void> {
    if (!this.session) return;
    this.session.off("Network.dataReceived", this.onEvent);
    this.session.off("Network.responseReceived", this.onEvent);
    try {
      await this.session.send("Network.disable");
      await this.session.detach();
    } catch {
      /* сессия могла умереть вместе с навигацией */
    }
    this.session = null;
  }
}
