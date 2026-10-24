// Local-only fixture for noVNC/CDP identity, manual input and profile persistence.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {chromium} from '/app/node_modules/playwright-core/index.mjs';

const origin = 'http://127.0.0.1:8049/';
const marker = 'codexpro-pilot-profile-20261024';
if (process.argv[2] === 'serve') {
  createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><title>Codexpro shared browser fixture</title>
      <style>body{font:24px sans-serif;padding:48px;background:#edf4fc;color:#18354c}input{font:24px sans-serif;padding:12px;width:600px}</style>
      <h1>Codexpro shared browser</h1><p>Local fixture. No ChatGPT requests.</p>
      <p>Human input in this box is visible to CDP:</p><input id="manual" aria-label="Manual fixture input">
      <p id="persistence"></p><script>document.querySelector('#persistence').textContent=localStorage.getItem('bridge-fixture')||'No test marker';</script>`);
  }).listen(8049, '127.0.0.1');
} else {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  try {
    const context = browser.contexts()[0];
    const page = context.pages().find(p => p.url().startsWith(origin)) ?? await context.newPage();
    await page.goto(origin);
    if (process.argv[2] === 'set') await page.evaluate(value => localStorage.setItem('bridge-fixture', value), marker);
    assert.equal(await page.evaluate(() => localStorage.getItem('bridge-fixture')), marker);
    await page.reload();
    await page.bringToFront();
    console.log(JSON.stringify({origin, marker, title: await page.title(), profilePersisted: true}));
  } finally {
    await browser.close();
  }
}
