import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const app = process.env.BRIDGE_APP;
if (!app) throw new Error('Set BRIDGE_APP to the isolated patched reference copy');
const {BoundDriver} = await import(pathToFileURL(join(app, 'deployment/bound-driver.ts')));
const {TabBindings} = await import(pathToFileURL(join(app, 'deployment/tab-bindings.ts')));

const profile = {domain: 'https://chatgpt.com/', selectors: {composer: 'composer', turn: 'turn', answer: 'answer', stop_button: 'stop'}};

// Заглушка страницы: appendText драйвера требует locator(composer).focus() и keyboard.
function pageFixture(url) {
  const writes = [], keys = [];
  const page = {
    closed: false, current: url,
    url() { return this.current; }, isClosed() { return this.closed; },
    async close() { this.closed = true; },
    async goto(u) { this.current = u; },
    context() { return {newCDPSession: async () => ({send: async () => ({targetInfo: {targetId: 'target-fixed'}}), detach: async () => {}})}; },
    locator(selector) { return {focus: async () => keys.push(`focus:${selector}`)}; },
    keyboard: {press: async key => keys.push(key), insertText: async text => writes.push(text)},
  };
  return {page, writes, keys};
}

function browserFixture(page) {
  const context = {pages: () => [page], newPage: async () => page};
  return {browser: {contexts: () => [context]}, context};
}

async function boundWithBinding(root, page) {
  const f = browserFixture(page);
  const bindings = new TabBindings(f.browser, root, 'https://chatgpt.com/');
  const key = randomUUID();
  await bindings.page(key); // привязка сохранена: target-fixed
  return new BoundDriver(page, profile, bindings, key);
}

test('appendText проверяет привязку вкладки до записи КАЖДОЙ порции (R3)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bound-append-'));
  const {page, writes} = pageFixture('https://chatgpt.com/');
  const bound = await boundWithBinding(root, page);
  const checks = [];
  const original = bound.bindings.assertPage.bind(bound.bindings);
  bound.bindings.assertPage = async (...args) => { checks.push(1); return original(...args); };
  await bound.appendText('First piece. ');
  assert.equal(checks.length, 1, 'проверка привязки выполнена до записи порции');
  assert.deepEqual(writes, ['First piece. ']);
  await bound.appendText('Second piece.');
  assert.equal(checks.length, 2, 'проверка привязки перед КАЖДОЙ порцией, не только перед первой');
  assert.deepEqual(writes, ['First piece. ', 'Second piece.']);
});

test('переключение conversation между порциями: appendText заблокирован до вставки (R3)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bound-append-'));
  const {page, writes} = pageFixture('https://chatgpt.com/');
  const bound = await boundWithBinding(root, page);
  // навигация во время паузы между порциями: assertPage отвергает чужой conversation
  bound.bindings.assertPage = async () => { throw new Error('Chat tab navigated to a different conversation'); };
  await assert.rejects(bound.appendText('Third piece.'), /different conversation/);
  assert.deepEqual(writes, [], 'insertText не выполнялся: отказ привязки = ноль записей в поле');
});
