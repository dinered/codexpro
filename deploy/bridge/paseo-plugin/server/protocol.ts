import {mkdir, open, readFile, rename, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomInt, randomUUID} from 'node:crypto';
export const validKey = (key: unknown): key is string => typeof key === 'string' && /^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(key);
export async function atomic(file: string, value: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, file);
}
export async function json(file: string) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function ready(root: string, ttl: number) {
  const file = join(root, 'router.json');
  const state = await json(file);
  return state?.state === 'ready' && Date.now() - (await stat(file)).mtimeMs < ttl;
}
export function turnId() {
  const alphabet = '234567abcdefghijklmnopqrstuvwxyz';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${Array.from({length: 6}, () => alphabet[randomInt(alphabet.length)]).join('')}`;
}
export async function register(root: string, key: string, title?: string) {
  if (!validKey(key)) throw new Error('Invalid persistent chat key');
  const directory = join(root, 'registry');
  await mkdir(directory, {recursive: true, mode: 0o700});
  await mkdir(join(root, 'chats', key, 'spool'), {recursive: true, mode: 0o700});
  await atomic(join(directory, `${key}.json`), {v: 1, key, title: title ?? 'ChatGPT'});
}
export async function put(root: string, key: string, text: string) {
  const id = turnId(), traceId = randomUUID();
  const dir = join(root, 'chats', key, 'spool', id);
  await mkdir(dir, {mode: 0o700});
  await writeFile(join(dir, 'alive'), '', {mode: 0o600});
  await atomic(join(dir, 'task.json'), {v: 3, id, createdAt: Date.now(), traceId, text});
  return {id, traceId, dir};
}
export async function cancel(dir: string) { await writeFile(join(dir, 'cancel'), '', {mode: 0o600}); }
