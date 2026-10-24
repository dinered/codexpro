import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const app = process.env.BRIDGE_APP;
if (!app) throw new Error('Set BRIDGE_APP to the isolated patched reference copy');
const {TabBindings} = await import(pathToFileURL(join(app, 'deployment/tab-bindings.ts')));
function browserFixture() {
  let sequence = 0;
  const pages = [];
  const context = {pages: () => pages.filter(page => !page.closed),
    newPage: async () => { const page = {id: `target-${++sequence}`, closed: false, current: 'about:blank',
      url() { return this.current; }, isClosed() { return this.closed; },
      context: () => context, async goto(url) { this.current = url; }, async close() { this.closed = true; }};
      pages.push(page); return page; },
    newCDPSession: async page => ({send: async () => ({targetInfo: {targetId: page.id}}), detach: async () => {}})};
  return {browser: {contexts: () => [context]}, context, pages};
}
test('two conversations retain distinct tabs through switches and reconnect without taking an operator tab', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tab-bindings-'));
  const f = browserFixture(), a = randomUUID(), b = randomUUID();
  const operator = await f.context.newPage(); await operator.goto('https://chatgpt.com/c/operator');
  const bindings = new TabBindings(f.browser, root, 'https://chatgpt.com/');
  const [pageA, pageB] = await Promise.all([bindings.page(a), bindings.page(b)]);
  assert.notEqual(pageA, pageB); assert.notEqual(pageA, operator); assert.notEqual(pageB, operator);
  await bindings.beforeSend(a, pageA); pageA.current = 'https://chatgpt.com/c/a'; await bindings.captureConversation(a, pageA);
  await bindings.beforeSend(b, pageB); pageB.current = 'https://chatgpt.com/c/b'; await bindings.captureConversation(b, pageB);
  const resumed = new TabBindings(f.browser, root, 'https://chatgpt.com/');
  for (const key of [a, b, a, b]) assert.equal(await resumed.page(key), key === a ? pageA : pageB);
  assert.equal(f.pages.length, 3);
  // Chrome restart can restore URLs under different CDP target IDs.
  pageA.id = 'restored-a'; pageB.id = 'restored-b';
  assert.equal(await resumed.page(a), pageA); assert.equal(await resumed.page(b), pageB);
  assert.equal(f.pages.length, 3);
});
test('closed tab restores the saved conversation; ambiguous or unresolved history refuses a fresh chat', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tab-recovery-'));
  const f = browserFixture(), a = randomUUID();
  const bindings = new TabBindings(f.browser, root, 'https://chatgpt.com/');
  const page = await bindings.page(a); await bindings.beforeSend(a, page);
  page.current = 'https://chatgpt.com/c/existing'; await bindings.captureConversation(a, page); await page.close();
  const restored = await bindings.page(a);
  assert.equal(restored.url(), 'https://chatgpt.com/c/existing'); assert.notEqual(restored, page);
  await restored.close();
  for (let i = 0; i < 2; i++) { const duplicate = await f.context.newPage(); await duplicate.goto('https://chatgpt.com/c/existing'); }
  await assert.rejects(bindings.page(a), /Multiple tabs/);
  const b = randomUUID(), pending = await bindings.page(b); await bindings.beforeSend(b, pending); await pending.close();
  const count = f.pages.length;
  await assert.rejects(bindings.page(b), /unresolved conversation URL/);
  assert.equal(f.pages.length, count);
});
test('manual navigation to another conversation fails before the next send', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tab-isolation-'));
  const f = browserFixture(), a = randomUUID(), bindings = new TabBindings(f.browser, root, 'https://chatgpt.com/');
  const page = await bindings.page(a); await bindings.beforeSend(a, page);
  page.current = 'https://chatgpt.com/c/owned'; await bindings.captureConversation(a, page);
  page.current = 'https://chatgpt.com/c/another-chat';
  await assert.rejects(bindings.beforeSend(a, page), /different conversation/);
  assert.equal((await bindings.read(a)).conversationUrl, 'https://chatgpt.com/c/owned');
});
