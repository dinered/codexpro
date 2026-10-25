// Контрактный набор протокола (Ф-9): мост против заглушки «человек».
// Каждая проверка — наблюдаемое обязательство birdview v2.1: точка невозврата,
// отмена до/после, идемпотентность, снятие по alive, темп, Н-1 при перехвате.

import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ManualClock } from "../../src/core/clock.ts";
import { SeededRandom } from "../../src/core/random.ts";
import { createLogger } from "../../src/core/log.ts";
import { CrashError } from "../../src/core/errors.ts";
import { Pacer } from "../../src/pace/pace.ts";
import type { PaceConfig } from "../../src/pace/pace.ts";
import { Metrics } from "../../src/metrics/metrics.ts";
import { HumanDriver, type HumanScenario } from "../../src/driver/human.ts";
import { Bridge } from "../../src/bridge/loop.ts";
import type { CrashPoint } from "../../src/bridge/turn.ts";
import { PluginClient } from "../../plugin-client/client.ts";
import { testConfig } from "../helpers/harness.ts";
import { readResult, ackResult } from "../../src/protocol/result.ts";
import { journalSize, journalSend } from "../../src/protocol/journal.ts";
import { readLatestState, writeState } from "../../src/protocol/state.ts";
import { createClaim } from "../../src/protocol/claim.ts";
import type { BridgeConfig } from "../../src/config.ts";
import type { NetworkProbe } from "../../src/driver/cdp-stream.ts";

interface Ctx {
  root: string;
  clock: ManualClock;
  client: PluginClient;
  driver: HumanDriver;
  lines: string[];
  stop: { stopped: boolean };
  seed: number;
}

/** Пульс плагина заметно чаще aliveTtl (10 с) — вне гонки границы TTL. */
const ALIVE = { aliveEveryMs: 2_000 } as const;

interface Run {
  settled: boolean;
  done: Promise<unknown>;
}

async function makeCtx(scenario: HumanScenario = {}, seed = 42): Promise<Ctx> {
  const root = await mkdtemp(join(tmpdir(), "contract-"));
  const clock = new ManualClock(1_700_000_000_000);
  const lines: string[] = [];
  const log = createLogger((line) => lines.push(line), () => clock.now());
  const client = new PluginClient(root, clock, new SeededRandom(seed + 500), log);
  const driver = new HumanDriver(scenario, clock);
  return { root, clock, client, driver, lines, stop: { stopped: false }, seed };
}

function bridgeFor(
  ctx: Ctx,
  crash?: (point: CrashPoint) => void,
  overrides: Partial<Omit<BridgeConfig, "pace">> & { pace?: Partial<PaceConfig> } = {},
  probe: NetworkProbe | null = null,
): Run {
  const config = testConfig(ctx.root, overrides);
  const bridge = new Bridge({
    cfg: config,
    driver: ctx.driver,
    pacer: new Pacer(config.pace, new SeededRandom(ctx.seed + 1)),
    clock: ctx.clock,
    rand: new SeededRandom(ctx.seed + 2),
    log: createLogger((line) => ctx.lines.push(line), () => ctx.clock.now()),
    metrics: new Metrics(null, "metrics.json", ctx.clock, createLogger(() => {}, () => ctx.clock.now())),
    probe,
    stop: ctx.stop,
    crash,
  });
  const run: Run = { settled: false, done: Promise.resolve() };
  run.done = bridge
    .run()
    .then((value) => {
      run.settled = true;
      return value;
    })
    .catch((error: unknown) => {
      run.settled = true;
      return error;
    });
  return run;
}

/** Микропауза реального времени: fs-цепочки моста догоняют подставные часы
 *  (readdir/writeState исполняются в реальном времени, часы их не ждут). */
const realTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

/** Остановить мост мягко и дождаться выхода из run() (Н-6). */
async function stopBridge(ctx: Ctx, run: Run): Promise<unknown> {
  ctx.stop.stopped = true;
  for (let i = 0; i < 100 && !run.settled; i++) {
    await ctx.clock.advanceAsync(300);
    await realTick();
  }
  assert.ok(run.settled, "мост не остановился после мягкого сигнала");
  return run.done;
}

