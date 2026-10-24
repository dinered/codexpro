import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, readdir, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const app = process.env.BRIDGE_APP;
if (!app) throw new Error('Set BRIDGE_APP to an isolated patched application copy');
const load = path => import(pathToFileURL(join(app, path)));
const {createProvider} = await import(pathToFileURL(resolve(import.meta.dirname, 'paseo-plugin/server/provider.ts')));
const {atomic} = await import(pathToFileURL(resolve(import.meta.dirname, 'paseo-plugin/server/protocol.ts')));
const {Bridge} = await load('src/bridge/loop.ts');
const {ManualClock} = await load('src/core/clock.ts');
const {SeededRandom} = await load('src/core/random.ts');
const {HumanDriver} = await load('src/driver/human.ts');
const {Pacer} = await load('src/pace/pace.ts');
const {Metrics} = await load('src/metrics/metrics.ts');
const {createLogger} = await load('src/core/log.ts');
const {testConfig} = await load('tests/helpers/harness.ts');
async function waitUntil(predicate, advance = async () => {}) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'synthetic protocol timed out'); await advance(); await delay(5); }
}
test('native provider V3 tasks run through reference engine with one shared cross-chat rate limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'provider-engine-'));
  await atomic(join(root, 'router.json'), {state: 'ready'});
  const connection = await createProvider({root, pollMs: 5, pulseMs: 20}).connect({versions: [1], capabilities: ['prompt.message', 'session.persistence']});
  const events = []; connection.onEvent(event => events.push(event));
  const clock = new ManualClock(Date.now()), rand = new SeededRandom(42), log = createLogger(() => {});
  const stop = {stopped: false}, drivers = [], runs = [];
  try {
    for (const id of ['A', 'B']) await connection.send({type: 'session.open', requestId: id, sessionId: id,
      config: {cwd: '/local-fixture', env: {}, mcpServers: {}, settings: {}, persist: true}, history: 'skip'});
    await waitUntil(() => events.filter(event => event.type === 'session.ready').length === 2);
    const configurations = ['A', 'B'].map(id => {
      const saved = events.find(event => event.type === 'session.persistence' && event.sessionId === id);
      const spool = join(root, 'chats', saved.persistence.data.chatKey, 'spool');
      return testConfig(spool, {aliveTtlMs: 3_600_000, pace: {minIntervalMs: 100, maxTypingMs: 0, jitter: 0, hourlyMax: 1, hourlyWarn: 1}});
    });
    const pacer = new Pacer(configurations[0].pace, rand);
    const bridges = configurations.map((cfg, index) => {
      const driver = new HumanDriver({answerMarkdown: `answer-${index}`, generationMs: 100}, clock); drivers.push(driver);
      return new Bridge({cfg, driver, pacer, clock, rand, log, metrics: new Metrics(null, 'metrics.json', clock, log), probe: null, stop});
    });
    for (const id of ['A', 'B']) await connection.send({type: 'session.prompt', sessionId: id,
      prompt: {clientMessageId: id, delivery: 'auto', input: {type: 'message', content: [{type: 'text', text: `synthetic-${id}`}]}}});
    await waitUntil(() => events.filter(event => event.type === 'session.turn' && event.state === 'started').length === 2);
    const tick = () => clock.advanceAsync(100);
    let finished = false;
    runs.push(bridges[0].runOnce().finally(() => { finished = true; }));
    await waitUntil(() => finished, tick);
    assert.equal(drivers[0].sendCount, 1);
    assert.equal(drivers[0].lastSentText, 'synthetic-A');
    assert.ok(events.some(event => event.type === 'session.turn' && event.sessionId === 'A' && event.state === 'completed'));
    runs.push(bridges[1].runOnce());
    await waitUntil(() => events.some(event => event.type === 'session.turn' && event.sessionId === 'B' && event.state === 'failed'), tick);
    assert.equal(drivers[1].sendCount, 0, 'second chat must share the first chat rate limit');
    const [turn] = await readdir(configurations[1].root);
    const result = JSON.parse(await readFile(join(configurations[1].root, turn, 'result.ack'), 'utf8'));
    assert.equal(result.code, 'RATE_LIMIT');
    assert.equal(events.filter(event => event.type === 'timeline.item' && event.item.type === 'assistant_message').length, 1);
  } finally {
    stop.stopped = true;
    let settled = false; const done = Promise.allSettled(runs).then(() => { settled = true; });
    await waitUntil(() => settled, () => clock.advanceAsync(1000));
    await done; await connection.close();
  }
});
