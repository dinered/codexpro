// Реальный executeTurn + spool + HumanDriver. Часы платят только запрошенный
// sleep: FS-накладные расходы не подменяют измерение бюджета порционного ввода.
import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { makeRig, cleanupRig } from "../helpers/harness.ts";
import { executeTurn, splitChunks } from "../../src/bridge/turn.ts";
import { createClaim } from "../../src/protocol/claim.ts";
import { Pacer } from "../../src/pace/pace.ts";
import { Metrics } from "../../src/metrics/metrics.ts";
import { CrashError } from "../../src/core/errors.ts";
import type { Random } from "../../src/core/random.ts";

for (const sample of [
  { name: "первая единственная порция", text: "x".repeat(180), chunks: 1, cap: 1_000, jitter: 0, draw: 0, expected: 1_000 },
  { name: "пять порций", text: "A. ".repeat(5), chunks: 5, cap: 1_000, jitter: 0, draw: 0, expected: 1_000 },
  { name: "2000 коротких порций", text: "A. ".repeat(2_000), chunks: 2_000, cap: 1_000, jitter: 0, draw: 0, expected: 1_000 },
  { name: "2000 порций с однократным джиттером", text: "A. ".repeat(2_000), chunks: 2_000, cap: 1_000, jitter: 0.5, draw: 0.5, expected: 1_250 },
  { name: "нулевой бюджет", text: "A. ".repeat(2_000), chunks: 2_000, cap: 0, jitter: 0.5, draw: 0.5, expected: 0 },
]) {
  test(`executeTurn: ${sample.name} — оплачен один typing-бюджет до отправки`, async () => {
    const rig = await makeRig({
      cfg: { inputMode: "chunks" },
      pace: { minIntervalMs: 0, charsPerSec: 1, maxTypingMs: sample.cap, jitter: sample.jitter },
    });
    const sleeps: number[] = [];
    rig.clock.sleep = async (ms) => { sleeps.push(ms); await rig.clock.advanceAsync(ms); };
    // Сценарий короче aliveTtl; для этого измерения периодические таймеры не нужны.
    // Первый настоящий alive и первый lease пишутся штатно в реальный spool.
    rig.clock.interval = () => () => {};
    const rand: Random = { next: () => sample.draw, int: () => 0, pick: (xs) => xs[0]! };
    let reachedClick = false;
    try {
      const task = await rig.client.put(sample.text);
      const dir = join(rig.root, task.id);
      assert.equal(await createClaim(dir, 1), true);
      const startedAt = rig.clock.now();
      await assert.rejects(executeTurn({
        cfg: rig.config, clock: rig.clock, rand, log: rig.log,
        pacer: new Pacer(rig.config.pace, rand), driver: rig.driver,
        metrics: new Metrics(null, "metrics.json", rig.clock, rig.log), probe: null, stop: rig.stop,
        crash: (point) => {
          if (point === "before-click") { reachedClick = true; throw new CrashError(point); }
        },
      }, { dir, task, epoch: 1, prevPhase: null }), CrashError);
      assert.equal(reachedClick, true, "измерен весь ввод, до фактической отправки");
      assert.equal(splitChunks(sample.text).length, sample.chunks);
      assert.equal(rig.driver.composer, sample.text, "Ф-4: полный текст введён без потерь");
      assert.equal(sleeps.reduce((sum, ms) => sum + ms, 0), sample.expected, "фактически оплачиваемые паузы равны бюджету");
      assert.equal(rig.clock.now() - startedAt, sample.expected);
      assert.equal(rig.driver.sendCount, 0, "контроль останавливается непосредственно перед click");
    } finally {
      await cleanupRig(rig);
    }
  });
}
