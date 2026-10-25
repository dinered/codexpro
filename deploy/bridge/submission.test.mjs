// Real serialized page evaluator + DOM fixture + protocol engine; no browser or network.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const app = process.env.BRIDGE_APP;
if (!app) throw new Error('Set BRIDGE_APP to the isolated patched reference copy');
const load = path => import(pathToFileURL(join(app, path)));
const {parseHTML} = createRequire(join(app, 'package.json'))('linkedom');
const {BoundDriver} = await load('deployment/bound-driver.ts');
const {loadPlatformProfile} = await load('src/driver/selectors.ts');
const {CompletionDetector} = await load('src/bridge/completion.ts');
const {makeRig, cleanupRig, startBridge, driveUntil} = await load('tests/helpers/harness.ts');
const profile = await loadPlatformProfile(join(app, 'selectors/chatgpt.yaml'));

function fixture(now = () => 0, lineBreak = 'text') {
  const {document} = parseHTML('<main></main><section data-composer-input><div contenteditable="true"></div></section><button aria-label="Send"></button>');
  const composer = document.querySelector('[contenteditable]');
  let inputLine;
  const resetComposer = () => {
    composer.replaceChildren(); inputLine = composer;
    if (lineBreak === 'blocks') { inputLine = document.createElement('div'); composer.append(inputLine); }
  };
  resetComposer();
  let mode = 'accept', sends = 0, stops = 0, invalidBinding = false, turn = 0;
  const visible = () => {
    for (const element of document.querySelectorAll('*')) {
      element.getClientRects = () => element.hasAttribute('hidden') ? [] : [{}];
      if (element.localName === 'button') element.disabled = element.hasAttribute('disabled');
    }
  };
  document.defaultView.getComputedStyle = () => ({display: 'block', visibility: 'visible'});
  const add = (text, answer = 'Same reply', key = `turn-${++turn}`) => {
    const row = document.createElement('article'); row.setAttribute('data-turn-key', key);
    const user = document.createElement('div'); user.setAttribute('data-user-message-bubble', ''); user.textContent = text; row.append(user);
    if (answer !== null) {
      const reply = document.createElement('p'); reply.setAttribute('data-markdown-text-style', 'assistant-message'); reply.textContent = answer; row.append(reply);
    }
    document.querySelector('main').append(row); visible(); return row;
  };
  const page = {
    url: () => profile.domain,
    evaluate: async (fn, input) => vm.runInNewContext(`(${fn.toString()})(input)`, {input, document}),
    locator(selector) {
      return {focus: async () => {}, innerText: async () => document.querySelector(selector)?.innerText ?? '',
        waitFor: async () => { assert.ok(document.querySelector(selector)); }, first() { return this; }, filter() { return this; },
        isVisible: async () => !!document.querySelector(selector), click: async () => { stops++; }};
    },
    keyboard: {
      insertText: async text => { inputLine.append(document.createTextNode(text)); },
      press: async key => {
        if (key === 'Backspace') resetComposer();
        if (key === 'Shift+Enter') {
          if (lineBreak === 'br') composer.append(document.createElement('br'));
          else if (lineBreak === 'blocks') { inputLine = document.createElement('div'); composer.append(inputLine); }
          else composer.append(document.createTextNode('\n'));
        }
        if (key !== 'Enter') return;
        sends++;
        if (mode === 'accept') { add(composer.innerText); resetComposer(); }
        if (mode === 'other-user') { add('Another submission'); resetComposer(); }
      },
    },
  };
  const bindings = {captureConversation: async () => {}, assertPage: async () => {
    if (invalidBinding) throw new Error('Chat tab navigated to a different conversation');
  }, beforeSend: async () => bindings.assertPage()};
  visible();
  const driver = new BoundDriver(page, profile, bindings, 'synthetic-key', now);
  return {driver, add, document, composer, mode: value => { mode = value; }, invalidate: () => { invalidBinding = true; },
    sends: () => sends, stops: () => stops};
}

async function complete(driver) {
  const detector = new CompletionDetector({next: () => 0, int: () => 0}, 3000);
  let sample, outcome;
  for (const now of [0, 1500, 3000, 4500]) {
    sample = await driver.readAnswer();
    outcome = detector.push({...sample, text: sample.html}, now);
  }
  return {sample, outcome};
}

