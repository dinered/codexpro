// Запуск моста: node main.ts [каталог .ai-bridge/paseo] [--limit N]. Chrome с ChatGPT — tools/codexpro-sandbox/README.md.
// Запускает только человек, вручную (Issue #2 п. 6): автозапуска, демона и расписания у моста нет.
import { chromium } from "playwright-core";
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { get, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";
import { DEFAULT_LIMIT, FatalError, MAX_LIMIT, runBridge } from "./bridge.ts";
import { chromeVerdict, containersVerdict, journalLine, stopSignalAction } from "./cli.ts";

const MIHOMO = "/tmp/verge/verge-mihomo.sock";
const WORK = join(homedir(), "work/ai/codexpro/2");
const PROFILE = join(WORK, "sandbox-chrome/profile");
// #модельный-учебно-аналитический-контроль — журнал прогонов вне песочницы. Пишет его сам мост, поэтому журнал
// переживает закрытое окно терминала; текстов задач и ответов в нём нет. По нему Claude сверяет прогон с чек-листом
// tools/chatgpt-bridge/README.md («Живой прогон»): проверки, лимит, паузы, сколько отправлено, почему мост остановился.
const JOURNAL = join(WORK, "bridge-runs.log");

function log(line: string) {
  const stamped = journalLine(new Date(), line);
  appendFileSync(JOURNAL, stamped + "\n");
  console.log(stamped);
}

function fail(message: string): never {
  log(`мост не запущен: ${message}`);
  process.exit(1);
}

// Команда с таймаутом; ошибку не бросает, а возвращает — решают чистые функции из cli.ts.
function run(command: string, args: string[]) {
  return new Promise<{ error: Error | null; stdout: string; stderr: string }>((resolve) =>
    execFile(command, args, { timeout: 15_000 }, (error, stdout, stderr) =>
      resolve({ error, stdout: String(stdout), stderr: String(stderr) }),
    ),
  );
}

// #внимание-учебно-аналитический-предохранитель — AGENTS.md: ChatGPT под Playwright только через выход FOREIGN_STRICT
// (группа FOREIGN в mihomo Clash Verge); что Chrome ходит именно через эту группу — проверка Chrome ниже.
async function foreignNow(): Promise<unknown> {
  const response = await new Promise<IncomingMessage>((resolve, reject) =>
    get({ socketPath: MIHOMO, path: "/proxies/FOREIGN" }, resolve).on("error", reject),
  );
  return JSON.parse(await text(response)).now;
}

// #внимание-учебно-аналитический-предохранитель — лимит сообщений за запуск: по умолчанию DEFAULT_LIMIT, больше — только
// явным --limit, не больше MAX_LIMIT (ядро моста проверяет то же).
const options = { limit: { type: "string", default: String(DEFAULT_LIMIT) } } as const;
const { values, positionals } = parseArgs({ allowPositionals: true, options });
const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT || positionals.length > 1) {
  fail(`использование: node main.ts [каталог .ai-bridge/paseo] [--limit N], N от 1 до ${MAX_LIMIT}, по умолчанию ${DEFAULT_LIMIT}`);
}
const root = positionals[0] ?? join(WORK, "sandbox/.ai-bridge/paseo");

// Остановка оператором (cli.ts, stopSignalAction): Ctrl+C, SIGTERM и закрытое окно терминала (SIGHUP).
const abort = new AbortController();
process.stdout.on("error", () => {}); // после SIGHUP терминала нет: запись в него не должна ронять мост
process.stderr.on("error", () => {});
for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(name, () => {
    const action = stopSignalAction(name, abort.signal.aborted);
    if (action === "exit") {
      log(`${name} повторно: выход сразу — идущий ответ ChatGPT не остановлен, захват задачи и замок моста не сняты`);
      process.exit(130);
    }
    if (action === "ignore") return;
    abort.abort();
    log(`${name}: мост останавливается, идущий ответ ChatGPT будет остановлен; Ctrl+C ещё раз — выйти сразу`);
  });
}

const now = await foreignNow().catch((error) => fail(`не удалось спросить mihomo (${MIHOMO}): ${error.message}`));
if (now !== "FOREIGN_STRICT") fail(`группа FOREIGN в mihomo стоит на «${now}», нужен FOREIGN_STRICT`);

const containers = await run("docker", ["--context", "orbstack", "ps", "-a", "--format", "{{.Names}}\t{{.State}}"]);
const { refusal, running } = containersVerdict(containers.error, containers.stdout, containers.stderr);
if (refusal) fail(refusal);
const machines = await run("orb", ["list"]);
const vms = machines.stdout.split("\n").filter((line) => /\srunning\s/.test(line)).map((line) => line.split(/\s+/)[0]);
// #модельный-учебно-аналитический-контроль — кто ещё видит CDP этого Chrome: чек-лист требует остановить или принять явно
log(`рядом работают (видят CDP): контейнеры — ${running.join(", ") || "нет"}; машины OrbStack — ${machines.error ? `не удалось узнать (${machines.error.message})` : vms.join(", ") || "нет"}`);

const listeners = await run("lsof", ["-nP", "-iTCP@127.0.0.1:9222", "-sTCP:LISTEN", "-t"]);
const commands: string[] = [];
for (const pid of listeners.stdout.split("\n").filter(Boolean)) {
  commands.push((await run("ps", ["-ww", "-o", "command=", "-p", pid])).stdout.trim());
}
const chrome = chromeVerdict(commands, PROFILE);
if (chrome) fail(chrome);

// мост запускают до первой задачи: плагин папку мог ещё не создать
await mkdir(root, { recursive: true }).catch((error) => fail(`не удалось создать каталог задач ${root}: ${error.message}`));
// #внимание-учебно-аналитический-предохранитель — только подключение к уже открытому Chrome оператора: браузер мост
// не запускает (свой запуск ещё и выбивает вход в ChatGPT).
const browser = await chromium
  .connectOverCDP("http://127.0.0.1:9222")
  .catch((error) => fail(`нет Chrome с отладкой на 127.0.0.1:9222 (tools/codexpro-sandbox/README.md): ${error.message}`));
try {
  const pages = browser.contexts().flatMap((c) => c.pages()).filter((p) => p.url().startsWith("https://chatgpt.com/"));
  // #внимание-учебно-аналитический-предохранитель — ровно одна вкладка chatgpt.com: мост не выбирает чат сам
  if (pages.length !== 1) throw new FatalError(`нужна ровно одна вкладка chatgpt.com, открыто: ${pages.length}`);
  console.log("Ctrl+C — остановить мост");
  await runBridge({ page: pages[0], root, limit, log, signal: abort.signal });
  log("мост остановлен");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log(`мост остановлен: ${message}`);
  process.exitCode = 1;
  if (!(error instanceof FatalError)) throw error;
} finally {
  await browser.close(); // для CDP только отключается, Chrome и вход остаются
}
