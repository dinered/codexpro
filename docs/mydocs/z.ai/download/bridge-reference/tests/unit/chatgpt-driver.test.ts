// ChatGptDriver на заглушке Page (без браузера): детектор сопротивления У-1
// (кандидаты капчи + редирект на логин), «Стоп» без force (У-4). NetworkProbe —
// на подставной CDP-сессии: сигнал 403/429 (У-2). Время — подставные часы (birdview §5).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright-core";
import { ChatGptDriver } from "../../src/driver/chatgpt.ts";
import { NetworkProbe } from "../../src/driver/cdp-stream.ts";
import type { PlatformProfile } from "../../src/driver/selectors.ts";
import { ManualClock } from "../../src/core/clock.ts";

const PROFILE: PlatformProfile = {
  platform: "chatgpt",
  domain: "https://chatgpt.com/",
  start_url: "https://chatgpt.com/",
  network_probe: false,
  login_paths: "/auth/login",
  selectors: {
    composer: "composer",
    turn: "turn",
    answer: "answer",
    stop_button: "stop-btn",
    challenge: "challenge-selector",
  },
};

/** Заглушка Page: видимость кандидатов по селекторам, URL, клики с записью опций.
 *  filter({visible:true}) — фильтр на стороне Playwright (R7): возвращает только видимых. */
function stubPage(options: { url?: string; visibility?: Record<string, boolean[]>; failClick?: boolean } = {}) {
  const clicks: Array<Record<string, unknown> | undefined> = [];
  const page = {
    url: () => options.url ?? "https://chatgpt.com/",
    locator: (selector: string) => {
      const list = options.visibility?.[selector] ?? [];
      return {
        count: async () => list.length,
        nth: (index: number) => ({ isVisible: async () => list[index] ?? false }),
        filter: (_opts: { visible: boolean }) => ({
          first: () => ({ isVisible: async () => list.some(Boolean) }),
        }),
        first: () => ({
          isVisible: async () => list[0] ?? false,
          click: async (opts?: Record<string, unknown>) => {
            if (options.failClick) throw new Error("элемент не кликабелен");
            clicks.push(opts);
          },
        }),
      };
    },
  };
  return { page: page as unknown as Page, clicks };
}

test("У-4: «Стоп» — обычный клик, без force, с тайм-аутом", async () => {
  const { page, clicks } = stubPage({ visibility: { "stop-btn": [true] } });
  const driver = new ChatGptDriver(page, PROFILE);
  await driver.stopGeneration();
  assert.equal(clicks.length, 1, "клик состоялся");
  const opts = clicks[0]!;
  assert.equal("force" in opts, false, "force запрещён: попадает в невидимые элементы");
  assert.equal(opts.timeout, 2_000);
});

test("У-4: сбой клика «Стоп» не фатален для закрытия хода", async () => {
  const { page } = stubPage({ visibility: { "stop-btn": [true] }, failClick: true });
  const driver = new ChatGptDriver(page, PROFILE);
  await driver.stopGeneration(); // не бросает — генерация остановится по другим признакам
  assert.ok(true);
});

test("У-1: Turnstile — второй кандидат видим, первый спрятан: found по ВИДИМОМУ (Д-5)", async () => {
  const { page } = stubPage({ visibility: { "challenge-selector": [false, true] } });
  const driver = new ChatGptDriver(page, PROFILE);
  const challenge = await driver.challenge();
  assert.equal(challenge?.kind, "captcha");
});

test("У-1: кандидаты капчи спрятаны — сопротивления нет", async () => {
  const { page } = stubPage({ visibility: { "challenge-selector": [false, false, false] } });
  const driver = new ChatGptDriver(page, PROFILE);
  assert.equal(await driver.challenge(), null);
});

test("У-1: редирект на /auth/login — restriction без DOM-кандидатов", async () => {
  const { page } = stubPage({ url: "https://chatgpt.com/auth/login?next=/" });
  const driver = new ChatGptDriver(page, PROFILE);
  const challenge = await driver.challenge();
  assert.equal(challenge?.kind, "restriction");
  assert.match(challenge?.detail ?? "", /\/auth\/login/);
});

test("R7: 20 скрытых кандидатов + видимый 21-й — капча найдена по всему набору", async () => {
  const visibility = Array.from({ length: 20 }, () => false);
  visibility.push(true); // видимый 21-й
  const { page } = stubPage({ visibility: { "challenge-selector": visibility } });
  const driver = new ChatGptDriver(page, PROFILE);
  const challenge = await driver.challenge();
  assert.equal(challenge?.kind, "captcha", "отсечение по позиции не прячет видимого кандидата");
});

test("R7: все 21 кандидат скрыт — капчи нет", async () => {
  const visibility = Array.from({ length: 21 }, () => false);
  const { page } = stubPage({ visibility: { "challenge-selector": visibility } });
  const driver = new ChatGptDriver(page, PROFILE);
  assert.equal(await driver.challenge(), null);
});