test('two distinct submissions with identical reply text are attributed by turn identity', async () => {
  const f = fixture();
  for (const text of ['First prompt', 'Second prompt']) {
    await f.driver.typeText(text); await f.driver.pressSend();
    const {sample, outcome} = await complete(f.driver);
    assert.equal(outcome, 'complete'); assert.match(sample.html, /Same reply/);
  }
  assert.equal(f.sends(), 2);
});

test('chunked input keeps the intended message; an intervening composer edit blocks Enter', async () => {
  const f = fixture();
  await f.driver.appendText('First part. '); await f.driver.appendText('Second part.');
  await f.driver.pressSend(); assert.equal((await complete(f.driver)).outcome, 'complete');
  await f.driver.typeText('Expected'); f.composer.textContent = 'Changed by another writer';
  await assert.rejects(f.driver.pressSend(), /Composer changed after typing/);
  assert.equal(f.sends(), 1);
});

for (const lineBreak of ['br', 'blocks']) {
  test(`multiline ${lineBreak} composer sends once and accepts its new answer`, async () => {
    const f = fixture(() => 0, lineBreak);
    const text = 'First line\nSecond line';
    await f.driver.typeText(text); // appendText issues Shift+Enter, rendered as real DOM breaks.
    assert.equal(f.composer.textContent, 'First lineSecond line', 'textContent loses the separator');
    assert.equal(f.composer.innerText, text, 'rendered text preserves the separator');
    assert.equal(await f.driver.composerText(), text);
    await f.driver.pressSend();
    assert.equal(f.sends(), 1);
    assert.equal((await complete(f.driver)).outcome, 'complete');
  });

  test(`edited multiline ${lineBreak} composer is refused before Enter`, async () => {
    const f = fixture(() => 0, lineBreak);
    await f.driver.typeText('First line\nSecond line');
    f.composer.lastChild.textContent = 'Edited second line';
    const edited = f.composer.innerText;
    assert.equal(edited, 'First line\nEdited second line');
    await assert.rejects(f.driver.pressSend(), /Composer changed after typing/);
    assert.equal(f.sends(), 0);
    assert.equal(f.composer.innerText, edited, 'the edited draft remains available for review');
  });
}

for (const clearComposer of [false, true]) {
  test(`failed second Enter refuses prior answer, composer cleared=${clearComposer}`, async () => {
    let now = 0;
    const f = fixture(() => now);
    await f.driver.typeText('First'); await f.driver.pressSend();
    assert.equal((await complete(f.driver)).outcome, 'complete');
    f.mode('unsent'); await f.driver.typeText('Second'); await f.driver.pressSend();
    if (clearComposer) f.composer.textContent = '';
    const {sample, outcome} = await complete(f.driver);
    assert.equal(sample.html, ''); assert.equal(outcome, 'continue');
    now = 10_001;
    await assert.rejects(f.driver.readAnswer(), /not confirmed.*No automatic resend/);
    assert.equal(f.sends(), 2, 'one Enter per task, including the failed send');
  });
}

test('delayed acceptance is allowed, but a different user turn is refused', async () => {
  const f = fixture(); f.mode('unsent');
  await f.driver.typeText('Expected'); await f.driver.pressSend();
  assert.equal((await complete(f.driver)).outcome, 'continue');
  f.add('Expected'); f.composer.textContent = '';
  assert.equal((await complete(f.driver)).outcome, 'complete');
  f.mode('other-user'); await f.driver.typeText('Next'); await f.driver.pressSend();
  await assert.rejects(f.driver.readAnswer(), /does not uniquely match/);
});

test('missing or duplicate DOM identities stop before Enter', async () => {
  for (const bad of ['missing', 'duplicate']) {
    const f = fixture(); const row = f.add('Old');
    if (bad === 'missing') row.setAttribute('data-turn-key', '');
    else f.add('Other old', 'Reply', row.getAttribute('data-turn-key'));
    await f.driver.typeText('New');
    await assert.rejects(f.driver.pressSend(), /identities are unavailable/);
    assert.equal(f.sends(), 0);
  }
});

