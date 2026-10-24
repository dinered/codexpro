// Все переменные окружения моста в одном месте (Д-5). Нормативные значения —
// из ТЗ §4/§10 и birdview: LEASE_MS 35 000, PACE_* — по П-1.

import { paceFromEnv, type PaceConfig } from "./pace/pace.ts";

export type DriverKind = "chatgpt" | "human";

export interface BridgeConfig {
  /** каталог spool (позиционный аргумент запуска) */
  root: string;
  driver: DriverKind;
  /** профиль платформы: адрес и селекторы (birdview §1) */
  selectorsPath: string;
  /** адрес Chrome с отладкой (CDP) */
  cdpUrl: string;
  /** аренда хода (ТЗ §4): нормативные 35 000 мс */
  leaseMs: number;
  /** период пульса владельца (birdview §2) */
  leaseEveryMs: number;
  /** срок живости плагина: 2 × LEASE_MS = 70 000 мс (birdview §2) */
  aliveTtlMs: number;
  /** срок хода, Д-5 (birdview §3) */
  maxTurnMs: number;
  /** «нет поля ввода» (birdview §3) */
  composerWaitMs: number;
  /** «чужой ход/черновик в поле» (Н-4, birdview §3) */
  chatBusyWaitMs: number;
  /** ожидание холостого состояния после «Стоп» (Ф-1) */
  stopWaitMs: number;
  /** ожидание result.ack от плагина (birdview §2) */
  ackWaitMs: number;
  /** период проверок cancel/alive/владения в ожиданиях (birdview §2) */
  cancelPollMs: number;
  /** база опроса ответа; фактические интервалы рандомизируются (П-5, Ф-6) */
  pollBaseMs: number;
  /** повторы ввода при несовпадении (Ф-4): первичный ввод + N повторов */
  typeRetries: number;
  /** каталог файла метрик; "off" — выключить */
  metricsDir: string | null;
  pace: PaceConfig;
}

export const BRIDGE_DEFAULTS = {
  driver: "chatgpt",
  selectorsPath: "selectors/chatgpt.yaml",
  cdpUrl: "http://127.0.0.1:9222",
  leaseMs: 35_000,
  leaseEveryMs: 10_000,
  aliveTtlMs: 70_000,
  maxTurnMs: 1_800_000,
  composerWaitMs: 10_000,
  chatBusyWaitMs: 120_000,
  stopWaitMs: 30_000,
  ackWaitMs: 120_000,
  cancelPollMs: 500,
  pollBaseMs: 1_500,
  typeRetries: 2,
} as const;

function num(name: string, fallback: number, env: Record<string, string | undefined>): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name}=${raw} — ожидалось неотрицательное число`);
  return parsed;
}

export function bridgeConfigFromEnv(
  root: string,
  env: Record<string, string | undefined> = process.env,
): BridgeConfig {
  const driver = (env.BRIDGE_DRIVER ?? BRIDGE_DEFAULTS.driver) as DriverKind;
  if (driver !== "chatgpt" && driver !== "human") throw new Error(`BRIDGE_DRIVER=${driver} — ожидалось chatgpt или human`);
  const metricsDir = env.BRIDGE_METRICS === "off" ? null : (env.BRIDGE_METRICS ?? null);
  return {
    root,
    driver,
    selectorsPath: env.BRIDGE_SELECTORS ?? BRIDGE_DEFAULTS.selectorsPath,
    cdpUrl: env.BRIDGE_CDP_URL ?? BRIDGE_DEFAULTS.cdpUrl,
    leaseMs: num("BRIDGE_LEASE_MS", BRIDGE_DEFAULTS.leaseMs, env),
    leaseEveryMs: num("BRIDGE_LEASE_EVERY_MS", BRIDGE_DEFAULTS.leaseEveryMs, env),
    aliveTtlMs: num("BRIDGE_ALIVE_TTL_MS", BRIDGE_DEFAULTS.aliveTtlMs, env),
    maxTurnMs: num("BRIDGE_MAX_TURN_MS", BRIDGE_DEFAULTS.maxTurnMs, env),
    composerWaitMs: num("BRIDGE_COMPOSER_WAIT_MS", BRIDGE_DEFAULTS.composerWaitMs, env),
    chatBusyWaitMs: num("BRIDGE_CHAT_BUSY_WAIT_MS", BRIDGE_DEFAULTS.chatBusyWaitMs, env),
    stopWaitMs: num("BRIDGE_STOP_WAIT_MS", BRIDGE_DEFAULTS.stopWaitMs, env),
    ackWaitMs: num("BRIDGE_ACK_WAIT_MS", BRIDGE_DEFAULTS.ackWaitMs, env),
    cancelPollMs: num("BRIDGE_CANCEL_POLL_MS", BRIDGE_DEFAULTS.cancelPollMs, env),
    pollBaseMs: num("BRIDGE_POLL_MS", BRIDGE_DEFAULTS.pollBaseMs, env),
    typeRetries: num("BRIDGE_TYPE_RETRIES", BRIDGE_DEFAULTS.typeRetries, env),
    metricsDir,
    pace: paceFromEnv(env),
  };
}
