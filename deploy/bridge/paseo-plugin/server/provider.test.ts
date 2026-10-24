import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, readdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import type {ProviderEvent, ProviderInput, ProviderPersistence} from '@getpaseo/plugin/server/provider';
import {createProvider} from './provider.ts';
import {atomic} from './protocol.ts';
const config = {cwd: '/synthetic/project', env: {}, mcpServers: {}, settings: {}, persist: true};
async function waitUntil(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!await check()) { assert.ok(Date.now() < deadline, 'timed out'); await delay(5); }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'paseo-v3-provider-'));
  await atomic(join(root, 'router.json'), {state: 'ready'});
  const registration = createProvider({root, pollMs: 5, pulseMs: 20});
  const connection = await registration.connect({versions: [1], capabilities: ['prompt.message', 'session.persistence']});
  const events: ProviderEvent[] = []; connection.onEvent(event => events.push(event));
  const send = async (input: ProviderInput) => { await connection.send(input); };
  const open = async (sessionId: string, persistence?: ProviderPersistence) => {
    await send({type: 'session.open', requestId: `open-${sessionId}`, sessionId, config, history: 'skip', ...(persistence ? {persistence} : {})});
    await waitUntil(() => events.some(event => event.type === 'session.ready' && event.sessionId === sessionId));
    return events.find(event => event.type === 'session.persistence' && event.sessionId === sessionId) as Extract<ProviderEvent, {type: 'session.persistence'}>;
  };
  return {root, registration, connection, events, send, open};
}
function message(sessionId: string, id: string, text = id): ProviderInput {
  return {type: 'session.prompt', sessionId, prompt: {clientMessageId: id, delivery: 'auto', input: {type: 'message', content: [{type: 'text', text}]}}};
}
test('two simultaneous Paseo chats keep independent V3 tasks, results and persistent bindings', async () => {
  const f = await fixture();
  try {
    const [a, b] = await Promise.all([f.open('A'), f.open('B')]);
    assert.notDeepEqual(a.persistence, b.persistence);
    await Promise.all([f.send(message('A', 'prompt-A')), f.send(message('B', 'prompt-B'))]);
    await waitUntil(() => f.events.filter(e => e.type === 'session.turn' && e.state === 'started').length === 2);
    for (const [sessionId, saved] of [['A', a], ['B', b]] as const) {
      const key = (saved.persistence.data as {chatKey: string}).chatKey;
      const spool = join(f.root, 'chats', key, 'spool');
      const dirs = await readdir(spool); assert.equal(dirs.length, 1);
      const dir = join(spool, dirs[0]!);
      const task = JSON.parse(await readFile(join(dir, 'task.json'), 'utf8'));
      assert.equal(task.v, 3); assert.equal(task.text, `prompt-${sessionId}`);
      await atomic(join(dir, 'result.json'), {status: 'ok', traceId: task.traceId, markdown: `answer-${sessionId}`});
      await waitUntil(() => f.events.some(e => e.type === 'session.turn' && e.sessionId === sessionId && e.state === 'completed'));
      assert.equal(JSON.parse(await readFile(join(dir, 'result.ack'), 'utf8')).markdown, `answer-${sessionId}`);
    }
    const answers = f.events.filter((e): e is Extract<ProviderEvent, {type: 'timeline.item'}> => e.type === 'timeline.item' && e.item.type === 'assistant_message');
    assert.deepEqual(answers.map(e => [e.sessionId, e.item.type === 'assistant_message' ? e.item.text : '']), [['A', 'answer-A'], ['B', 'answer-B']]);
    await f.connection.close();
    const resumed = await f.registration.connect({versions: [1], capabilities: ['prompt.message', 'session.persistence']});
    const replay: ProviderEvent[] = []; resumed.onEvent(event => replay.push(event));
    try {
      await resumed.send({type: 'session.open', requestId: 'resume', sessionId: 'A2', config, persistence: a.persistence, history: 'skip'});
      await waitUntil(() => replay.some(e => e.type === 'session.ready'));
      assert.deepEqual((replay.find(e => e.type === 'session.persistence') as typeof a).persistence, a.persistence);
      assert.equal((await readdir(join(f.root, 'registry'))).length, 2);
    } finally { await resumed.close(); }
  } finally { await f.connection.close(); }
});
test('concurrent prompts in one chat admit one task and interrupt preserves the V3 cancel marker', async () => {
  const f = await fixture();
  try {
    const a = await f.open('A');
    await Promise.all([f.send(message('A', 'one')), f.send(message('A', 'two'))]);
    await waitUntil(() => f.events.filter(e => e.type === 'session.prompt_result').length === 2);
    const results = f.events.filter((e): e is Extract<ProviderEvent, {type: 'session.prompt_result'}> => e.type === 'session.prompt_result');
    assert.equal(results.filter(e => e.result.type === 'turn').length, 1);
    assert.equal(results.filter(e => e.result.type === 'failed').length, 1);
    const key = (a.persistence.data as {chatKey: string}).chatKey;
    const spool = join(f.root, 'chats', key, 'spool'), dirs = await readdir(spool);
    assert.equal(dirs.length, 1);
    const dir = join(spool, dirs[0]!);
    await f.send({type: 'session.interrupt', requestId: 'stop', sessionId: 'A'});
    await waitUntil(async () => (await readdir(dir)).includes('cancel'));
    const task = JSON.parse(await readFile(join(dir, 'task.json'), 'utf8'));
    await atomic(join(dir, 'result.json'), {status: 'cancelled', code: 'SIGNAL', traceId: task.traceId});
    await waitUntil(() => f.events.some(e => e.type === 'session.turn' && e.state === 'canceled'));
    assert.ok((await readdir(dir)).includes('journal.jsonl') === false); // Provider never invents a send journal.
  } finally { await f.connection.close(); }
});
test('stopped router and foreign-trace results fail without presenting another chat response', async () => {
  const f = await fixture();
  try {
    const a = await f.open('A');
    await writeFile(join(f.root, 'router.json'), JSON.stringify({state: 'paused'}));
    await f.send(message('A', 'blocked'));
    await waitUntil(() => f.events.some(e => e.type === 'session.prompt_result'));
    assert.equal(f.events.filter(e => e.type === 'session.turn').length, 0);
    await atomic(join(f.root, 'router.json'), {state: 'ready'});
    await f.send(message('A', 'active'));
    await waitUntil(() => f.events.some(e => e.type === 'session.turn' && e.state === 'started'));
    const key = (a.persistence.data as {chatKey: string}).chatKey;
    const spool = join(f.root, 'chats', key, 'spool'), dirs = await readdir(spool);
    const dir = join(spool, dirs[0]!);
    await atomic(join(dir, 'result.json'), {status: 'ok', traceId: 'belongs-to-another-chat', markdown: 'wrong answer'});
    await waitUntil(() => f.events.some(e => e.type === 'session.turn' && e.state === 'failed'));
    assert.equal(f.events.filter(e => e.type === 'timeline.item' && e.item.type === 'assistant_message').length, 0);
    assert.ok((await readdir(dir)).includes('result.json')); // Preserve bad output for operator review.
  } finally { await f.connection.close(); }
});
