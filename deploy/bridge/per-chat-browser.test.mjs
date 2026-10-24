// Real Chrome acceptance against a container-loopback fixture only. No ChatGPT prompts.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const app = process.env.BRIDGE_APP ?? '/app';
const {chromium} = await import(pathToFileURL(join(app, 'node_modules/playwright-core/index.mjs')));
const providerSource = process.env.CODEXPRO_PROVIDER_SOURCE ?? resolve(import.meta.dirname, 'paseo-plugin/server/provider.ts');
const {createProvider} = await import(pathToFileURL(providerSource));
async function waitFor(predicate, milliseconds = 30_000) {
  const deadline = Date.now() + milliseconds;
  while (!await predicate()) { assert.ok(Date.now() < deadline, 'local acceptance timeout'); await delay(20); }
}
test('two native Paseo conversations retain isolated Chrome tabs across cancel, router restart and closed-tab recovery', {timeout: 90_000}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'paseo-chrome-acceptance-'));
  const records = [], conversations = new Map();
  const server = createServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/message') {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const data = JSON.parse(raw), id = data.id || randomUUID();
      const answers = conversations.get(id) ?? [];
      answers.push(`Reply for ${data.text}`); conversations.set(id, answers); records.push({id, text: data.text});
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({id, answers})); return;
    }
    const id = request.url?.match(/^\/c\/([a-zA-Z0-9_-]+)$/)?.[1];
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><title>Local Paseo chat fixture</title><style>#composer{min-height:32px;border:1px solid}#stop[hidden]{display:none}</style>
      <div id="turns"></div><div id="composer" contenteditable="true"></div><button id="send">Send</button><button id="stop" hidden>Stop</button>
      <script>
      let answers=${JSON.stringify(conversations.get(id) ?? [])};
      const turns=document.querySelector('#turns'),composer=document.querySelector('#composer'),stop=document.querySelector('#stop');
      function render(){turns.textContent='';for(const text of answers){const turn=document.createElement('div');turn.className='turn';const answer=document.createElement('p');answer.className='answer';answer.textContent=text;turn.append(answer);turns.append(turn);}}render();
      composer.addEventListener('keydown',async e=>{if(e.key!=='Enter'||e.shiftKey)return;e.preventDefault();stop.hidden=false;
        const data=await(await fetch('/message',{method:'POST',body:JSON.stringify({id:location.pathname.split('/c/')[1],text:composer.innerText})})).json();
        history.replaceState({},'', '/c/'+data.id);answers=data.answers;render();composer.textContent='';stop.hidden=true;});
      </script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/`;
  assert.equal(new URL(origin).hostname, '127.0.0.1');
  const profilePath = join(root, 'selectors.json');
  await writeFile(profilePath, JSON.stringify({platform: 'local-only', domain: origin, start_url: origin, network_probe: false,
    selectors: {composer: '#composer', turn: '.turn', answer: '.answer', stop_button: '#stop', send_button: '#send'}}));
  const cdp = process.env.BRIDGE_CDP_URL ?? 'http://127.0.0.1:9222';
  const browser = await chromium.connectOverCDP(cdp);
  let child, connection;
  let output = '';
  const events = [];
  const startRouter = async () => {
    child = spawn(process.execPath, ['deployment/router.ts'], {cwd: app,
      env: {...process.env, BRIDGE_STATE: root, BRIDGE_SELECTORS: profilePath, BRIDGE_CDP_URL: cdp,
        PACE_MIN_INTERVAL_MS: '0', PACE_MAX_TYPING_MS: '0', PACE_JITTER: '0', BRIDGE_POLL_MS: '50'}, stdio: ['ignore', 'pipe', 'pipe']});
    child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    await waitFor(async () => {
      assert.equal(child.exitCode, null, output);
      try { return JSON.parse(await readFile(join(root, 'router.json'), 'utf8')).state === 'ready'; } catch { return false; }
    });
  };
  const stopRouter = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGCONT'); child.kill('SIGTERM');
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 6000);
    assert.equal(child.exitCode, 0, output);
  };
  const config = {cwd: '/synthetic-only', env: {}, mcpServers: {}, settings: {}, persist: true};
  const connect = async () => { connection = await createProvider({root, pollMs: 20}).connect({versions: [1], capabilities: ['prompt.message', 'session.persistence']}); connection.onEvent(event => events.push(event)); };
  const open = async (id, persistence) => {
    await connection.send({type: 'session.open', requestId: `open-${id}`, sessionId: id, config, history: 'skip', ...(persistence ? {persistence} : {})});
    await waitFor(() => events.some(e => e.type === 'session.ready' && e.sessionId === id));
    return events.find(e => e.type === 'session.persistence' && e.sessionId === id).persistence;
  };
  const submit = async (sessionId, text) => {
    await connection.send({type: 'session.prompt', sessionId, prompt: {clientMessageId: text, delivery: 'auto', input: {type: 'message', content: [{type: 'text', text}]}}});
    await waitFor(() => events.some(e => e.type === 'session.prompt_result' && e.clientMessageId === text));
    const result = events.find(e => e.type === 'session.prompt_result' && e.clientMessageId === text).result;
    assert.equal(result.type, 'turn', JSON.stringify(result)); return result.turnId;
  };
  const terminal = async (turnId, state) => { await waitFor(() => events.some(e => e.type === 'session.turn' && e.turnId === turnId && e.state !== 'started')); const result = events.find(e => e.type === 'session.turn' && e.turnId === turnId && e.state !== 'started'); assert.equal(result.state, state, JSON.stringify(result) + '\n' + output); };
  const binding = async key => JSON.parse(await readFile(join(root, 'bindings', `${key}.json`), 'utf8'));
  try {
    await startRouter(); await connect();
    const [a, b] = await Promise.all([open('A'), open('B')]);
    const [ta, tb] = await Promise.all([submit('A', 'A-first'), submit('B', 'B-first')]);
    await Promise.all([terminal(ta, 'completed'), terminal(tb, 'completed')]);
    const ba = await binding(a.data.chatKey), bb = await binding(b.data.chatKey);
    assert.notEqual(ba.targetId, bb.targetId); assert.notEqual(ba.conversationUrl, bb.conversationUrl);
    child.kill('SIGSTOP');
    const canceled = await submit('A', 'A-canceled');
    await connection.send({type: 'session.interrupt', requestId: 'cancel', sessionId: 'A'});
    await waitFor(() => events.some(e => e.type === 'request.completed' && e.requestId === 'cancel'));
    child.kill('SIGCONT'); await terminal(canceled, 'canceled');
    assert.equal(records.some(record => record.text === 'A-canceled'), false);
    await stopRouter(); await connection.close();
    await startRouter(); await connect(); await open('A-restored', a); await open('B-restored', b);
    await terminal(await submit('A-restored', 'A-next'), 'completed');
    assert.equal((await binding(a.data.chatKey)).targetId, ba.targetId);
    const bPage = browser.contexts().flatMap(context => context.pages()).find(page => page.url() === bb.conversationUrl);
    assert.ok(bPage); await bPage.close();
    await terminal(await submit('B-restored', 'B-next'), 'completed');
    const recovered = await binding(b.data.chatKey);
    assert.equal(recovered.conversationUrl, bb.conversationUrl); assert.notEqual(recovered.targetId, bb.targetId);
    const aIds = records.filter(record => record.text.startsWith('A-')).map(record => record.id);
    const bIds = records.filter(record => record.text.startsWith('B-')).map(record => record.id);
    assert.equal(new Set(aIds).size, 1); assert.equal(new Set(bIds).size, 1); assert.notEqual(aIds[0], bIds[0]);
    assert.equal(records.length, 4);
    console.log(JSON.stringify({root, syntheticSends: records.length, canceledWithoutSend: true, stableIndependentConversations: true, routerRestart: true, closedTabRecovery: true}));
  } finally {
    child?.kill('SIGCONT');
    await stopRouter().catch(() => { child?.kill('SIGKILL'); });
    await connection?.close();
    for (const page of browser.contexts().flatMap(context => context.pages())) if (page.url().startsWith(origin)) await page.close();
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