async function pump(ctx: Ctx, until: () => boolean | Promise<boolean>, budgetMs = 120_000): Promise<boolean> {
  const deadline = ctx.clock.now() + budgetMs;
  for (;;) {
    if (await until()) return true;
    if (ctx.clock.now() >= deadline) {
      if (!until()) console.error("--- журнал стенда ---\n" + ctx.lines.join("\n"));
      return until();
    }
    await ctx.clock.advanceAsync(200);
    await realTick();
  }
}

async function cleanup(ctx: Ctx): Promise<void> {
  ctx.client.close();
  await rm(ctx.root, { recursive: true, force: true });
}

test("контракт 1: полный ход — результат, ack, журнал, подтверждён (Ф-2, Ф-5, Ф-6)", async () => {
  const ctx = await makeCtx({ generationMs: 1_500 });
  try {
    const task = await ctx.client.put("вопрос про мост", { aliveEveryMs: 2_000 });
    const run = bridgeFor(ctx);
    await pump(ctx, async () => (await readResult(join(ctx.root, task.id))) !== null);
    const result = await readResult(join(ctx.root, task.id));
    assert.equal(result?.status, "ok");
    assert.match(result?.markdown ?? "", /вопрос про мост/);
    assert.equal(ctx.driver.sendCount, 1);
    assert.equal(await journalSize(join(ctx.root, task.id)), 1);
    // плагин подтверждает — мост доходит до фазы confirmed (birdview §2)
    const acked = await ctx.client.waitResult(task.id, 30_000);
    assert.equal(acked?.status, "ok");
    await pump(ctx, async () => (await readLatestState(join(ctx.root, task.id)))?.phase === "confirmed");
    assert.equal((await readLatestState(join(ctx.root, task.id)))?.phase, "confirmed");
    await ctx.client.dispose(task.id);
    assert.ok(!ctx.lines.some((line) => line.includes("TURN_ERROR")), "в журнале не должно быть ошибок");
    await stopBridge(ctx, run);
  } finally {
    await cleanup(ctx);
  }
});

test("контракт 2: пустая задача — ошибка хода, мост жив (Ф-3)", async () => {
  const ctx = await makeCtx();
  try {
    const task = await ctx.client.put("   ", ALIVE);
    const run = bridgeFor(ctx);
    await pump(ctx, async () => (await readResult(join(ctx.root, task.id))) !== null);
    const result = await readResult(join(ctx.root, task.id));
    assert.equal(result?.status, "error");
    assert.equal(result?.code, "EMPTY_TASK");
    assert.equal(ctx.driver.sendCount, 0);
    assert.equal(ctx.driver.bindCount, 0, "до браузера дело не дошло");
    await stopBridge(ctx, run);
  } finally {
    await cleanup(ctx);
  }
});

test("контракт 3: отмена до отправки — поле стёрто, отменено, без отправки (Ф-1)", async () => {
  const ctx = await makeCtx();
  try {
    const task = await ctx.client.put("не успеет уйти", ALIVE);
    const run = bridgeFor(ctx); // pace пауза ≥ 1000 мс — успеваем отменить
    await ctx.clock.advanceAsync(300);
    await ctx.client.cancel(task.id);
    await pump(ctx, async () => (await readResult(join(ctx.root, task.id))) !== null);
    const result = await readResult(join(ctx.root, task.id));
    assert.equal(result?.status, "cancelled");
    assert.equal(ctx.driver.sendCount, 0);
    assert.equal(ctx.driver.composer, ""); // введённое стёрто (Ф-1)
    await stopBridge(ctx, run);
  } finally {
    await cleanup(ctx);
  }
});

test("контракт 4: отмена после отправки — «Стоп», холостое, ответ не отдан (Ф-1)", async () => {
  const ctx = await makeCtx({ generationMs: 30_000 });
  try {
    const task = await ctx.client.put("долгая генерация", ALIVE);
    const run = bridgeFor(ctx);
    await pump(ctx, () => ctx.driver.sendCount === 1);
    await ctx.client.cancel(task.id);
    await pump(ctx, async () => (await readResult(join(ctx.root, task.id))) !== null);
    const result = await readResult(join(ctx.root, task.id));
    assert.equal(result?.status, "cancelled");
    assert.equal(result?.markdown, undefined);
    assert.ok(ctx.driver.stopCount >= 1, "генерация не остановлена средствами платформы");
    assert.equal(ctx.driver.composer, "");
    await stopBridge(ctx, run);
  } finally {
    await cleanup(ctx);
  }
});

