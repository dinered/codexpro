import assert from 'node:assert/strict';
import {test} from 'node:test';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const root = process.env.BRIDGE_APP;
if (!root) throw new Error('set BRIDGE_APP to an isolated patched application copy');
const {ChatGptDriver} = await import(pathToFileURL(resolve(root, 'src/driver/chatgpt.ts')));

test('page evaluator survives browser serialization and reads final answer', async () => {
  const answer = {outerHTML: '<p>local fixture answer</p>'};
  const turn = {querySelectorAll: () => [answer]};
  const button = {hidden: false, disabled: false, getAttribute: () => null,
    getClientRects: () => [{}]};
  const document = {querySelectorAll: (s) => s === '.turn' ? [turn] : s === '.send' ? [button] : [],
    defaultView: {getComputedStyle: () => ({display: 'block', visibility: 'visible'})}};
  const page = {evaluate: async (fn, input) => vm.runInNewContext(
    `(${fn.toString()})(input)`, {input, document})};
  const driver = new ChatGptDriver(page, {domain: 'http://fixture.local', selectors: {
    turn: '.turn', answer: '.answer', stop_button: '.stop', send_button: '.send'}});
  assert.deepEqual(JSON.parse(JSON.stringify(await driver.readAnswer())), {
    html: '<p>local fixture answer</p>', busy: false, sendIdle: true});
});

test('serialized evaluator recognizes visible generation and disabled send', async () => {
  const stop = {hidden: false, getAttribute: () => null, getClientRects: () => [{}]};
  const send = {...stop, disabled: true};
  const document = {querySelectorAll: (s) => s === '.stop' ? [stop] : s === '.send' ? [send] : [],
    defaultView: {getComputedStyle: () => ({display: 'block', visibility: 'visible'})}};
  const page = {evaluate: async (fn, input) => vm.runInNewContext(
    `(${fn.toString()})(input)`, {input, document})};
  const driver = new ChatGptDriver(page, {domain: 'http://fixture.local', selectors: {
    turn: '.turn', answer: '.answer', stop_button: '.stop', send_button: '.send'}});
  const result = await driver.readAnswer();
  assert.equal(result.busy, true);
  assert.equal(result.sendIdle, false);
});
