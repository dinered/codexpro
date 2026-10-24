// Стенд для контрактных и модельных тестов: временный spool, подставные часы,
// сеемый ГСЧ, перехватывающий журнал. Весь ход времени — только через rig.clock
// (продвигается тестом), реальные ожидания отсутствуют.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock } from "../../src/core/clock.ts";
import { SeededRandom, type Random } from "../../src/core/random.ts";
import { createLogger, type Logger } from "../../src/core/log.ts";
import { CrashError } from "../../src/core/errors.ts";
import type { BridgeConfig } from "../../src/config.ts";
import type { PaceConfig } from "../../src/pace/pace.ts";
import { DEFAULT_PACE, Pacer } from "../../src/pace/pace.ts";
import { HumanDriver, type HumanScenario } from "../../src/driver/human.ts";
import { Metrics } from "../../src/metrics/metrics.ts";
import { Bridge } from "../../src/bridge/loop.ts";
import type { CrashPoint, StopControl } from "../../src/bridge/turn.ts";
import { PluginClient } from "../../plugin-client/client.ts";

export function testPace(overrides: Partial<PaceConfig> = {}): PaceConfig {
  return {
    ...DEFAULT_PACE,
    minIntervalMs: 1_000,
    charsPerSec: 1_000, // набор мгновенный — паузу задаёт minIntervalMs
    maxTypingMs: 5_000,
    jitter: 0.2,
    errorStreakLimit: 3,
    errorBackoffMs: 5_000,
    maxBackoffMs: 20_000,
    ...overrides,
  };
}

export function testConfig(
  root: string,
  overrides: Partial<Omit<BridgeConfig, "pace">> & { pace?: Partial<PaceConfig> } = {},
): BridgeConfig {
  const { pace: paceOverride, ...rest } = overrides;
  return {
    root,
    driver: "human",
    selectorsPath: "",
    cdpUrl: "",
    leaseMs: 5_000,
    leaseEveryMs: 1_000,
    aliveTtlMs: 10_000,
    maxTurnMs: 60_000,
    composerWaitMs: 1_000,
    chatBusyWaitMs: 3_000,
    stopWaitMs: 2_000,
    ackWaitMs: 5_000,
    cancelPollMs: 50,
    pollBaseMs: 300,
    typeRetries: 2,
    inputMode: "instant",
    metricsDir: null,
    pace: testPace(paceOverride ?? {}),
    ...rest,
  };
}

export interface Rig {
  root: string;
  clock: ManualClock;
  rand: Random;
  lines: string[];
  log: Logger;
  client: PluginClient;
  driver: HumanDriver;
  config: BridgeConfig;
  stop: { stopped: boolean };
}

export async function makeRig(options: { scenario?: HumanScenario; pace?: Partial<PaceConfig>; cfg?: Partial<BridgeConfig>; seed?: number } = {}): Promise<Rig> {
  const seed = options.seed ?? 1;
  const root = await mkdtemp(join(tmpdir(), "bridge-test-"));
  const clock = new ManualClock(1_700_000_000_000);
  const rand = new SeededRandom(seed);
  const lines: string[] = [];
  const log = createLogger((line) => lines.push(line), () => clock.now());
  const config = testConfig(root, { ...options.cfg, pace: testPace(options.pace) });
  const driver = new HumanDriver(options.scenario ?? {}, clock);
  const client = new PluginClient(root, clock, new SeededRandom(seed + 100), log);
  return { root, clock, rand, lines, log, client, driver, config, stop: { stopped: false } };
}

export async function cleanupRig(rig: Rig): Promise<void> {
  rig.client.close();
  await rm(rig.root, { recursive: true, force: true });
}

export interface BridgeRun {
  bridge: Bridge;
  /** Promise завершения run(): падение (CrashError) попадает сюда, не роняет тест */
  done: Promise<unknown>;
}

/** Запустить мост; время двигает тест через rig.clock. */
export function startBridge(rig: Rig, crash?: (point: CrashPoint) => void, stop?: StopControl): BridgeRun {
  const bridge = new Bridge({
    cfg: rig.config,
    driver: rig.driver,
    pacer: new Pacer(rig.config.pace, rig.rand),
    clock: rig.clock,
    rand: rig.rand,
    log: rig.log,
    metrics: new Metrics(null, "metrics.json", rig.clock, rig.log),
    probe: null,
    stop: stop ?? rig.stop,
    crash,
  });
  const done = bridge.run().catch((error: unknown) => error);
  return { bridge, done };
}

/** Хаос-крючок: с вероятностью p «убивает» процесс в размеченной точке (Н-1). */
export function chaosHook(rand: Random, p: number, log: string[]): (point: CrashPoint) => void {
  return (point: CrashPoint) => {
    if (rand.next() < p) {
      log.push(point);
      throw new CrashError(point);
    }
  };
}

/**
 * Продвигать время, пока предикат не выполнится. false — бюджет исчерпан
 * (тест падает с диагностикой журнала). Между тиками — микропауза реального
 * времени: fs-цепочки моста догоняют подставные часы.
 */
export async function driveUntil(rig: Rig, predicate: () => Promise<boolean> | boolean, budgetMs = 120_000): Promise<boolean> {
  const deadline = rig.clock.now() + budgetMs;
  for (;;) {
    if (await predicate()) return true;
    if (rig.clock.now() >= deadline) return predicate();
    await rig.clock.advanceAsync(250);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