test("контракт 5: мягкая остановка после отправки — ошибка хода STOPPED (Н-6)", async () => {
  const ctx = await makeCtx({ generationMs: 30_000 });
  try {
    const task = await ctx.client.put("прервано оператором", ALIVE);
    const run = bridgeFor(ctx);
    await pump(ctx, () => ctx.driver.sendCount === 1);
    ctx.stop.stopped = true; // первый сигнал
    await pump(ctx, async () => (await readResult(join(ctx.root, task.id))) !== null);
    const result = await readResult(join(ctx.root, task.id));
    assert.equal(result?.status, "error");
    assert.equal(result?.code, "STOPPED"); // брошенных ходов без ответа нет (Н-6)
    await stopBridge(ctx, run);
  } finally {
    await cleanup(ctx);
  }
});

test("контракт 6: занятый чат — мост ждёт, лимит, ошибка хода (Н-4)", async () => {
  const ctx = await makeCtx({ foreignDraft: "чужой черновик" });
  try {
    const task = await ctx.client.put("вопрос", ALIVE);
    const run = bridgeFor(ctx, undefined, { chatBusyWaitMs: 2_000 });
    await pump(ctx, async () => (await readResult(join(ctx.root, task.id))) !== null);
    const result = await readResult(join(ctx.root, task.id));
    assert.equal(result?.status, "error");
    assert.equal(result?.code, "CHAT_BUSY");
    assert.equal(ctx.driver.sendCount, 0); // в чужой ход не вмешались
    await stopBridge(ctx, run);
  } finally {
    await cleanup(ctx);
  }
});

test("контракт 7: journal уже содержит task_id — отказ без браузера (Н-1)", async () => {
  const ctx = await makeCtx();
  try {
    const task = await ctx.client.put("повторно не отправится", ALIVE);
    const dir = join(ctx.root, task.id);
    // имитация смерти после записи журнала: claim.1 + state=preparing + journal, lease не создан
    await createClaim(dir, 1);
    await writeState(dir, 1, "preparing");
    await journalSend(dir, task.id, ctx.clock.now());
    const run = bridgeFor(ctx);
    await pump(ctx, async () => (await readResult(dir)) !== null);
    const result = await readResult(dir);
    assert.equal(result?.status, "error");
    assert.equal(result?.code, "IDEMPOTENCY_REJECT");
    assert.equal(ctx.driver.bindCount, 0, "браузер не должен открываться (birdview §2)");
    assert.equal(ctx.driver.sendCount, 0);
    await stopBridge(ctx, run);
  } finally {
    await cleanup(ctx);
  }
});

test("контракт 8: alive истёк во время паузы темпа — ход снят плагином (birdview §3)", async () => {
  const ctx = await makeCtx();
  try {
    const task = await ctx.client.put("плагин умёр");
    ctx.client.close(); // пульс остановлен — результат никто не прочитает
    const run = bridgeFor(ctx, undefined, { pace: { minIntervalMs: 15_000 } }); // пауза дольше aliveTtl
    await pump(ctx, async () => (await readResult(join(ctx.root, task.id))) !== null, 60_000);
    const result = await readResult(join(ctx.root, task.id));
    assert.equal(result?.status, "cancelled");
    assert.equal(result?.code, "ALIVE_EXPIRED");
    assert.equal(ctx.driver.sendCount, 0);
    ctx.stop.stopped = true;
    for (let i = 0; i < 50 && !run.settled; i++) await ctx.clock.advanceAsync(300);
  } finally {
    await cleanup(ctx);
  }
});