test('stable identity survives DOM rerender; changed answer identity fails closed', async () => {
  const f = fixture(); await f.driver.typeText('Expected'); await f.driver.pressSend();
  assert.equal((await complete(f.driver)).outcome, 'complete');
  const row = f.document.querySelector('[data-turn-key]');
  const key = row.getAttribute('data-turn-key'); row.remove(); f.add('Expected', 'Same reply', key);
  assert.equal((await complete(f.driver)).outcome, 'complete');
  f.document.querySelector('[data-markdown-text-style]').remove();
  f.add('Intervening user');
  await assert.rejects(f.driver.readAnswer(), /does not uniquely match/);
});

test('stop, streaming, nonempty composer, cancel and binding guards remain effective', async () => {
  for (const extra of ['<button data-testid="stop-button"></button>', '<span data-markdown-animated></span>']) {
    const f = fixture(); await f.driver.typeText('Expected'); await f.driver.pressSend();
    f.document.querySelector('main').insertAdjacentHTML('beforeend', extra);
    for (const element of f.document.querySelectorAll('*')) element.getClientRects = () => [{}];
    assert.equal((await complete(f.driver)).outcome, 'continue');
  }
  const f = fixture(); f.add('Old'); f.mode('unsent');
  await f.driver.typeText('Expected'); await f.driver.pressSend();
  await f.driver.stopGeneration();
  assert.equal((await f.driver.readAnswer()).busy, false, 'cancellation checks raw stop state, not pending submission');
  f.invalidate(); await assert.rejects(f.driver.readAnswer(), /different conversation/);
  const g = fixture(); await g.driver.typeText('Expected'); await g.driver.pressSend();
  g.composer.textContent = 'Draft remains';
  assert.equal((await complete(g.driver)).outcome, 'continue');
});

for (const second of ['accept', 'unsent']) test(`protocol-v3 engine: second submission ${second}`, async () => {
  const rig = await makeRig({pace: {minIntervalMs: 0, maxTypingMs: 0, jitter: 0}, cfg: {aliveTtlMs: 60_000}});
  const f = fixture(() => rig.clock.now()); rig.driver = f.driver;
  const run = startBridge(rig);
  try {
    for (const [text, status] of [['First', 'ok'], ['Second', second === 'accept' ? 'ok' : 'error']]) {
      if (text === 'Second') f.mode(second);
      const task = await rig.client.put(text, {aliveEveryMs: 1000});
      let result;
      const receipt = rig.client.waitResult(task.id, 60_000).then(value => { result = value; });
      assert.ok(await driveUntil(rig, () => !!result)); await receipt;
      assert.equal(result.status, status, JSON.stringify(result));
      if (status === 'ok') assert.equal(result.markdown, 'Same reply');
      else { assert.equal(result.code, 'PLATFORM_ERROR'); assert.equal(result.markdown, undefined); }
    }
    assert.equal(f.sends(), 2);
  } finally {
    rig.stop.stopped = true;
    let done = false; void run.done.finally(() => { done = true; });
    assert.ok(await driveUntil(rig, () => done, 5000));
    await run.done; await cleanupRig(rig);
  }
});

test('protocol-v3 cancellation during unconfirmed send emits no assistant result and never resends', async () => {
  const rig = await makeRig({pace: {minIntervalMs: 0, maxTypingMs: 0, jitter: 0}, cfg: {aliveTtlMs: 60_000}});
  const f = fixture(() => rig.clock.now()); f.mode('unsent'); rig.driver = f.driver;
  const run = startBridge(rig);
  try {
    const task = await rig.client.put('Cancel this', {aliveEveryMs: 1000});
    assert.ok(await driveUntil(rig, () => f.sends() === 1));
    await rig.client.cancel(task.id);
    let result;
    const receipt = rig.client.waitResult(task.id, 60_000).then(value => { result = value; });
    assert.ok(await driveUntil(rig, () => !!result)); await receipt;
    assert.equal(result.status, 'cancelled'); assert.equal(result.markdown, undefined);
    assert.equal(f.sends(), 1); assert.equal(f.composer.innerText, 'Cancel this');
  } finally {
    rig.stop.stopped = true;
    let done = false; void run.done.finally(() => { done = true; });
    assert.ok(await driveUntil(rig, () => done, 5000));
    await run.done; await cleanupRig(rig);
  }
});
