// Запуск моста: node src/main.ts [каталог spool]
// Боевой режим: Chrome уже открыт с отладкой по CDP (профиль отдельный, порт только
// localhost); мост подключается и сам находит вкладку платформы, не найдёт — откроет.
// Драйвер human — безбраузерное демо для проверки протокола и темпа (Ф-9).

import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { SystemClock } from "./core/clock.ts";
import { CryptoRandom } from "./core/random.ts";
import { createLogger, type Logger } from "./core/log.ts";
import { errorMessage } from "./core/errors.ts";
import { bridgeConfigFromEnv, type BridgeConfig } from "./config.ts";
import { Pacer } from "./pace/pace.ts";
import { loadPlatformProfile, type PlatformProfile } from "./driver/selectors.ts";
import { ChatGptDriver } from "./driver/chatgpt.ts";
import { HumanDriver } from "./driver/human.ts";
import { NetworkProbe } from "./driver/cdp-stream.ts";
import type { ChatDriver } from "./driver/types.ts";
import { Metrics } from "./metrics/metrics.ts";
import { Bridge } from "./bridge/loop.ts";

const USAGE = "использование: node src/main.ts [--driver chatgpt|human] [каталог spool]";

// Остановка оператором (Н-6): первый SIGINT/SIGTERM — мягкая остановка (ход,
// уже отправленный в платформу, прерывается и закрывается ошибкой), второй —
// немедленный выход; брошенный ход закроет следующий мост по правилу перехвата.
const stop = { stopped: false };
let softStopping = false;
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));
function onSignal(name: string): void {
  if (softStopping) {
    console.error(`${name} повторно: немедленный выход (Н-6)`);
    process.exit(130);
  }
  softStopping = true;
  stop.stopped = true;
  console.error(`${name}: мягкая остановка — идущий ход будет закрыт; повторный ${name} — выйти сразу`);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { driver: { type: "string" } },
});
if (positionals.length > 1) {
  console.error(USAGE);
  process.exit(1);
}
const root = positionals[0] ?? process.env.BRIDGE_SPOOL ?? "";
if (!root) {
  console.error(`не указан каталог spool. ${USAGE}`);
  process.exit(1);
}

const clock = new SystemClock();
const rand = new CryptoRandom();
const log = createLogger();

try {
  // переменные — параметрами запуска поверх окружения; сам process.env не мутируем:
  // повторный вызов в тестах не наследует чужие значения
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...(values.driver ? { BRIDGE_DRIVER: values.driver } : {}),
  };
  const cfg = bridgeConfigFromEnv(root, env);
  await mkdir(cfg.root, { recursive: true });
  const metrics = new Metrics(cfg.metricsDir ?? cfg.root, "bridge-metrics.json", clock, log);
  const pacer = new Pacer(cfg.pace, rand);

  // профиль читается ОДИН раз: драйверу и решению об усилении нужен один и тот же снимок
  const profile = await loadPlatformProfile(cfg.selectorsPath);
  const driver: ChatDriver =
    cfg.driver === "human" ? new HumanDriver({}, clock) : await openChatGptDriver(cfg, profile, log);

  // усиление признака конца ответа сетевым стримом — только по флагу профиля (birdview §3)
  let probe: NetworkProbe | null = null;
  if (driver instanceof ChatGptDriver) {
    await driver.selftest();
    if (profile.network_probe) {
      probe = await NetworkProbe.attach(driver.page, clock);
    }
  }

  const bridge = new Bridge({ cfg, driver, pacer, clock, rand, log, metrics, probe, stop });
  try {
    const result = await bridge.run();
    log.raw(`отправлено сообщений за запуск: ${result.sentTotal}`);
    process.exitCode = result.fatal ? 1 : 0;
  } finally {
    await probe?.detach().catch(() => {}); // CDP-сессия усиления отвязывается при любом исходе
  }
} catch (error) {
  log.raw(`мост не работает: ${errorMessage(error)}`);
  process.exitCode = 1;
}

/** Подключение к Chrome по CDP и привязка к вкладке платформы (Ф-7). */
async function openChatGptDriver(cfg: BridgeConfig, profile: PlatformProfile, log: Logger): Promise<ChatGptDriver> {
  const browser = await chromium.connectOverCDP(cfg.cdpUrl).catch((error: unknown) => {
    throw new Error(
      `нет Chrome с отладкой на ${cfg.cdpUrl} — см. README, разделы «Запуск» (правила запуска Chrome) и «Что видит платформа»: ${errorMessage(error)}`,
    );
  });
  const pages = browser.contexts().flatMap((context) => context.pages());
  let page = pages.find((candidate) => candidate.url().startsWith(profile.domain));
  if (!page) {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    page = await context.newPage();
    await page.goto(profile.start_url, { timeout: 60_000 });
    log.raw(`вкладки ${profile.domain} не было — открыт новый чат`);
  }
  return new ChatGptDriver(page, profile);
}
