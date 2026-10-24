import {mkdir, readFile, readdir, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium, type Browser} from 'playwright-core';
import {SystemClock} from '../src/core/clock.ts';
import {CryptoRandom} from '../src/core/random.ts';
import {createLogger} from '../src/core/log.ts';
import {bridgeConfigFromEnv} from '../src/config.ts';
import {Pacer} from '../src/pace/pace.ts';
import {loadPlatformProfile} from '../src/driver/selectors.ts';
import {Metrics} from '../src/metrics/metrics.ts';
import {Bridge} from '../src/bridge/loop.ts';
import {scanQueue} from '../src/protocol/queue.ts';
import {TabBindings, validChatKey} from './tab-bindings.ts';
import {BoundDriver} from './bound-driver.ts';

const root = process.env.BRIDGE_STATE ?? '/data';
const stop = {stopped: false};
process.on('SIGTERM', () => { stop.stopped = true; });
process.on('SIGINT', () => { stop.stopped = true; });
await mkdir(join(root, 'control'), {recursive: true, mode: 0o700});
const statusFile = join(root, 'router.json');
let state = 'starting';
let heartbeatWrites: Promise<void> = Promise.resolve();
function heartbeat() {
  heartbeatWrites = heartbeatWrites.then(async () => {
  const temporary = `${statusFile}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({v: 1, state, updatedAt: Date.now()}), {mode: 0o600, flag: 'wx'});
  await rename(temporary, statusFile);
  });
  return heartbeatWrites;
}
const pulse = setInterval(() => void heartbeat().catch(error => { console.error('Router heartbeat failed:', String(error)); stop.stopped = true; }), 5000);
let browser: Browser | null = null;
try {
  browser = await chromium.connectOverCDP(process.env.BRIDGE_CDP_URL ?? 'http://127.0.0.1:9222', {timeout: 5000});
  const clock = new SystemClock(), rand = new CryptoRandom(), log = createLogger();
  const base = bridgeConfigFromEnv(root);
  const pacer = new Pacer(base.pace, rand); // One pacing window shared by every Paseo chat.
  const profile = await loadPlatformProfile(base.selectorsPath);
  const bindings = new TabBindings(browser, join(root, 'bindings'), profile.start_url);
  state = 'ready'; await heartbeat();
  while (!stop.stopped) {
    const entries = await readdir(join(root, 'registry')).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const name of entries.sort()) {
      if (!name.endsWith('.json')) continue;
      const registration = JSON.parse(await readFile(join(root, 'registry', name), 'utf8'));
      if (registration.v !== 1 || !validChatKey(registration.key) || name !== `${registration.key}.json`) throw new Error('Invalid chat registration');
      const key: string = registration.key;
      const spool = join(root, 'chats', key, 'spool');
      const pending = await scanQueue(spool);
      if (!pending.pending.length) continue;
      // An inactive chat may have been navigated away by its operator. Restore
      // and validate its tab only when it has work; all binding guards still run.
      const page = await bindings.page(key);
      await page.bringToFront();
      const driver = new BoundDriver(page, profile, bindings, key);
      await driver.selftest();
      const cfg = bridgeConfigFromEnv(spool);
      const bridge = new Bridge({cfg, driver, pacer, clock, rand, log, metrics: new Metrics(spool, 'bridge-metrics.json', clock, log), probe: null, stop});
      const result = await bridge.runOnce();
      if (result.fatal) throw new Error(`Bridge paused: ${result.fatal}`);
      if (stop.stopped) break;
    }
    if (!stop.stopped) await clock.sleep(500);
  }
  state = 'stopped';
} catch (error) {
  state = 'paused'; console.error('Router paused:', String(error)); process.exitCode = 1;
} finally {
  clearInterval(pulse);
  await heartbeat();
  await browser?.close(); // Disconnect the router only; keep the persistent Chrome running.
}
