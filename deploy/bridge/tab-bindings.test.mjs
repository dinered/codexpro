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
test('different persisted keys cannot claim the same target or conversation during reconnect/recovery', async () => {
  const {readFile, writeFile} = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'tab-exclusive-'));
  const f = browserFixture(), a = randomUUID(), b = randomUUID();
  const bindings = new TabBindings(f.browser, root, 'https://chatgpt.com/');
  const pa = await bindings.page(a), pb = await bindings.page(b);
  await bindings.beforeSend(a, pa); pa.current = 'https://chatgpt.com/c/shared'; await bindings.captureConversation(a, pa);
  await bindings.beforeSend(b, pb); pb.current = 'https://chatgpt.com/c/shared';
  await assert.rejects(bindings.captureConversation(b, pb), /already owns/);
  assert.equal((await bindings.read(b)).conversationUrl, null);
  // Previously corrupted/duplicated persisted state must fail on both original-target and URL recovery paths.
  const bFile = join(root, `${b}.json`), originalB = JSON.parse(await readFile(bFile, 'utf8'));
  await writeFile(bFile, JSON.stringify({...originalB, conversationUrl: 'https://chatgpt.com/c/shared'}));
  await assert.rejects(new TabBindings(f.browser, root, 'https://chatgpt.com/').page(a), /already owns/);
  await pa.close(); await pb.close();
  await assert.rejects(new TabBindings(f.browser, root, 'https://chatgpt.com/').page(b), /already owns/);
  await writeFile(bFile, JSON.stringify({...originalB, targetId: (await bindings.read(a)).targetId}));
  await assert.rejects(new TabBindings(f.browser, root, 'https://chatgpt.com/').page(b), /already owns/);
});

test('first conversation URL arriving between capture and assertion is saved once without another send', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tab-first-url-race-'));
  const f = browserFixture(), key = randomUUID();
  const bindings = new TabBindings(f.browser, root, 'https://chatgpt.com/');
  const page = await bindings.page(key);
  await bindings.beforeSend(key, page);
  // ChatGPT updates its URL asynchronously after Enter. Capture still sees the
  // new-chat page; the following assertion sees the created conversation.
  let reads = 0;
  page.url = () => reads++ === 0 ? 'https://chatgpt.com/' : 'https://chatgpt.com/c/first-reply';
  await bindings.captureConversation(key, page);
  assert.equal((await bindings.read(key)).conversationUrl, null);
  await bindings.assertPage(key, page);
  assert.equal((await bindings.read(key)).conversationUrl, 'https://chatgpt.com/c/first-reply');
  page.url = () => 'https://chatgpt.com/c/foreign';
  await assert.rejects(bindings.beforeSend(key, page), /different conversation/);
  assert.equal((await bindings.read(key)).conversationUrl, 'https://chatgpt.com/c/first-reply');

  const unsent = randomUUID(), unbound = await bindings.page(unsent);
  unbound.current = 'https://chatgpt.com/c/foreign';
  await assert.rejects(bindings.assertPage(unsent, unbound), /before its first confirmed send/);
  assert.equal((await bindings.read(unsent)).hasSent, false);
  assert.equal((await bindings.read(unsent)).conversationUrl, null);
});

test('post-send transient path settles before the first conversation claim; persistent foreign paths still fail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tab-url-settling-'));
  const f = browserFixture(), key = randomUUID();
  const bindings = new TabBindings(f.browser, root, 'https://chatgpt.com/');
  const page = await bindings.page(key); await bindings.beforeSend(key, page);
  page.current = 'https://chatgpt.com/c/';
  const navigation = setTimeout(() => { page.current = 'https://chatgpt.com/c/settled'; }, 100);
  try { await bindings.assertPage(key, page); } finally { clearTimeout(navigation); }
  assert.equal((await bindings.read(key)).conversationUrl, 'https://chatgpt.com/c/settled');
  page.current = 'https://chatgpt.com/c/foreign';
  await assert.rejects(bindings.assertPage(key, page), /different conversation/);
  const another = randomUUID(), unbound = await bindings.page(another);
  await bindings.beforeSend(another, unbound);
  unbound.current = 'https://chatgpt.com/settings';
  await assert.rejects(bindings.assertPage(another, unbound), /before its first confirmed send/);
  assert.equal((await bindings.read(another)).conversationUrl, null);
  unbound.current = 'https://foreign.invalid/c/other';
  await assert.rejects(bindings.assertPage(another, unbound), /left the configured platform/);
});

test('target and origin changes while settling cannot claim a first conversation', async () => {
  for (const change of ['target', 'origin']) {
    const root = await mkdtemp(join(tmpdir(), `tab-settling-${change}-`));
    const f = browserFixture(), key = randomUUID();
    const bindings = new TabBindings(f.browser, root, 'https://chatgpt.com/');
    const page = await bindings.page(key);
    await bindings.beforeSend(key, page);
    const original = await bindings.read(key);
    page.current = 'https://chatgpt.com/c/';
    let snapshots = 0;
    page.url = () => {
      const url = page.current;
      if (++snapshots === 1) queueMicrotask(() => {
        if (change === 'target') page.id = 'different-target';
        page.current = change === 'target' ? 'https://chatgpt.com/c/unclaimed' : 'https://foreign.invalid/c/unclaimed';
      });
      return url;
    };
    await assert.rejects(bindings.assertPage(key, page), change === 'target' ? /identity changed/ : /left the configured platform/);
    assert.deepEqual(await bindings.read(key), original);
    assert.equal(snapshots, change === 'target' ? 1 : 2);
  }
});

test('auth/challenge paths and unsent transient paths reject without a settling delay', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tab-settling-immediate-'));
  const f = browserFixture(), key = randomUUID(), unsent = randomUUID();
  const bindings = new TabBindings(f.browser, root, 'https://chatgpt.com/');
  const page = await bindings.page(key), fresh = await bindings.page(unsent);
  await bindings.beforeSend(key, page);
  t.mock.method(globalThis, 'setTimeout', () => { assert.fail('Rejected navigation must not enter the settling delay'); });
  for (const path of ['/auth/login', '/login', '/challenge/verify']) {
    page.current = `https://chatgpt.com${path}`;
    await assert.rejects(bindings.assertPage(key, page), /before its first confirmed send/);
    assert.equal((await bindings.read(key)).conversationUrl, null);
  }
  fresh.current = 'https://chatgpt.com/c/';
  await assert.rejects(bindings.assertPage(unsent, fresh), /before its first confirmed send/);
  assert.equal((await bindings.read(unsent)).hasSent, false);
  assert.equal((await bindings.read(unsent)).conversationUrl, null);
});