test("контракт 9: Н-1 — мост умер на паузе темпа, второй мост перехватывает и не дублирует (Н-1)", async () => {
  const ctx = await makeCtx();
  try {
    const task = await ctx.client.put("перехват брошенного", ALIVE);
    let crashed = false;
    const first = bridgeFor(ctx, (point: CrashPoint) => {
      if (point === "pace-wait" && !crashed) {
        crashed = true;
        throw new CrashError(point); // смерть до точки невозврата
      }
    });
    await pump(ctx, () => crashed);
    assert.ok(first.settled, "первый мост должен «умереть»");
    // lease не пульсируется — перехват после аренды; alive пульсируется плагином
    const second = bridgeFor(ctx);
    await pump(ctx, async () => (await readResult(join(ctx.root, task.id))) !== null, 240_000);
    const result = await readResult(join(ctx.root, task.id));
    assert.equal(result?.status, "ok");
    assert.equal(ctx.driver.sendCount, 1, "отправка случается ровно один раз (Н-1)");
    assert.equal(await journalSize(join(ctx.root, task.id)), 1);
    await stopBridge(ctx, second);
  } finally {
    await cleanup(ctx);
  }
});

test("контракт 10: несовпавший ввод повторяется (Ф-4)", async () => {
  const ctx = await makeCtx({ glitchFirstType: true });
  try {
    const task = await ctx.client.put("введи меня как есть", ALIVE);
    const run = bridgeFor(ctx);
    await pump(ctx, async () => (await readResult(join(ctx.root, task.id))) !== null);
    const result = await readResult(join(ctx.root, task.id));
    assert.equal(result?.status, "ok"); // первый ввод сбойный, повтор удачен
    assert.equal(ctx.driver.typeCount, 2);
    await stopBridge(ctx, run);
  } finally {
    await cleanup(ctx);
  }
});

test("контракт 11: часовой предел — отказ отправки, очередь ждёт окна (П-3)", async () => {
  const ctx = await makeCtx({ generationMs: 100 });
  try {
    const t1 = await ctx.client.put("один", ALIVE);
    const t2 = await ctx.client.put("два", ALIVE);
    const t3 = await ctx.client.put("три", ALIVE);
    const pace: Partial<PaceConfig> = { hourlyWarn: 2, hourlyMax: 2 };
    const run = bridgeFor(ctx, undefined, { pace });
    await pump(ctx, async () => (await readResult(join(ctx.root, t3.id))) !== null, 240_000);
    assert.equal((await readResult(join(ctx.root, t1.id)))?.status, "ok");
    assert.equal((await readResult(join(ctx.root, t2.id)))?.status, "ok");
    const third = await readResult(join(ctx.root, t3.id));
    assert.equal(third?.status, "error");
    assert.equal(third?.code, "RATE_LIMIT");
    assert.equal(ctx.driver.sendCount, 2);
    await stopBridge(ctx, run); // окно ещё не освободилось — мягкая остановка прерывает ожидание
  } finally {
    await cleanup(ctx);
  }
});

test("контракт 12: капча — фатально, ход закрыт ошибкой, мост останавливается (П-6)", async () => {
  const ctx = await makeCtx({ challengeAt: 1_700_000_000_001 });
  try {
    const task = await ctx.client.put("вопрос", ALIVE);
    const run = bridgeFor(ctx);
    await pump(ctx, async () => (await readResult(join(ctx.root, task.id))) !== null);
    const result = await readResult(join(ctx.root, task.id));
    assert.equal(result?.status, "error");
    assert.equal(result?.code, "CHALLENGE");
    assert.equal(ctx.driver.sendCount, 0);
    assert.ok(ctx.lines.some((line) => line.includes("CHALLENGE")));
    const finish = (await stopBridge(ctx, run)) as { fatal?: string | null };
    assert.equal(finish?.fatal, "CHALLENGE");
  } finally {
    await cleanup(ctx);
  }
});

