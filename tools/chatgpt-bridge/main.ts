// Запуск моста: node main.ts [каталог .ai-bridge/paseo] [--limit N]. Chrome с ChatGPT — tools/codexpro-sandbox/README.md.
// Запускает только человек, вручную (Issue #2 п. 6): автозапуска, демона и расписания у моста нет.
import { chromium } from "playwright-core";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { get, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";
import { DEFAULT_LIMIT, FatalError, MAX_LIMIT, PAUSE_MS, runBridge } from "./bridge.ts";
import { sandboxVerdict } from "./preflight.ts";

const MIHOMO = "/tmp/verge/verge-mihomo.sock";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// #внимание-учебно-аналитический-предохранитель — AGENTS.md: ChatGPT под Playwright только через выход FOREIGN_STRICT (группа FOREIGN
// в mihomo Clash Verge).
async function foreignNow(): Promise<unknown> {
  const response = await new Promise<IncomingMessage>((resolve, reject) =>
    get({ socketPath: MIHOMO, path: "/proxies/FOREIGN" }, resolve).on("error", reject),
  );
  return JSON.parse(await text(response)).now;
}

// #внимание-учебно-аналитический-предохранитель — лимит сообщений за запуск: по умолчанию DEFAULT_LIMIT, больше — только явным --limit,
// не больше MAX_LIMIT (ядро моста проверяет то же).
const options = { limit: { type: "string", default: String(DEFAULT_LIMIT) } } as const;
const { values, positionals } = parseArgs({ allowPositionals: true, options });
const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT || positionals.length > 1) {
  fail(`использование: node main.ts [каталог .ai-bridge/paseo] [--limit N], N от 1 до ${MAX_LIMIT}, по умолчанию ${DEFAULT_LIMIT}`);
}
const root = positionals[0] ?? join(homedir(), "work/ai/codexpro/2/sandbox/.ai-bridge/paseo");

const now = await foreignNow().catch((error) => fail(`не удалось спросить mihomo (${MIHOMO}): ${error.message}`));
if (now !== "FOREIGN_STRICT") fail(`группа FOREIGN в mihomo стоит на «${now}», нужен FOREIGN_STRICT — мост не запускаю`);

// Пока запущен codexpro-sandbox, мост к Chrome с входом в ChatGPT не подключается (preflight.ts).
const docker = ["--context", "orbstack", "inspect", "-f", "{{.State.Running}}", "codexpro-sandbox"];
const verdict = await new Promise<string | null>((resolve) =>
  execFile("docker", docker, { timeout: 15_000 }, (error, stdout, stderr) => resolve(sandboxVerdict(error, String(stdout), String(stderr)))),
);
if (verdict) fail(verdict);

await mkdir(root, { recursive: true }); // мост запускают до первой задачи: плагин папку мог ещё не создать
// #внимание-учебно-аналитический-предохранитель — только подключение к уже открытому Chrome оператора: браузер мост не запускает
// (свой запуск ещё и выбивает вход в ChatGPT).
const browser = await chromium
  .connectOverCDP("http://127.0.0.1:9222")
  .catch((error) => fail(`нет Chrome с отладкой на 127.0.0.1:9222 (tools/codexpro-sandbox/README.md): ${error.message}`));
const abort = new AbortController();
// #внимание-учебно-аналитический-предохранитель — остановка оператором: Ctrl+C, а также SIGTERM и SIGHUP (закрыли окно терминала) —
// мост жмёт «Остановить» в ChatGPT и снимает захват; без этого он умер бы посреди ответа, и следующий
// запуск счёл бы задачу брошенной.
process.stdout.on("error", () => {}); // после SIGHUP терминала нет: запись в него не должна ронять мост
process.stderr.on("error", () => {});
for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(name, () => {
    if (abort.signal.aborted) process.exit(130);
    abort.abort();
    console.log("мост останавливается, идущий ответ ChatGPT будет остановлен; Ctrl+C ещё раз — выйти сразу");
  });
}
try {
  const pages = browser.contexts().flatMap((c) => c.pages()).filter((p) => p.url().startsWith("https://chatgpt.com/"));
  // #внимание-учебно-аналитический-предохранитель — ровно одна вкладка chatgpt.com: мост не выбирает чат сам
  if (pages.length !== 1) throw new FatalError(`нужна ровно одна вкладка chatgpt.com, открыто: ${pages.length}`);
  // #модельный-учебно-аналитический-контроль — по строкам начала и конца прогона (и итогу из runBridge) Claude
  // сверяет прогон с чек-листом tools/chatgpt-bridge/README.md («Живой прогон»): лимит, пауза, сколько отправлено
  // и почему мост остановился.
  console.log(`мост: ${root} → открытый чат ChatGPT, не больше ${limit} сообщений, пауза ${PAUSE_MS / 1000} с; Ctrl+C — стоп`);
  await runBridge({ page: pages[0], root, limit, signal: abort.signal });
  console.log("мост остановлен");
} catch (error) {
  if (!(error instanceof FatalError)) throw error;
  console.error(`мост остановлен: ${error.message}`);
  process.exitCode = 1;
} finally {
  await browser.close(); // для CDP только отключается, Chrome и вход остаются
}
