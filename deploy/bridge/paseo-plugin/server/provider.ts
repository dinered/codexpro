import type {ProviderConnection, ProviderEvent, ProviderInput, ProviderRegistration} from '@getpaseo/plugin/server/provider';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {rename, utimes} from 'node:fs/promises';
import {cancel, json, put, ready, register, validKey} from './protocol.ts';
import {messageText} from './message-text.ts';
const capabilities = ['prompt.message', 'session.persistence'] as const;
const models = [{id: 'chatgpt', label: 'ChatGPT (постоянная вкладка Chrome)'}];
type Options = {root?: string; pollMs?: number; pulseMs?: number; heartbeatTtlMs?: number; writeTask?: typeof put; registerChat?: typeof register};
type Active = {turnId: string; id: string; traceId: string; dir: string; timer?: ReturnType<typeof setTimeout>; pulser?: ReturnType<typeof setInterval>; deadline: number; cancelRequested: boolean; interrupts: Set<string>};
type Session = {key: string; cwd: string; active: Active | null};
export function createProvider(options: Options = {}): ProviderRegistration {
  const root = options.root ?? process.env.CODEXPRO_STATE_DIR ?? join(homedir(), '.paseo', 'codexpro');
  return {id: 'codexpro-browser', label: 'ChatGPT (Chrome)', description: 'Отдельная постоянная вкладка ChatGPT для каждого чата Paseo',
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error('Provider protocol 1 required');
      return connection(root, capabilities.filter(value => request.capabilities.includes(value)), options);
    }};
}
function connection(root: string, supported: string[], options: Options): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>(), sessions = new Map<string, Session>();
  let closed = false;
  const emit = (event: ProviderEvent) => { if (!closed) for (const listener of listeners) listener(event); };
  const heartbeatTtl = options.heartbeatTtlMs ?? 20_000;
  const stopTimers = (active: Active) => { clearTimeout(active.timer); clearInterval(active.pulser); };
  function finishInterrupts(active: Active, error?: string) {
    for (const requestId of active.interrupts) emit(error
      ? {type: 'request.failed', requestId, error: {message: error}}
      : {type: 'request.completed', requestId});
    active.interrupts.clear();
  }
  function terminal(sessionId: string, session: Session, active: Active, state: 'completed' | 'failed' | 'canceled', error?: string) {
    if (session.active !== active) return;
    stopTimers(active); session.active = null;
    emit({type: 'session.turn', sessionId, turnId: active.turnId, state, ...(error ? {error: {message: error}} : {})});
    finishInterrupts(active);
  }
  async function poll(sessionId: string, session: Session, active: Active) {
    if (closed || session.active !== active) return;
    try {
      const result = await json(join(active.dir, 'result.json'));
      if (closed || session.active !== active) return;
      if (result) {
        if (result.traceId !== active.traceId || !['ok', 'error', 'cancelled'].includes(result.status)
          || (result.status === 'ok' ? typeof result.markdown !== 'string' || !result.markdown.trim() : typeof result.code !== 'string')) throw new Error('Invalid protocol-v3 result; retained for operator review');
        await rename(join(active.dir, 'result.json'), join(active.dir, 'result.ack'));
        if (result.status === 'ok') emit({type: 'timeline.item', sessionId, item: {type: 'assistant_message', id: `assistant:${active.turnId}`, text: result.markdown}});
        terminal(sessionId, session, active, result.status === 'ok' ? 'completed' : result.status === 'cancelled' ? 'canceled' : 'failed', result.message ?? result.code); return;
      }
      if (Date.now() > active.deadline || !await ready(root, heartbeatTtl)) throw new Error('Browser bridge stopped; resume it after manual takeover');
    } catch (error) { await cancel(active.dir).catch(() => {}); terminal(sessionId, session, active, 'failed', String(error)); return; }
    if (!closed && session.active === active) active.timer = setTimeout(() => void poll(sessionId, session, active), options.pollMs ?? 500);
  }
  async function prompt(input: Extract<ProviderInput, {type: 'session.prompt'}>) {
    const {sessionId, prompt} = input, session = sessions.get(sessionId);
    const reject = (message: string) => emit({type: 'session.prompt_result', sessionId, clientMessageId: prompt.clientMessageId, result: {type: 'failed', error: {message}}});
    if (!session) return reject('Session is not open');
    if (session.active) return reject('Previous turn is still active');
    if (prompt.delivery === 'steer' || prompt.input.type !== 'message' || prompt.input.content.some(part => part.type !== 'text') || prompt.outputSchema) return reject('This provider accepts ordinary text messages only');
    const text = prompt.input.content.map(part => part.type === 'text' ? part.text : '').join('\n');
    let taskText: string;
    try { taskText = messageText(text, prompt.clientMessageId); }
    catch (error) { return reject(error instanceof Error ? error.message : 'Invalid message envelope'); }
    if (!taskText.trim()) return reject('Message is empty');
    if (!await ready(root, heartbeatTtl)) return reject('Browser bridge is stopped; complete manual login and start it');
    if (closed || session.active || sessions.get(sessionId) !== session) return reject('Session changed while preparing the turn');
    const active: Active = {turnId: randomUUID(), id: '', traceId: '', dir: '', deadline: Date.now() + 35 * 60_000, cancelRequested: false, interrupts: new Set()};
    session.active = active;
    try {
      Object.assign(active, await (options.writeTask ?? put)(root, session.key, taskText));
      if (closed || session.active !== active) { await cancel(active.dir); return; }
      if (active.cancelRequested) await cancel(active.dir);
      emit({type: 'timeline.item', sessionId, item: {type: 'user_message', id: `user:${active.turnId}`, text, clientMessageId: prompt.clientMessageId}});
      emit({type: 'session.prompt_result', sessionId, clientMessageId: prompt.clientMessageId, result: {type: 'turn', turnId: active.turnId}});
      emit({type: 'session.turn', sessionId, turnId: active.turnId, state: 'started'});
      active.pulser = setInterval(() => { const now = new Date(); void utimes(join(active.dir, 'alive'), now, now).catch(error => { void cancel(active.dir).catch(() => {}); terminal(sessionId, session, active, 'failed', String(error)); }); }, options.pulseMs ?? 10_000);
      void poll(sessionId, session, active);
    } catch (error) { if (closed || sessions.get(sessionId) !== session || session.active !== active) return; session.active = null; finishInterrupts(active, String(error)); reject(String(error)); }
  }
  async function dispatch(input: ProviderInput) {
    if (closed) return;
    switch (input.type) {
      case 'catalog': emit({type: 'catalog', requestId: input.requestId, catalog: {models, modes: [], thinkingOptions: [], defaultModel: 'chatgpt'}}); return;
      case 'session.open': {
        if (sessions.has(input.sessionId)) throw new Error('Session already open');
        if (input.config.model && input.config.model !== 'chatgpt') throw new Error('Unknown model');
        const persisted = input.persistence?.data;
        const savedKey = persisted && typeof persisted === 'object' && !Array.isArray(persisted) ? persisted.chatKey : undefined;
        if (input.persistence && (input.persistence.version !== 1 || !validKey(savedKey))) throw new Error('Invalid session persistence');
        const key = validKey(savedKey) ? savedKey : randomUUID();
        if ([...sessions.values()].some(session => session.key === key)) throw new Error('This chat binding is already open in another session');
        const session: Session = {key, cwd: input.config.cwd, active: null};
        sessions.set(input.sessionId, session);
        try { await (options.registerChat ?? register)(root, key, input.config.title); } catch (error) { if (sessions.get(input.sessionId) === session) sessions.delete(input.sessionId); throw error; }
        if (closed || sessions.get(input.sessionId) !== session) return;
        const persistence = {version: 1, data: {chatKey: key}};
        emit({type: 'session.opened', requestId: input.requestId, sessionId: input.sessionId, capabilities: supported, restoration: 'core', persistence, cwd: input.config.cwd});
        emit({type: 'session.persistence', sessionId: input.sessionId, persistence});
        emit({type: 'session.config', sessionId: input.sessionId, config: {model: 'chatgpt', models, modes: [], thinkingOptions: [], settings: []}});
        emit({type: 'session.ready', requestId: input.requestId, sessionId: input.sessionId}); return;
      }
      case 'session.prompt': return prompt(input);
      case 'session.interrupt': {
        const session = sessions.get(input.sessionId), active = session?.active;
        if (active) {
          active.cancelRequested = true;
          if (active.dir) await cancel(active.dir);
          if (closed || sessions.get(input.sessionId) !== session) throw new Error('Session closed during interruption');
          // Paseo may force-cancel its visible turn after an acknowledged interrupt.
          // The cancel file only requests cancellation; acknowledge after terminal().
          if (session.active === active) { active.interrupts.add(input.requestId); return; }
        }
        emit({type: 'request.completed', requestId: input.requestId}); return;
      }
      case 'session.close': {
        const session = sessions.get(input.sessionId), active = session?.active;
        if (active) {
          active.cancelRequested = true;
          if (active.dir) await cancel(active.dir);
          stopTimers(active);
          finishInterrupts(active, 'Session closed during interruption');
          if (session.active === active) session.active = null;
        }
        sessions.delete(input.sessionId);
        emit({type: 'session.closed', sessionId: input.sessionId}); emit({type: 'request.completed', requestId: input.requestId}); return;
      }
      default: if ('requestId' in input) emit({type: 'request.failed', requestId: input.requestId, error: {message: 'Unsupported provider operation'}});
    }
  }
  return {version: 1, capabilities: supported,
    async send(input) {
      if (closed) throw new Error('Provider connection closed');
      queueMicrotask(() => { dispatch(input).catch(error => {
        if ('requestId' in input) emit({type: 'request.failed', requestId: input.requestId, error: {message: String(error)}});
        else if (input.type === 'session.prompt') emit({type: 'session.prompt_result', sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId, result: {type: 'failed', error: {message: String(error)}}});
      }); });
    },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async close() { closed = true; for (const session of sessions.values()) if (session.active) { stopTimers(session.active); if (session.active.dir) await cancel(session.active.dir).catch(() => {}); session.active = null; } sessions.clear(); listeners.clear(); }};
}