test("контракт 13: повреждённый журнал — ошибка хода JOURNAL_CORRUPT без платформы (R04)", async () => {
  const ctx = await makeCtx();
  try {
    const task = await ctx.client.put("ход с битым журналом", ALIVE);
    const dir = join(ctx.root, task.id);
    await createClaim(dir, 1);
    await writeState(dir, 1, "preparing");
    await writeFile(join(dir, "journal.jsonl"), "{ обрыв записи\n", { flag: "a" });
    const run = bridgeFor(ctx);
    await pump(ctx, async () => (await readResult(dir)) !== null);
    const result = await readResult(dir);
    assert.equal(result?.status, "error");
    assert.equal(result?.code, "JOURNAL_CORRUPT");
    assert.equal(ctx.driver.sendCount, 0, "с повреждённым журналом платформа не открывается");
    await stopBridge(ctx, run);
  } finally {
    await cleanup(ctx);
  }
});

test("контракт 14: падение между журналом и кликом — перехватчик не кликает (R05, Н-1)", async () => {
  const ctx = await makeCtx({ generationMs: 1_000 });
  try {
    const task = await ctx.client.put("не уйти дважды", ALIVE);
    let crashed = false;
    const first = bridgeFor(ctx, (point: CrashPoint) => {
      if (point === "before-click" && !crashed) {
        crashed = true;
        throw new CrashError(point); // журнал уже записан, кнопка НЕ нажата
      }
    });
    await pump(ctx, () => crashed);
    assert.ok(first.settled, "первый мост должен «умереть» между журналом и кликом");
    const second = bridgeFor(ctx);
    await pump(ctx, async () => (await readResult(join(ctx.root, task.id))) !== null, 240_000);
    const result = await readResult(join(ctx.root, task.id));
    assert.equal(result?.status, "error");
    assert.equal(result?.code, "SEND_STATE_UNKNOWN", "перехват после state=sending — отправку нельзя повторять");
    assert.equal(ctx.driver.sendCount, 0, "второго клика не было");
    assert.equal(await journalSize(join(ctx.root, task.id)), 1);
    await stopBridge(ctx, second);
  } finally {
    await cleanup(ctx);
  }
});

test("контракт 15: падение после клика — перехватчик не дублирует отправку (R08, Н-1)", async () => {
  const ctx = await makeCtx({ generationMs: 1_000 });
  try {
    const task = await ctx.client.put("ушло, но мост умер", ALIVE);
    let crashed = false;
    const first = bridgeFor(ctx, (point: CrashPoint) => {
      if (point === "after-click" && !crashed) {
        crashed = true;
        throw new CrashError(point); // клик был, результат не записан
      }
    });
    await pump(ctx, () => crashed);
    assert.ok(first.settled);
    assert.equal(ctx.driver.sendCount, 1, "первая отправка случилась");
    const second = bridgeFor(ctx);
    await pump(ctx, async () => (await readResult(join(ctx.root, task.id))) !== null, 240_000);
    const result = await readResult(join(ctx.root, task.id));
    assert.equal(result?.status, "error");
    assert.equal(result?.code, "SEND_STATE_UNKNOWN");
    assert.equal(ctx.driver.sendCount, 1, "повторной отправки нет (Н-1)");
    assert.equal(await journalSize(join(ctx.root, task.id)), 1);
    await stopBridge(ctx, second);
  } finally {
    await cleanup(ctx);
  }
});

test("контракт 16: сигнал оператора до отправки — cancelled/SIGNAL без отправки (R17, Н-6)", async () => {
  const ctx = await makeCtx();
  try {
    const task = await ctx.client.put("остановлен до отправки", ALIVE);
    const run = bridgeFor(ctx);
    // сигнал приходит строго внутри хода (в паузе темпа, до клика): иначе мост
    // вправе выйти из цикла на границе шага, не трогая непринятую очередь
    await pump(ctx, () => ctx.lines.some((line) => line.includes("PACE_PAUSE")));
    ctx.stop.stopped = true; // мягкая остановка
    await pump(ctx, async () => (await readResult(join(ctx.root, task.id))) !== null);
    const result = await readResult(join(ctx.root, task.id));
    assert.equal(result?.status, "cancelled");
    assert.equal(result?.code, "SIGNAL");
    assert.equal(ctx.driver.sendCount, 0);
    assert.equal(ctx.driver.composer, "", "введённое стёрто");
    await stopBridge(ctx, run);
  } finally {
    await cleanup(ctx);
  }
});

