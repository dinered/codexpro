// Run inside the reviewed browser container against a local fixture only.
// BRIDGE_APP may select an isolated patched copy for before/after comparison.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const app = resolve(process.env.BRIDGE_APP ?? '/app');
const load = p => import(pathToFileURL(join(app, p)));
const {chromium} = await load('node_modules/playwright-core/index.mjs');
const {ChatGptDriver} = await load('src/driver/chatgpt.ts');
const {PluginClient} = await load('plugin-client/client.ts');
const cdp = process.env.BRIDGE_CDP_URL ?? 'http://127.0.0.1:9222';

for (const mode of ['operator-stop', 'startup-error', 'challenge']) {
  test(`bridge exits after ${mode} while dedicated Chrome and its tab survive`, {timeout: 20_000}, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-lifecycle-'));
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><title>Codexpro local lifecycle fixture</title>
        <h1>Local fixture: ${mode}</h1><div id="composer" contenteditable="true"></div>
        <div class="turn"><p class="answer">local fixture answer</p></div>
        <button id="send">Send</button><div id="challenge" ${mode === 'challenge' ? '' : 'hidden'}>Synthetic challenge</div>
        <script>window.fixtureSends=0;document.addEventListener('keydown',e=>{if(e.key==='Enter')window.fixtureSends++});</script>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const domain = `http://127.0.0.1:${server.address().port}/`;
    const profile = {platform: 'local-fixture', domain, start_url: domain, network_probe: false,
      selectors: {composer: mode === 'startup-error' ? '[' : '#composer', turn: '.turn', answer: '.answer',
        stop_button: '#absent-stop', send_button: '#send', challenge: '#challenge'}};
    const profilePath = join(dir, 'selectors.json');
    await writeFile(profilePath, JSON.stringify(profile));
    const browser = await chromium.connectOverCDP(cdp);
    const page = await browser.contexts()[0].newPage();
    let child;
    let client;
    let output = '';
    try {
      await page.goto(domain);
      const snapshot = await new ChatGptDriver(page, {...profile, selectors: {...profile.selectors, composer: '#composer'}}).readAnswer();
      assert.equal(snapshot.html, '<p class="answer">local fixture answer</p>');
      assert.equal(snapshot.busy, false);
      assert.equal(snapshot.sendIdle, true);
      child = spawn(process.execPath, ['src/main.ts', join(dir, 'spool')], {cwd: app,
        env: {...process.env, BRIDGE_SELECTORS: profilePath, BRIDGE_CDP_URL: cdp, BRIDGE_METRICS: 'off'},
        stdio: ['ignore', 'pipe', 'pipe']});
      const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
      child.stdout.on('data', data => output += data);
      child.stderr.on('data', data => output += data);
      const waitFor = async pattern => {
        const deadline = Date.now() + 7000;
        while (!pattern.test(output)) {
          assert.equal(child.exitCode, null, `early bridge exit: ${output}`);
          assert.ok(Date.now() < deadline, `missing ${pattern}: ${output}`);
          await delay(25);
        }
      };
      if (mode === 'startup-error') {
        await waitFor(/мост не работает/);
      } else {
        await waitFor(/мост запущен/);
        if (mode === 'operator-stop') child.kill('SIGTERM');
        else {
          client = new PluginClient(join(dir, 'spool'));
          await client.put('local synthetic task; challenge prevents submission');
        }
        await waitFor(/мост остановлен/);
      }
      const deadline = Date.now() + 4000;
      while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(25);
      assert.notEqual(child.exitCode, null, `bridge retained CDP connection after completion: ${output}`);
      const exit = await exited;
      assert.equal(exit.signal, null);
      assert.equal(exit.code, mode === 'operator-stop' ? 0 : 1);
      assert.equal(await page.title(), 'Codexpro local lifecycle fixture');
      assert.equal(await page.evaluate(() => window.fixtureSends), 0);
      assert.equal((await fetch(`${cdp}/json/version`)).status, 200);
      console.log(JSON.stringify({mode, exit, sends: 0, chromePreserved: true, fixtureDir: dir}));
    } finally {
      client?.close();
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise(resolve => child.once('exit', resolve));
      }
      await page.close();
      await browser.close(); // CDP disconnection; the separately launched Chrome stays alive.
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
