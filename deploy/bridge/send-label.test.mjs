import assert from 'node:assert/strict';
import {test} from 'node:test';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const app = process.env.BRIDGE_APP;
if (!app) throw new Error('Set BRIDGE_APP to the isolated patched application');
const require = createRequire(join(app, 'package.json'));
const {parseHTML} = require('linkedom');
const {ChatGptDriver} = await import(pathToFileURL(join(app, 'src/driver/chatgpt.ts')));
const {loadPlatformProfile} = await import(pathToFileURL(join(app, 'src/driver/selectors.ts')));
const {CompletionDetector} = await import(pathToFileURL(join(app, 'src/bridge/completion.ts')));
const profile = await loadPlatformProfile(join(app, 'selectors/chatgpt.yaml'));
async function snapshot(control = '<button aria-label="Send"></button>', extra = '', answer = 'Local answer') {
  const {document} = parseHTML(`<div data-turn-key="fixture"><p data-markdown-text-style="assistant-message">${answer}</p></div>${control}${extra}`);
  for (const e of document.querySelectorAll('*')) {
    e.getClientRects = () => e.hasAttribute('hidden') ? [] : [{}];
    if (e.localName === 'button') e.disabled = e.hasAttribute('disabled');
  }
  document.defaultView.getComputedStyle = () => ({display: 'block', visibility: 'visible'});
  const page = {evaluate: async (fn, input) => vm.runInNewContext(`(${fn.toString()})(input)`, {input, document})};
  return new ChatGptDriver(page, profile).readAnswer();
}
function completion(sample) {
  const detector = new CompletionDetector({next: () => 0, int: () => 0}, 3000);
  let result;
  for (const now of [0, 1500, 3000, 4500]) result = detector.push({busy: sample.busy, sendIdle: sample.sendIdle, text: sample.html}, now);
  return result;
}
test('visible enabled Send label completes a stable nonstreaming answer', async () => {
  const result = await snapshot();
  assert.equal(result.busy, false);
  assert.equal(result.sendIdle, true);
  assert.equal(completion(result), 'complete');
});
test('missing, hidden or disabled send controls never establish completion', async () => {
  for (const button of ['', '<button aria-label="Send" hidden></button>', '<button aria-label="Send" disabled></button>']) {
    const result = await snapshot(button);
    assert.equal(result.sendIdle, false);
    assert.equal(completion(result), 'continue');
  }
});
test('visible stop or streaming indicator still blocks a stable answer', async () => {
  for (const extra of ['<button data-testid="stop-button"></button>', '<span data-markdown-animated></span>']) {
    const result = await snapshot('<button aria-label="Send"></button>', extra);
    assert.equal(result.busy, true);
    assert.equal(completion(result), 'continue');
  }
});

test('enabled visible Start Voice establishes idle only with an empty composer', async () => {
  const result = await snapshot('<button aria-label="Start Voice"></button>', '<section data-composer-input><div contenteditable="true"></div></section>');
  assert.equal(result.sendIdle, true);
  assert.equal(completion(result), 'complete');
});

test('voice idle rejects a missing or nonempty composer and hidden or disabled controls', async () => {
  for (const [button, composer] of [
    ['<button aria-label="Start Voice"></button>', ''],
    ['<button aria-label="Start Voice"></button>', '<section data-composer-input><div contenteditable="true">draft</div></section>'],
    ['<button aria-label="Start Voice" hidden></button>', '<section data-composer-input><div contenteditable="true"></div></section>'],
    ['<button aria-label="Start Voice" disabled></button>', '<section data-composer-input><div contenteditable="true"></div></section>'],
    ['<button aria-label="Different Voice"></button>', '<section data-composer-input><div contenteditable="true"></div></section>'],
  ]) {
    const result = await snapshot(button, composer);
    assert.equal(result.sendIdle, false);
    assert.equal(completion(result), 'continue');
  }
});

test('voice idle retains visible stop and streaming guards', async () => {
  for (const extra of ['<button data-testid="stop-button"></button>', '<span data-markdown-animated></span>']) {
    const result = await snapshot('<button aria-label="Start Voice"></button>', '<section data-composer-input><div contenteditable="true"></div></section>'+extra);
    assert.equal(result.busy, true);
    assert.equal(completion(result), 'continue');
  }
});

test('voice idle requires a nonempty stable answer before completion', async () => {
  const empty = await snapshot('<button aria-label="Start Voice"></button>', '<section data-composer-input><div contenteditable="true"></div></section>', '');
  assert.equal(empty.sendIdle, false);
  assert.equal(completion(empty), 'continue');
  const result = await snapshot('<button aria-label="Start Voice"></button>', '<section data-composer-input><div contenteditable="true"></div></section>');
  const detector = new CompletionDetector({next: () => 0, int: () => 0}, 3000);
  for (const [now, text] of [[0,'first'],[1500,'second'],[3000,'third'],[4500,'fourth']]) {
    assert.equal(detector.push({busy:false,sendIdle:result.sendIdle,text},now), 'continue');
  }
});