test("контракт 17: клиент ack+dispose сразу — очередь не ждёт ackWait закрытого хода", async () => {
  // Три детерминированных interleaving штатного ack+dispose (ревью PR #9 P2):
  //   А «до-опроса»       — клиент подтверждает и удаляет каталог ДО первого
  //                         ack-опроса моста: waitAck видит только пустоту;
  //   Б «stat-confirmed»  — dispose между stat каталога (pathExists → true) и
  //                         записью фазы confirmed: ровно окно гонки turn.ts;
  //   В «result-фаза»     — dispose между публикацией result.json и записью
  //                         фазы result: клиент получил status=ok и вправе
  //                         закрыть ход, мост ещё пишет фазу.
  // Бюджет второго хода короче ackWait: движок, дожидающийся полного
  // TURN_ACK_TIMEOUT, в бюджет не укладывается. Точные утверждения: TURN_ACK
  // именно первого хода, ни одного TURN_ACK_TIMEOUT, ни одного BRIDGE_FATAL.
  await assertAckDisposeRace("до-опроса");
  await assertAckDisposeRace("stat-confirmed");
  await assertAckDisposeRace("result-фаза");
});

/** Один interleaving контракта 17: свой стенд, свой перехват stat, свои утверждения. */
async function assertAckDisposeRace(scenario: "до-опроса" | "stat-confirmed" | "result-фаза"): Promise<void> {
  const ctx = await makeCtx({ generationMs: 100 });
  // ackWait заметно больше бюджета второго хода: старое ожидание полного
  // тайм-аута не проходит утверждение «второй ход исполнен» (ревью PR #9 P2).
  // Бюджет 8 с покрывает ход с запасом (пауза темпа ≤1 с + окно стабильности
  // детектора ~5 с) и заведомо короче ackWait
  const ackWaitMs = 20_000;
  const secondBudgetMs = 8_000;
  try {
    const first = await ctx.client.put("первый ход", ALIVE);
    const dir = join(ctx.root, first.id);
    const claimPath = join(dir, "claim.1");
    const run = bridgeFor(ctx, undefined, { ackWaitMs });

    // Детерминированный перехват stat (как в ревью-скрипте): в выбранной точке
    // клиент штатно делает ack → dispose. Условие срабатывания отделяет нужный
    // вызов от всех прочих stat — перехват срабатывает ровно один раз.
    const nativeStat = fsp.stat.bind(fsp) as (path: unknown, ...rest: unknown[]) => Promise<unknown>;
    let disposed = false;
    const ackExists = async (): Promise<boolean> => {
      try {
        await nativeStat(join(dir, "result.ack"));
        return true;
      } catch {
        return false;
      }
    };
    const resultExists = async (): Promise<boolean> => {
      try {
        await nativeStat(join(dir, "result.json"));
        return true;
      } catch {
        return false;
      }
    };
    const disposeNow = async (): Promise<void> => {
      await ackResult(dir); // штатный порядок протокола: ack → dispose (birdview §2)
      await ctx.client.dispose(first.id);
      disposed = true;
    };
    const intercept = async (path: unknown, ...rest: unknown[]): Promise<unknown> => {
      const matches =
        typeof path === "string" &&
        ((scenario === "до-опроса" && path === join(dir, "result.ack") && (await resultExists())) ||
          (scenario === "stat-confirmed" && path === dir && (await ackExists())) ||
          (scenario === "result-фаза" && path === claimPath && (await resultExists())));
      if (!matches) return nativeStat(path, ...rest);
      if (scenario === "до-опроса") {
        // dispose ДО опроса: мост увидит только исчезнувший каталог
        await disposeNow();
        return nativeStat(path).catch(() => {
          throw Object.assign(new Error("result.ack отсутствует"), { code: "ENOENT" });
        });
      }
      // dispose между stat и следующим await моста: stat вернёт «каталог был»,
      // а все последующие проверки увидят пустоту
      const info = await nativeStat(path);
      await disposeNow();
      return info;
    };
    fsp.stat = intercept as typeof fsp.stat;
    syncBuiltinESMExports();

    try {
      await pump(ctx, async () => (await readResult(dir)) !== null);
      if (scenario === "stat-confirmed") {
        // штатный порядок: клиент сначала читает и ПОДТВЕРЖДАЕТ результат, мост
        // видит ack и идёт писать фазу confirmed — dispose встанет ровно между
        // stat каталога и следующей проверкой (ревью PR #9 P1, turn.ts)
        const confirmed = await ctx.client.waitResult(first.id, 5_000);
        assert.equal(confirmed?.status, "ok", "сценарий stat-confirmed: клиент не получил результат");
      }
      assert.ok(await pump(ctx, () => disposed, 5_000), `сценарий ${scenario}: перехват не сработал`);

      // мост обязан распознать подтверждение (ack или удаление каталога после ack)
      // и продолжить очередь; фатального останова быть не должно ни в каком из сценариев
      const second = await ctx.client.put("второй ход сразу", ALIVE);
      const ok = await pump(ctx, async () => (await readResult(join(ctx.root, second.id))) !== null, secondBudgetMs);
      assert.ok(ok, `сценарий ${scenario}: второй ход не исполнен за ${secondBudgetMs} мс (бюджет короче ackWait)`);
      const got = await readResult(join(ctx.root, second.id));
      assert.equal(got?.status, "ok");
      assert.equal(ctx.driver.sendCount, 2);
      assert.ok(
        ctx.lines.some((line) => line.includes("TURN_ACK ") && line.includes(first.id)),
        `сценарий ${scenario}: подтверждение первого хода не распознано точным событием TURN_ACK`,
      );
      assert.ok(
        !ctx.lines.some((line) => line.includes("TURN_ACK_TIMEOUT")),
        `сценарий ${scenario}: закрытый ход дождался TURN_ACK_TIMEOUT — мост ждал ackWait`,
      );
      assert.ok(
        !ctx.lines.some((line) => line.includes("BRIDGE_FATAL")),
        `сценарий ${scenario}: штатный ack+dispose остановил мост:\n${ctx.lines.filter((line) => line.includes("BRIDGE_FATAL")).join("\n")}`,
      );
    } finally {
      fsp.stat = nativeStat as unknown as typeof fsp.stat;
      syncBuiltinESMExports();
      await stopBridge(ctx, run);
    }
  } finally {
    await cleanup(ctx);
  }
}

