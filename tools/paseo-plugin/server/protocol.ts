// Протокол обмена файлами v2: плагин codexpro-worker ↔ исполнитель (мост tools/chatgpt-bridge,
// человек или ChatGPT через CodexPro). Папка сессии: <cwd>/.ai-bridge/paseo/<сессия>/
//
//   task-<id>.md   плагин: текст задачи; mtime — пульс плагина (раз в PULSE_MS, пока ход идёт)
//   claim-<id>     мост: захват задачи (создание O_EXCL), внутри — токен владельца; mtime — пульс моста
//   reply-<id>.md  исполнитель: ответ
//   error-<id>.md  мост: задача не выполнена, внутри — причина
// В корне .ai-bridge/paseo/: .bridge.lock — замок единственного моста (O_EXCL, токен, пульс).
//
// Плагин принимает ответ или ошибку только для активного id, файлы чужих id удаляет.
// Исполнитель берёт задачу, только если пульс плагина свежий: задача без пульса — остаток мёртвого хода.
// Файлы читаются без перехода по ссылкам: в режиме codexpro ChatGPT сам пишет в рабочую папку.
// Модуль без зависимостей: его импортирует и плагин, и мост (node main.ts).
// #учебно-не-боевое-07 — очередь — папка с файлами; в бою — брокер сообщений с подтверждениями и DLQ или прямой вызов
// API без посредника (docs/training-vs-production.md).
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, lutimes, open, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

export const PULSE_MS = 5_000;
export const LEASE_MS = 30_000; // пульса нет дольше — сторона считается мёртвой

// Корень задач в рабочей папке и замок единственного моста в нём (mtime — пульс моста).
// #учебно-не-боевое-07 — корень протокола — внутри рабочего дерева git агента: переписка может попасть в коммит, а git clean
// удаляет живые ходы; в бою состояние очереди — вне данных пользователя.
export const tasksRoot = (cwd: string) => join(cwd, ".ai-bridge", "paseo");
export const BRIDGE_LOCK = ".bridge.lock";

export type Kind = "task" | "claim" | "reply" | "error";

export const fileName = (kind: Kind, id: string) => (kind === "claim" ? `claim-${id}` : `${kind}-${id}.md`);
export const newTaskId = () => randomUUID();
export const ownerToken = () => `${hostname()}:${process.pid}:${randomUUID()}`;

const NAME = /^(task|claim|reply|error)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.md)?$/;

// Имя файла протокола → вид и id; чужие и временные файлы — null.
export function parseName(name: string): { kind: Kind; id: string } | null {
  const m = NAME.exec(name);
  if (!m || (m[1] === "claim") === (m[3] === ".md")) return null;
  return { kind: m[1] as Kind, id: m[2] };
}

const errno = (error: unknown) => (error as { code?: string }).code;

// #внимание-учебно-аналитический-предохранитель — файлы протокола читаются и пишутся без перехода по ссылкам: в режиме codexpro ChatGPT
// сам пишет в рабочую папку и мог бы подложить ссылку на ~/.ssh/… (writeAtomic, readRegular, pulse). Только последний
// компонент пути: каталоги протокола проверяет вызывающий (мост — корень при запуске и папки сессий, но не .ai-bridge;
// плагин — нет; docs/training-vs-production.md, 13).
// #учебно-не-боевое-13 — защита — гигиена самого файла в папке, общей с ChatGPT; кто написал файл, не проверяется. В бою
// канал управления отделён от данных: другая учётка ОС или очередь, подпись сообщений, разбор пути без ссылок.
// Атомарная запись: уникальный временный файл (O_EXCL — по подложенной ссылке не пойдёт), fsync,
// rename поверх (заменяет саму ссылку, не её цель), fsync папки. Читатель видит старое или новое целиком.
export async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const file = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
  try {
    await file.writeFile(data);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
  await syncDir(dirname(path));
}

async function syncDir(dir: string) {
  const handle = await open(dir, constants.O_RDONLY).catch(() => null);
  if (!handle) return;
  // ponytail: fsync папки — best effort; часть ФС (virtiofs, тома Docker) его не поддерживает
  // #учебно-не-боевое-09 — в бою — хранилище с заявленными гарантиями записи
  await handle.sync().catch(() => {});
  await handle.close();
}

// Читает обычный файл, не следуя по ссылке. Нет файла — null; ссылка или не файл — ошибка.
// O_NONBLOCK: подложенный FIFO не подвесит open(), а дальше его отсечёт проверка isFile().
export async function readRegular(path: string): Promise<string | null> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errno(error) === "ENOENT") return null;
    if (errno(error) === "ELOOP") throw new Error(`ссылка вместо файла: ${path}`);
    throw error;
  }
  try {
    if (!(await file.stat()).isFile()) throw new Error(`не обычный файл: ${path}`);
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

// Обычный файл (не ссылка) с пульсом не старше leaseMs.
export async function isFresh(path: string, leaseMs = LEASE_MS, now = Date.now()): Promise<boolean> {
  const info = await lstat(path).catch(() => null);
  return !!info?.isFile() && now - info.mtimeMs < leaseMs;
}

// Пульс — время изменения самого файла. lutimes: подложенная ссылка получает время сама, её цель не трогается,
// а isFresh() ссылку живой не считает.
export async function pulse(path: string): Promise<void> {
  const now = new Date();
  await lutimes(path, now, now);
}

// Захват (задачи или единственного экземпляра моста): создать файл с токеном через O_EXCL.
// Занят живым владельцем — false; брошен (нет пульса leaseMs) — снять и попробовать ещё раз.
// "taken-over" — захват перехвачен у упавшего владельца: тот мог успеть сделать часть работы.
// ponytail: двое одновременно перехватывают брошенный захват — один может снять свежий захват другого;
// поэтому владелец сверяет owns() на каждом пульсе и уступает, если токен в файле уже не его.
// #учебно-не-боевое-08 — аренда по mtime (зависит от часов и ФС); в бою — аренда в брокере или БД и токен ограждения.
export async function acquire(path: string, token: string, leaseMs = LEASE_MS): Promise<false | "created" | "taken-over"> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
      try {
        await file.writeFile(token);
        await file.sync();
      } finally {
        await file.close();
      }
      return attempt ? "taken-over" : "created";
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
    }
    if (await isFresh(path, leaseMs)) return false;
    await unlink(path).catch(() => {});
  }
  return false;
}

export async function owns(path: string, token: string): Promise<boolean> {
  return (await readRegular(path).catch(() => null)) === token;
}

export async function release(path: string, token: string): Promise<void> {
  if (await owns(path, token)) await unlink(path).catch(() => {});
}
