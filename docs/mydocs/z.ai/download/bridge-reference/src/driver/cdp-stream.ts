// Сетевой стрим как усиление признака конца ответа (birdview §3: «усиление при
// стабильных эндпоинтах — перехват сетевого стрима (CDP Network)»). Опционален:
// включается флагом network_probe в профиле платформы и только добавляет
// подтверждение — единственным источником решения он не бывает (Ф-6).

import type { CDPSession, Page } from "playwright-core";
import { SystemClock, type Clock } from "../core/clock.ts";

/** Сигнал сопротивления (У-2): платформа отвечает 403/429 на API-эндпоинты чата. */
export interface ResistanceSignal {
  status: number;
  count: number;
}

export class NetworkProbe {
  private session: CDPSession | null = null;
  private lastActivityAt: number;
  private resistanceCount = 0;
  private lastResistanceStatus: number | null = null;
  private readonly clock: Clock;
  /** Разрешённый origin платформы; null — проверка origin недоступна (остаётся проверка пути). */
  private readonly allowedOrigin: string | null;
  private readonly onEvent = (): void => {
    this.lastActivityAt = this.clock.now();
  };

  /** У-2: «невидимая» защита не рисует DOM — но всегда видна на транспорте.
   *  403/429 на API-эндпоинты чата — сигнал сопротивления, мост остановится (П-6). */
  private readonly onResponse = (params: { response?: { status?: number; url?: string } }): void => {
    this.onEvent();
    const status = params.response?.status;
    const url = params.response?.url ?? "";
    if ((status === 403 || status === 429) && this.isChatApiUrl(url)) {
      this.resistanceCount += 1;
      this.lastResistanceStatus = status;
    }
  };

  private constructor(clock: Clock, allowedOrigin: string | null) {
    this.clock = clock; // время — только через Clock: усиление тестируемо на подставных часах (birdview §5)
    this.lastActivityAt = clock.now();
    this.allowedOrigin = allowedOrigin;
  }

  /** Подключиться к стриму страницы; null — CDP недоступен (мост работает без усиления).
   *  allowedOrigin — origin платформы (R6): 403/429 чужого origin сигналом не считаются.
   *  Без него берётся origin страницы на момент подключения. */
  static async attach(page: Page, clock: Clock = new SystemClock(), allowedOrigin?: string): Promise<NetworkProbe | null> {
    const probe = new NetworkProbe(clock, allowedOrigin ?? pageOrigin(page));
    try {
      probe.session = await page.context().newCDPSession(page);
      await probe.session.send("Network.enable");
      probe.session.on("Network.dataReceived", probe.onEvent);
      probe.session.on("Network.responseReceived", probe.onEvent);
      probe.session.on("Network.responseReceived", probe.onResponse);
      return probe;
    } catch {
      return null;
    }
  }

  /**
   * API-эндпоинт чата (R6 ревью PR #10): совпадение ищется разбором URL, а не
   * подстрокой. Сторонний origin (https://third-party.invalid/backend-api/...)
   * и эндпоинт внутри query (.../pixel?next=/backend-api/...) — НЕ сигналы:
   * чужие сервисы и пиксели не должны останавливать мост как защита платформы.
   */
  private isChatApiUrl(raw: string): boolean {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return false;
    }
    if (this.allowedOrigin !== null && url.origin !== this.allowedOrigin) return false;
    return url.pathname.startsWith("/backend-api/");
  }

  /** Сколько мс сеть молчит. */
  idleMs(): number {
    return this.clock.now() - this.lastActivityAt;
  }

  /** У-2: последний сигнал сопротивления (403/429 на API чата); null — сигнала не было.
   *  Решение — только «стоп» (П-6): вызывавший код бросает BridgeFatalError(CHALLENGE). */
  resistance(): ResistanceSignal | null {
    if (this.lastResistanceStatus === null) return null;
    return { status: this.lastResistanceStatus, count: this.resistanceCount };
  }

  async detach(): Promise<void> {
    if (!this.session) return;
    this.session.off("Network.dataReceived", this.onEvent);
    this.session.off("Network.responseReceived", this.onEvent);
    this.session.off("Network.responseReceived", this.onResponse);
    this.resistanceCount = 0;
    this.lastResistanceStatus = null;
    try {
      await this.session.send("Network.disable");
      await this.session.detach();
    } catch {
      /* сессия могла умереть вместе с навигацией */
    }
    this.session = null;
  }
}

/** Origin страницы на момент подключения; null — не http(s) (проверка origin недоступна). */
function pageOrigin(page: Page): string | null {
  try {
    const url = new URL(page.url());
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}