test("контракт 18: порционный ввод chunks — без двойного учёта времени, сверка Ф-4 (У-3)", async () => {
  const ctx = await makeCtx({ generationMs: 100 });
  try {
    const text = "Первое предложение про мост. Второе предложение про темп. Третье предложение про протокол.";
    const task = await ctx.client.put(text, ALIVE);
    // charsPerSec = 10: instant-база была бы ~9 с (время набора); chunks — около minInterval
    const run = bridgeFor(ctx, undefined, { inputMode: "chunks", pace: { charsPerSec: 10 } });
    await pump(ctx, async () => (await readResult(join(ctx.root, task.id))) !== null);
    const result = await readResult(join(ctx.root, task.id));
    assert.equal(result?.status, "ok");
    // Ф-4: конкатенция порций равна задаче — ход дошёл до отправки без TEXT_MISMATCH
    assert.match(result?.markdown ?? "", /Первое предложение про мост/);
    const pauseLine = ctx.lines.find((line) => line.includes("PACE_PAUSE") && line.includes("перед набором"));
    assert.ok(pauseLine, "пауза темпа записана");
    const pauseSec = Number(/пауза темпа (\d+) с/.exec(pauseLine!)?.[1] ?? 0);
    assert.ok(pauseSec < 5, `в базе паузы нет времени набора: ${pauseSec} с (instant был бы ~9 с)`);
    assert.ok(ctx.lines.some((line) => line.includes("порция ввода")), "набор шёл порциями");
    assert.equal(ctx.driver.sendCount, 1);
    await stopBridge(ctx, run);
  } finally {
    await cleanup(ctx);
  }
});