test("У-1: обычный чат — сопротивления нет (и без редиректа на логин)", async () => {
  const { page } = stubPage({ url: "https://chatgpt.com/c/abc" });
  const driver = new ChatGptDriver(page, PROFILE);
  assert.equal(await driver.challenge(), null);
});

test("У-1: вкладка вне домена — проверка сопротивления не проводится", async () => {
  const { page } = stubPage({ url: "https://example.com/auth/login" });
  const driver = new ChatGptDriver(page, PROFILE);
  assert.equal(await driver.challenge(), null);
});

test("У-2: NetworkProbe — 403/429 на backend-api сигнал, прочее — нет", async () => {
  const handlers = new Map<string, (params: unknown) => void>();
  const session = {
    send: async () => {},
    on: (event: string, handler: (params: unknown) => void) => handlers.set(event, handler),
    off: (event: string) => handlers.delete(event),
    detach: async () => {},
  };
  const fakePage = { context: () => ({ newCDPSession: async () => session }) };
  const clock = new ManualClock(1_700_000_000_000);
  const probe = await NetworkProbe.attach(fakePage as unknown as Page, clock);
  assert.ok(probe, "подключение к подставной CDP-сессии удалось");
  const emit = (status: number, url: string) => handlers.get("Network.responseReceived")!({ response: { status, url } });

  assert.equal(probe.resistance(), null, "без ответов сигнала нет");
  emit(200, "https://chatgpt.com/backend-api/conversation");
  assert.equal(probe.resistance(), null, "200 — не сигнал");
  emit(403, "https://chatgpt.com/");
  assert.equal(probe.resistance(), null, "403 вне API чата — не сигнал");
  emit(429, "https://chatgpt.com/backend-api/conversation");
  assert.deepEqual(probe.resistance(), { status: 429, count: 1 });
  emit(403, "https://chatgpt.com/backend-api/models?history_and_updates=1");
  assert.deepEqual(probe.resistance(), { status: 403, count: 2 }, "последний статус и общий счётчик");
  assert.ok(probe.idleMs() >= 0, "активность сети отмечается");

  await probe.detach();
  assert.equal(probe.resistance(), null, "после detach сигнал сброшен");
  assert.equal(handlers.has("Network.responseReceived"), false, "обработчики сняты (detach в finally)");
});

test("R6: сторонний origin и эндпоинт внутри query — не сигналы; свой origin — сигнал", async () => {
  const handlers = new Map<string, (params: unknown) => void>();
  const session = {
    send: async () => {},
    on: (event: string, handler: (params: unknown) => void) => handlers.set(event, handler),
    off: (event: string) => handlers.delete(event),
    detach: async () => {},
  };
  const fakePage = { context: () => ({ newCDPSession: async () => session }) };
  const clock = new ManualClock(1_700_000_000_000);
  const probe = await NetworkProbe.attach(fakePage as unknown as Page, clock, "https://chatgpt.com");
  assert.ok(probe, "подключение к подставной CDP-сессии удалось");
  const emit = (status: number, url: string) => handlers.get("Network.responseReceived")!({ response: { status, url } });

  emit(429, "https://third-party.invalid/backend-api/conversation");
  assert.equal(probe.resistance(), null, "чужой origin с путём API чата — не сигнал");
  emit(429, "https://third-party.invalid/pixel?next=/backend-api/conversation");
  assert.equal(probe.resistance(), null, "эндпоинт внутри query — не сигнал (разбор URL, не подстрока)");
  emit(403, "https://chatgpt.com/pixel?next=/backend-api/conversation");
  assert.equal(probe.resistance(), null, "свой origin, но эндпоинт в query — не сигнал");
  emit(429, "https://chatgpt.com/backend-api/conversation");
  assert.deepEqual(probe.resistance(), { status: 429, count: 1 }, "свой origin и путь API чата — сигнал");

  await probe.detach();
  assert.equal(probe.resistance(), null, "после detach сигнал сброшен");
});

test("R6: без allowedOrigin origin берётся со страницы; не-http — только проверка пути", async () => {
  const handlers = new Map<string, (params: unknown) => void>();
  const session = {
    send: async () => {},
    on: (event: string, handler: (params: unknown) => void) => handlers.set(event, handler),
    off: (event: string) => handlers.delete(event),
    detach: async () => {},
  };
  const fakePage = {
    url: () => "https://chatgpt.com/",
    context: () => ({ newCDPSession: async () => session }),
  };
  const clock = new ManualClock(1_700_000_000_000);
  const probe = await NetworkProbe.attach(fakePage as unknown as Page, clock);
  assert.ok(probe, "подключение к подставной CDP-сессии удалось");
  const emit = (status: number, url: string) => handlers.get("Network.responseReceived")!({ response: { status, url } });

  emit(429, "https://third-party.invalid/backend-api/conversation");
  assert.equal(probe.resistance(), null, "origin страницы — chatgpt.com: чужой origin отфильтрован");
  emit(429, "https://chatgpt.com/backend-api/conversation");
  assert.deepEqual(probe.resistance(), { status: 429, count: 1 }, "свой origin — сигнал");

  await probe.detach();
});
