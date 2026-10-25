// Модельный тест Н-1 (birdview §5): два моста, случайные падения на каждой фазе,
// много прогонов. Инвариант: ровно один result.json на ход и не более одной
// отправки в платформу — сколько бы мостов ни умерло и ни перехватило ход.
// Время — подставное, платформа — заглушка «человек», падения — CrashError.

import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ManualClock } from "../../src/core/clock.ts";
import { SeededRandom, type Random } from "../../src/core/random.ts";
import { createLogger } from "../../src/core/log.ts";
import { CrashError, isCrash } from "../../src/core/errors.ts";
import { Pacer } from "../../src/pace/pace.ts";
import { Metrics } from "../../src/metrics/metrics.ts";
import { HumanDriver } from "../../src/driver/human.ts";
import { Bridge } from "../../src/bridge/loop.ts";
import type { CrashPoint } from "../../src/bridge/turn.ts";
import { PluginClient } from "../../plugin-client/client.ts";
import { testConfig } from "../helpers/harness.ts";
import { readResult } from "../../src/protocol/result.ts";
import { journalSize } from "../../src/protocol/journal.ts";
import { freshestLease } from "../../src/protocol/claim.ts";

const CRASH_POINTS: CrashPoint[] = [
  "after-claim",
  "preparing",
  "pace-wait",
  "typing",
  "before-state-write",
  "after-state-write",
  "before-journal",
  "before-click",
  "after-click",
  "generating",
  "before-result",
];

const ITERATIONS = Number(process.env.H1_ITERATIONS ?? 120);

/** Хаос-крючок: падение с вероятностью p, но не в уже прожатой точке этого прогона. */
function chaosFor(rand: Random, p: number, fired: Set<string>): (point: CrashPoint) => void {
  return (point: CrashPoint) => {
    if (!fired.has(point) && rand.next() < p) {
      fired.add(point);
      throw new CrashError(point); // смерть процесса: никакой уборки, владение теряется
    }
  };
}

/** Н-2 в чистом виде для самого теста: итерация не может висеть дольше лимита. */
function withTimeout(promise: Promise<void>, ms: number, seed: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`итерация ${seed} не завершилась за ${ms} мс реального времени — зависание в движке`)), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function chaosIteration(seed: number): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "h1-"));
  const clock = new ManualClock(1_700_000_000_000);
  const log = createLogger(() => {}, () => clock.now());
  const rand = new SeededRandom(seed);
  const client = new PluginClient(root, clock, new SeededRandom(seed + 9000), log);
  const stop = { stopped: false };
  const workers: { done: Promise<unknown>; settled: () => boolean }[] = [];
  // ManualClock advances promises, but real filesystem work also needs event-loop time.
  // Match the existing driveUntil harness rather than outrunning lease/alive I/O.
  const tick = async (ms: number) => {
    await clock.advanceAsync(ms);
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  try {
    const task = await client.put(`задача ${seed}`, { aliveEveryMs: 2_000 });
    const dir = join(root, task.id);
    const driver = new HumanDriver({ generationMs: 1_200 }, clock);
    const config = testConfig(root, { pace: { minIntervalMs: 1_500, jitter: 0.1 } });

    const makeBridge = (chaosRand: Random, p: number): { done: Promise<unknown>; settled: () => boolean } => {
      const fired = new Set<string>();
      const bridge = new Bridge({
        cfg: config,
        driver,
        pacer: new Pacer(config.pace, chaosRand),
        clock,
        rand: chaosRand,
        log,
        metrics: new Metrics(null, "metrics.json", clock, log),
        probe: null,
        stop,
        crash: chaosFor(chaosRand, p, fired),
      });
      let settled = false;
      const done = bridge.run().then(
        (value) => {
          settled = true;
          return value as unknown;
        },
        (error: unknown) => {
          settled = true;
          if (!isCrash(error)) throw error; // не-хаос сбой — ошибка теста
          return { crashed: true } as unknown; // смерть процесса: мост просто исчез
        },
      );
      const worker = { done, settled: () => settled };
      workers.push(worker);
      return worker;
    };

    // мост A: падает с вероятностью 0.4 в каждой размеченной точке
    const a = makeBridge(new SeededRandom(seed + 1), 0.4);
    // время идёт, пока мост A жив или не умер
    for (let i = 0; i < 20; i++) await tick(500);

    // мост B подключается позже — как рестарт супервизором
    const b = makeBridge(new SeededRandom(seed + 2), 0.3);
    const leaseStale = async (): Promise<boolean> => {
      const lease = await freshestLease(dir, clock);
      return lease === null || lease.ageMs >= config.leaseMs;
    };
    let resolved = false;
    for (let i = 0; i < 200 && !resolved; i++) {
      await tick(500);
      resolved = (await readResult(dir)) !== null;
      // оба моста мертвы и аренда протухла — дожидаться цикла впустую не нужно:
      // ход отдаём финализатору сразу (это работа, а не ожидание)
      if (!resolved && a.settled() && b.settled() && (await leaseStale())) break;
    }

    // финализатор: без хаоса — добивает брошенное (как дежурный мост)
    let finisherDone: Promise<unknown> | null = null;
    if (!resolved) {
      finisherDone = makeBridge(new SeededRandom(seed + 3), 0).done;
      for (let i = 0; i < 200 && !resolved; i++) {
        await tick(500);
        resolved = (await readResult(dir)) !== null;
      }
    }
    assert.ok(resolved, `ход не разрешён результатом (seed ${seed})`);

    // ── инварианты Н-1 ──
    const result = await readResult(dir);
    assert.ok(result, "result.json должен существовать ровно один раз (O_EXCL)");
    assert.ok(["ok", "error", "cancelled"].includes(result!.status), `неожиданный статус: ${result!.status}`);
    if (result!.status === "ok") {
      assert.match(result!.markdown ?? "", new RegExp(`задача ${seed}`));
      assert.equal(await journalSize(dir), 1, "в журнале ровно одна отправка");
      assert.equal(driver.sendCount, 1, "в платформу ушла ровно одна отправка");
    } else {
      assert.ok(
        await journalSize(dir).then((size) => size <= 1),
        "журнал не может содержать более одной отправки",
      );
      assert.ok(driver.sendCount <= 1, `отправок ${driver.sendCount} — дубль запрещён (Н-1)`);
    }
    // мягкий сигнал — только потом дожидаемся выхода живых мостов из цикла сканирования
    stop.stopped = true;
    await clock.advanceAsync(2_000);
    await a.done;
    await b.done;
    await finisherDone;
  } finally {
    stop.stopped = true;
    client.close();
    for (let i = 0; i < 40 && workers.some((w) => !w.settled()); i++) await tick(1000);
    assert.ok(workers.every((w) => w.settled()), "workers must stop before removing the temporary spool");
    await Promise.all(workers.map((w) => w.done));
    // Already-issued heartbeat writes may finish after their timers are stopped.
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
}

test(`модельный тест Н-1: ${ITERATIONS} прогонов с двумя мостами и падениями на фазах`, async () => {
  for (let seed = 1; seed <= ITERATIONS; seed++) {
    await withTimeout(chaosIteration(seed), 30_000, seed);
  }
});
