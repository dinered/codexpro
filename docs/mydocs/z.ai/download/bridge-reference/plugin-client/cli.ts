// Демо-клиент плагина: node plugin-client/cli.ts put "текст" | wait <id> | stop <id> | list
// put ставит ход и ждёт результат (alive пульсирует, пока процесс жив), затем
// подтверждает его и удаляет каталог хода — удаление ТОЛЬКО после ack (Н-1).
// Тайм-аут ожидания ≠ конец хода: каталог не трогается, ход можно досмотреть
// командой wait <id> или снять командой stop <id>. В другом терминале: npm run demo.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { SystemClock } from "../src/core/clock.ts";
import { CryptoRandom } from "../src/core/random.ts";
import { createLogger } from "../src/core/log.ts";
import { errorMessage } from "../src/core/errors.ts";
import { PluginClient } from "./client.ts";
import type { TurnResult } from "../src/core/types.ts";

const USAGE = 'использование: node plugin-client/cli.ts put "текст" | wait <id> [секунд] | stop <id> | list';
const root = process.env.BRIDGE_SPOOL ?? join(process.cwd(), "spool-demo");

const [command, ...rest] = process.argv.slice(2);
const client = new PluginClient(root, new SystemClock(), new CryptoRandom(), createLogger());

/** Напечатать результат и убрать каталог хода (ack уже сделан внутри waitResult). */
async function reportAndDispose(id: string, result: TurnResult): Promise<void> {
  console.log(`статус: ${result.status}${result.code ? ` (${result.code})` : ""}`);
  if (result.markdown) console.log("---\n" + result.markdown + "\n---");
  else if (result.message) console.log(`сообщение: ${result.message}`);
  await client.dispose(id); // требует result.ack — ход не потерять и не продублировать (Н-1)
}

if (command === "put") {
  const text = rest.join(" ").trim();
  if (!text) {
    console.error(USAGE);
    process.exit(1);
  }
  const task = await client.put(text);
  console.log(`ход поставлен: ${task.id} (spool: ${root})`);
  let result: TurnResult | null;
  try {
    result = await client.waitResult(task.id, 2 * 60 * 60 * 1000, 1_000);
  } catch (error) {
    console.error(`ошибка ожидания: ${errorMessage(error)} — ход ${task.id} оставлен в spool`);
    process.exit(1);
  }
  if (result === null) {
    // ход НЕ трогаем: мост может быть в паузе темпа, бэкоффе или ожидании окна
    client.stopPulse(task.id); // процесс завершается: без пульса мост закроет ход как снятый через 70 с
    console.log(`результ нет (тайм-аут ожидания). Ход ${task.id} оставлен в spool: досмотреть — wait ${task.id}, снять — stop ${task.id}`);
    process.exitCode = 1;
  } else {
    await reportAndDispose(task.id, result);
  }
} else if (command === "wait") {
  const id = rest[0];
  if (!id) {
    console.error(USAGE);
    process.exit(1);
  }
  const seconds = Number(rest[1] ?? "7200");
  const result = await client.waitResult(id, (Number.isFinite(seconds) && seconds > 0 ? seconds : 7200) * 1000, 1_000);
  if (result === null) {
    client.stopPulse(id);
    console.log(`результ нет (тайм-аут ожидания). Ход ${id} оставлен в spool: снять — stop ${id}`);
    process.exitCode = 1;
  } else {
    await reportAndDispose(id, result);
  }
} else if (command === "stop") {
  const id = rest[0];
  if (!id) {
    console.error(USAGE);
    process.exit(1);
  }
  await client.cancel(id);
  console.log(`отмена записана: ${id}`);
} else if (command === "list") {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const hasTask = await stat(join(root, entry.name, "task.json")).then(() => true, () => false);
    console.log(`${entry.name}${hasTask ? "" : "  (без task.json)"}`);
  }
} else {
  console.error(USAGE);
  process.exit(1);
}