test("контракт 19: 429 от API — фатально как капча (У-2); без пробы (флаг off) поведение прежнее", async () => {
  const ctx = await makeCtx({ generationMs: 30_000 });
  try {
    const task = await ctx.client.put("невидимая защита", ALIVE);
    let resist = false;
    // заглушка NetworkProbe: сопротивление появляется ПОСЛЕ отправки (в generating)
    const probe = {
      idleMs: () => 0,
      resistance: () => (resist ? { status: 429, count: 2 } : null),
    } as unknown as NetworkProbe;
    const run = bridgeFor(ctx, undefined, {}, probe);
    await pump(ctx, () => ctx.driver.sendCount === 1);
    resist = true; // платформа начала отвечать 429 на backend-api
    await pump(ctx, async () => (await readResult(join(ctx.root, task.id))) !== null);
    const result = await readResult(join(ctx.root, task.id));
    assert.equal(result?.status, "error");
    assert.equal(result?.code, "CHALLENGE");
    assert.match(result?.message ?? "", /429/);
    assert.ok(ctx.lines.some((line) => line.includes("CHALLENGE") && line.includes("У-2")));
    const finish = (await stopBridge(ctx, run)) as { fatal?: string | null };
    assert.equal(finish?.fatal, "CHALLENGE");
  } finally {
    await cleanup(ctx);
  }
});

test("контракт 20: отмена между порциями chunks — поле стёрто, чужого черновика нет (R2)", async () => {
  const ctx = await makeCtx({ generationMs: 100 });
  try {
    const text = "Первое предложение про мост. Второе предложение про темп.";
    const task = await ctx.client.put(text, ALIVE);
    // charsPerSec = 1: общий бюджет набора упирается в потолок maxTypingMs (5 с),
    // по ~2.5 с на порцию — отмена приходит в паузе ВТОРОЙ порции, когда первая
    // уже записана в поле. R2 ревью PR #10: свой ввод учитывается с первой порции,
    // уборка при отмене между порциями обязательна (остаток = чужой черновик, Н-4)
    const run = bridgeFor(ctx, undefined, { inputMode: "chunks", pace: { charsPerSec: 1, jitter: 0 } });
    await pump(ctx, async () => ctx.driver.composer.includes("Первое"));
    assert.equal(ctx.driver.sendCount, 0, "перед отменой отправки не было");
    await ctx.client.cancel(task.id);
    await pump(ctx, async () => (await readResult(join(ctx.root, task.id))) !== null);
    const result = await readResult(join(ctx.root, task.id));
    assert.equal(result?.status, "cancelled");
    assert.equal(result?.code, "CANCEL");
    assert.equal(ctx.driver.composer, "", "набранная порция стёрта: поле не остаётся чужим черновиком");
    assert.equal(ctx.driver.sendCount, 0);
    await stopBridge(ctx, run);
  } finally {
    await cleanup(ctx);
  }
});

test("контракт 21: капча во время порционного набора — остановка до отправки (R4, П-6)", async () => {
  const ctx = await makeCtx({ challengeAt: 3_000 });
  try {
    const text = "Первое предложение про мост. Второе предложение про темп.";
    const task = await ctx.client.put(text, ALIVE);
    // charsPerSec = 1: общий бюджет набора = потолку maxTypingMs (5 с), по ~2.5 с
    // на порцию — капча (challengeAt 3 с) появляется посреди паузы ПЕРВОЙ порции.
    // R4 ревью PR #10: периодический challenge-чек в паузах набора (challenge: true)
    // ловит её ДО отправки; прежний код проверял капчу только после отправки
    // (sendCount=1, CHALLENGE останавливал мост с уже отправленным сообщением)
    const run = bridgeFor(ctx, undefined, { inputMode: "chunks", pace: { charsPerSec: 1, jitter: 0 } });
    await pump(ctx, async () => (await readResult(join(ctx.root, task.id))) !== null);
    const result = await readResult(join(ctx.root, task.id));
    assert.equal(result?.status, "error");
    assert.equal(result?.code, "CHALLENGE");
    assert.equal(ctx.driver.sendCount, 0, "отправки не было: капча поймана в паузе набора, до точки невозврата");
    const finish = (await stopBridge(ctx, run)) as { fatal?: string | null };
    assert.equal(finish?.fatal, "CHALLENGE");
  } finally {
    await cleanup(ctx);
  }
});
