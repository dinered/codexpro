import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdir, mkdtemp, readdir, readFile, writeFile} from 'node:fs/promises';
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
async function fixture(options: Parameters<typeof createProvider>[0] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'paseo-v3-provider-'));
  await atomic(join(root, 'router.json'), {state: 'ready'});
  const registration = createProvider({root, pollMs: 5, pulseMs: 20, ...options});
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
// Golden wire fixtures from Paseo 0.12 prepareAgentMessage/formatAgentMessage.
function envelope(id: string, kind: string, text: string) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  const source = kind === 'user-message' ? '' : ' source-agent-id="synthetic-agent" source-agent-title="Synthetic sender"';
  const event = kind === 'agent-notification' ? ' event="finished"' : '';
  return `<paseo-system version="1" kind="${kind}"${source} message-id="${id}"${event}>\n${escaped}\n</paseo-system>`;
}
test('only conversational text enters V3 tasks; native echoes retain envelope provenance', async () => {
  const literal = envelope('literal-id', 'agent-message', 'Human typed this literally');
  const legacy = '<paseo-system>\nHuman typed this too\n</paseo-system>';
  const samples = [
    {id: 'plain', raw: '  Ordinary <human> & text\nsecond line  ', expected: '  Ordinary <human> & text\nsecond line  '},
    {id: 'agent', raw: envelope('agent', 'agent-message', 'Body <only> & literal &lt;'), expected: 'Body <only> & literal &lt;'},
    {id: 'literal', raw: envelope('literal', 'user-message', literal), expected: literal},
    {id: 'legacy-literal', raw: envelope('legacy-literal', 'user-message', legacy), expected: legacy},
    {id: 'similar', raw: 'Example: <paseo-system kind="agent-message">text</paseo-system>', expected: 'Example: <paseo-system kind="agent-message">text</paseo-system>'},
  ];
  for (const {id, raw, expected} of samples) {
    const f = await fixture();
    try {
      const a = await f.open('A'); await f.send(message('A', id, raw));
      await waitUntil(() => f.events.some(e => e.type === 'session.turn' && e.state === 'started'));
      const key = (a.persistence.data as {chatKey: string}).chatKey;
      const spool = join(f.root, 'chats', key, 'spool');
      const [dir] = await readdir(spool);
      const task = JSON.parse(await readFile(join(spool, dir!, 'task.json'), 'utf8'));
      assert.equal(task.text, expected); assert.equal(task.v, 3);
      const echo = f.events.find(e => e.type === 'timeline.item' && e.item.type === 'user_message');
      assert.ok(echo?.type === 'timeline.item' && echo.item.type === 'user_message');
      assert.equal(echo.item.text, raw);
      await atomic(join(spool, dir!, 'result.json'), {status: 'ok', traceId: task.traceId, markdown: 'Synthetic reply'});
      await waitUntil(() => f.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
    } finally { await f.connection.close(); }
  }
});
test('agent/system notifications and mismatched envelope identities create no task', async () => {
  for (const raw of [envelope('notice', 'agent-notification', 'Finished'), '<paseo-system>\nScheduled notification\n</paseo-system>', envelope('other-id', 'agent-message', 'Wrong identity')]) {
    const f = await fixture();
    try {
      const a = await f.open('A'); await f.send(message('A', 'notice', raw));
      await waitUntil(() => f.events.some(e => e.type === 'session.prompt_result'));
      assert.equal(f.events.filter(e => e.type === 'session.turn' || e.type === 'timeline.item').length, 0);
      const key = (a.persistence.data as {chatKey: string}).chatKey;
      assert.deepEqual(await readdir(join(f.root, 'chats', key, 'spool')), []);
    } finally { await f.connection.close(); }
  }
});
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
for (const mode of ['connection.close', 'session.close/reopen'] as const) {
  test(`${mode} during pending put cancels the late task and emits no late turn`, async () => {
    const {put} = await import('./protocol.ts');
    const root = await mkdtemp(join(tmpdir(), 'provider-put-race-'));
    await atomic(join(root, 'router.json'), {state: 'ready'});
    let entered = false, late: Awaited<ReturnType<typeof put>> | undefined;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const connection = await createProvider({root, pollMs: 5, writeTask: async (...args) => {
      entered = true; await gate; late = await put(...args); return late;
    }}).connect({versions: [1], capabilities: ['prompt.message', 'session.persistence']});
    const events: ProviderEvent[] = []; connection.onEvent(event => events.push(event));
    try {
      await connection.send({type: 'session.open', requestId: 'open', sessionId: 'A', config, history: 'skip'});
      await waitUntil(() => events.some(e => e.type === 'session.ready'));
      const saved = events.find(e => e.type === 'session.persistence') as Extract<ProviderEvent, {type: 'session.persistence'}>;
      await connection.send(message('A', 'old-pending'));
      await waitUntil(() => entered);
      if (mode === 'connection.close') await connection.close();
      else {
        await connection.send({type: 'session.close', requestId: 'close', sessionId: 'A'});
        await waitUntil(() => events.some(e => e.type === 'session.closed'));
        await connection.send({type: 'session.open', requestId: 'reopen', sessionId: 'A', config, persistence: saved.persistence, history: 'skip'});
        await waitUntil(() => events.filter(e => e.type === 'session.ready').length === 2);
      }
      const mark = events.length;
      release();
      await waitUntil(async () => Boolean(late && (await readdir(late.dir)).includes('cancel')));
      const abandoned = late!;
      assert.equal(events.slice(mark).filter(e => e.type === 'session.turn' || e.type === 'session.ready').length, 0);
      if (mode === 'session.close/reopen') {
        await connection.send(message('A', 'new-turn'));
        await waitUntil(() => events.some(e => e.type === 'session.turn' && e.state === 'started'));
        assert.notEqual(late!.dir, abandoned.dir);
        await atomic(join(late!.dir, 'result.json'), {status: 'ok', traceId: late!.traceId, markdown: 'new answer'});
        await waitUntil(() => events.some(e => e.type === 'session.turn' && e.state === 'completed'));
        assert.ok((await readdir(abandoned.dir)).includes('cancel'));
        assert.equal(events.filter(e => e.type === 'session.prompt_result' && e.clientMessageId === 'old-pending').length, 0);
      }
    } finally { release(); await connection.close(); }
  });
}
test('closing during registration cannot emit stale ready after reopening', async () => {
  const {register} = await import('./protocol.ts');
  const root = await mkdtemp(join(tmpdir(), 'provider-open-race-'));
  await atomic(join(root, 'router.json'), {state: 'ready'});
  let entered = false, first = true, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const connection = await createProvider({root, registerChat: async (...args) => {
    if (first) { first = false; entered = true; await gate; }
    await register(...args);
  }}).connect({versions: [1], capabilities: ['prompt.message', 'session.persistence']});
  const events: ProviderEvent[] = []; connection.onEvent(event => events.push(event));
  try {
    await connection.send({type: 'session.open', requestId: 'old-open', sessionId: 'A', config, history: 'skip'});
    await waitUntil(() => entered);
    await connection.send({type: 'session.close', requestId: 'close', sessionId: 'A'});
    await waitUntil(() => events.some(e => e.type === 'session.closed'));
    await connection.send({type: 'session.open', requestId: 'new-open', sessionId: 'A', config, history: 'skip'});
    await waitUntil(() => events.some(e => e.type === 'session.ready' && e.requestId === 'new-open'));
    release();
    await waitUntil(async () => (await readdir(join(root, 'registry'))).length === 2);
    assert.equal(events.filter(e => e.type === 'session.ready' && e.requestId === 'old-open').length, 0);
    assert.equal(events.filter(e => e.type === 'session.opened' && e.requestId === 'old-open').length, 0);
  } finally { release(); await connection.close(); }
});

test('interrupt completion follows the terminal result, even beyond the Paseo cancellation grace period', async () => {
  const f = await fixture();
  try {
    const saved = await f.open('A');
    await f.send(message('A', 'original'));
    await waitUntil(() => f.events.some(e => e.type === 'session.turn' && e.state === 'started'));
    const spool = join(f.root, 'chats', (saved.persistence.data as {chatKey: string}).chatKey, 'spool');
    const [id] = await readdir(spool), dir = join(spool, id!);
    const task = JSON.parse(await readFile(join(dir, 'task.json'), 'utf8'));
    const interruptIds = ['stop-1', 'stop-2'];
    for (const requestId of interruptIds) await f.send({type: 'session.interrupt', sessionId: 'A', requestId});
    await waitUntil(async () => (await readdir(dir)).includes('cancel'));
    // Paseo 0.12 force-cancels its own turn 2 s after an acknowledged interrupt.
    await delay(2100);
    assert.equal(f.events.filter(e => e.type === 'request.completed' && interruptIds.includes(e.requestId)).length, 0);
    await f.send(message('A', 'overlap'));
    await waitUntil(() => f.events.some(e => e.type === 'session.prompt_result' && e.clientMessageId === 'overlap'));
    assert.ok(f.events.some(e => e.type === 'session.prompt_result' && e.clientMessageId === 'overlap'
      && e.result.type === 'failed' && e.result.error.message === 'Previous turn is still active'));
    assert.equal((await readdir(spool)).length, 1);
    await atomic(join(dir, 'result.json'), {status: 'cancelled', code: 'CANCEL', traceId: task.traceId});
    await waitUntil(() => f.events.filter(e => e.type === 'request.completed' && interruptIds.includes(e.requestId)).length === 2);
    const terminalIndex = f.events.findIndex(e => e.type === 'session.turn' && e.state === 'canceled');
    assert.ok(terminalIndex >= 0);
    for (const requestId of interruptIds) assert.ok(f.events.findIndex(e => e.type === 'request.completed' && e.requestId === requestId) > terminalIndex);
    // Settling the old turn must not retry the rejected prompt.
    assert.equal((await readdir(spool)).length, 1);
    await f.send(message('A', 'explicit-next'));
    await waitUntil(() => f.events.some(e => e.type === 'session.prompt_result' && e.clientMessageId === 'explicit-next' && e.result.type === 'turn'));
    assert.equal((await readdir(spool)).length, 2);
  } finally { await f.connection.close(); }
});

for (const status of ['ok', 'error', 'cancelled'] as const) {
  test(`${status} terminal result releases the chat for the next explicit prompt`, async () => {
    const f = await fixture();
    try {
      const saved = await f.open('A');
      const spool = join(f.root, 'chats', (saved.persistence.data as {chatKey: string}).chatKey, 'spool');
      for (const id of ['first', 'next']) {
        await f.send(message('A', id));
        await waitUntil(() => f.events.some(e => e.type === 'session.prompt_result' && e.clientMessageId === id && e.result.type === 'turn'));
        const dirs = await readdir(spool);
        const dir = (await Promise.all(dirs.map(async d => ({dir: join(spool, d), task: JSON.parse(await readFile(join(spool, d, 'task.json'), 'utf8'))})))).find(d => d.task.text === id)!;
        await atomic(join(dir.dir, 'result.json'), {status, traceId: dir.task.traceId, ...(status === 'ok' ? {markdown: 'reply'} : {code: 'SYNTHETIC'})});
        await waitUntil(() => f.events.filter(e => e.type === 'session.turn' && e.state !== 'started').length === (id === 'first' ? 1 : 2));
      }
      assert.equal(f.events.filter(e => e.type === 'session.prompt_result' && e.result.type === 'failed').length, 0);
      assert.equal((await readdir(spool)).length, 2);
    } finally { await f.connection.close(); }
  });
}

for (const outcome of ['result', 'write failure', 'session close'] as const) {
  test(`interrupt during pending task publication settles on ${outcome}`, async () => {
    const {put} = await import('./protocol.ts');
    let entered = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture({writeTask: async (...args) => {
      entered = true; await gate;
      if (outcome === 'write failure') throw new Error('Synthetic publication failure');
      return put(...args);
    }});
    try {
      const saved = await f.open('A');
      await f.send(message('A', 'pending'));
      await waitUntil(() => entered);
      await f.send({type: 'session.interrupt', sessionId: 'A', requestId: 'stop'});
      // send() queues dispatch; a catalog reply fences the interrupt with no dir yet.
      await f.send({type: 'catalog', requestId: 'fence'});
      await waitUntil(() => f.events.some(e => e.type === 'catalog' && e.requestId === 'fence'));
      assert.equal(f.events.filter(e => e.type === 'request.completed' && e.requestId === 'stop').length, 0);
      if (outcome === 'session close') {
        await f.send({type: 'session.close', sessionId: 'A', requestId: 'close'});
        await waitUntil(() => f.events.some(e => e.type === 'session.closed'));
      }
      release();
      if (outcome === 'write failure') {
        await waitUntil(() => f.events.some(e => e.type === 'session.prompt_result' && e.result.type === 'failed'));
      } else {
        const spool = join(f.root, 'chats', (saved.persistence.data as {chatKey: string}).chatKey, 'spool');
        let dir = '';
        await waitUntil(async () => {
          const [id] = await readdir(spool);
          if (!id) return false;
          dir = join(spool, id);
          return (await readdir(dir)).includes('cancel');
        });
        if (outcome === 'result') {
          const task = JSON.parse(await readFile(join(dir, 'task.json'), 'utf8'));
          await atomic(join(dir, 'result.json'), {status: 'cancelled', code: 'CANCEL', traceId: task.traceId});
          await waitUntil(() => f.events.some(e => e.type === 'session.turn' && e.state === 'canceled'));
        } else {
          assert.equal(f.events.filter(e => e.type === 'session.turn').length, 0);
        }
      }
      const replies = f.events.filter(e => (e.type === 'request.completed' || e.type === 'request.failed') && e.requestId === 'stop');
      assert.equal(replies.length, 1);
      assert.equal(replies[0]!.type, outcome === 'result' ? 'request.completed' : 'request.failed');
    } finally { release(); await f.connection.close(); }
  });
}

for (const outcome of ['router stopped', 'session closed', 'cancel write failure'] as const) {
  test(`pending interrupt handles ${outcome} without accepting an overlapping task`, async () => {
    const f = await fixture();
    try {
      const saved = await f.open('A');
      await f.send(message('A', 'original'));
      await waitUntil(() => f.events.some(e => e.type === 'session.turn' && e.state === 'started'));
      const spool = join(f.root, 'chats', (saved.persistence.data as {chatKey: string}).chatKey, 'spool');
      const [id] = await readdir(spool), dir = join(spool, id!);
      if (outcome === 'cancel write failure') await mkdir(join(dir, 'cancel'));
      await f.send({type: 'session.interrupt', sessionId: 'A', requestId: 'stop'});
      if (outcome === 'cancel write failure') {
        await waitUntil(() => f.events.some(e => e.type === 'request.failed' && e.requestId === 'stop'));
        await f.send(message('A', 'overlap'));
        await waitUntil(() => f.events.some(e => e.type === 'session.prompt_result' && e.clientMessageId === 'overlap'));
        assert.ok(f.events.some(e => e.type === 'session.prompt_result' && e.clientMessageId === 'overlap'
          && e.result.type === 'failed' && e.result.error.message === 'Previous turn is still active'));
      } else {
        await waitUntil(async () => (await readdir(dir)).includes('cancel'));
        if (outcome === 'session closed') {
          await f.send({type: 'session.close', sessionId: 'A', requestId: 'close'});
          await waitUntil(() => f.events.some(e => e.type === 'session.closed'));
        } else {
          await atomic(join(f.root, 'router.json'), {state: 'paused'});
          await waitUntil(() => f.events.some(e => e.type === 'session.turn' && e.state === 'failed'));
          await f.send(message('A', 'next'));
          await waitUntil(() => f.events.some(e => e.type === 'session.prompt_result' && e.clientMessageId === 'next'));
          assert.ok(f.events.some(e => e.type === 'session.prompt_result' && e.clientMessageId === 'next'
            && e.result.type === 'failed' && e.result.error.message === 'Browser bridge is stopped; complete manual login and start it'));
        }
      }
      const replies = f.events.filter(e => (e.type === 'request.completed' || e.type === 'request.failed') && e.requestId === 'stop');
      assert.equal(replies.length, 1);
      assert.equal(replies[0]!.type, outcome === 'router stopped' ? 'request.completed' : 'request.failed');
      assert.equal((await readdir(spool)).length, 1);
    } finally { await f.connection.close(); }
  });
}

test('interrupting an idle session completes immediately', async () => {
  const f = await fixture();
  try {
    await f.open('A');
    await f.send({type: 'session.interrupt', sessionId: 'A', requestId: 'idle'});
    await waitUntil(() => f.events.some(e => e.type === 'request.completed' && e.requestId === 'idle'));
    assert.equal(f.events.filter(e => e.type === 'session.turn').length, 0);
  } finally { await f.connection.close(); }
});
