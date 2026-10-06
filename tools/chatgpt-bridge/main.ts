// Запуск моста: node main.ts [каталог .ai-bridge/paseo] [--limit N]. Chrome с ChatGPT — tools/codexpro-sandbox/README.md.
import { chromium } from "playwright-core";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { get, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";
import { FatalError, runBridge } from "./bridge.ts";

const MIHOMO = "/tmp/verge/verge-mihomo.sock";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// AGENTS.md: ChatGPT под Playwright — только через выход FOREIGN_STRICT (группа FOREIGN в mihomo Clash Verge).
async function foreignNow(): Promise<unknown> {
  const response = await new Promise<IncomingMessage>((resolve, reject) =>
    get({ socketPath: MIHOMO, path: "/proxies/FOREIGN" }, resolve).on("error", reject),
  );
  return JSON.parse(await text(response)).now;
}

const { values, positionals } = parseArgs({ allowPositionals: true, options: { limit: { type: "string", default: "500" } } });
const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1 || limit > 500 || positionals.length > 1) {
  fail("использование: node main.ts [каталог .ai-bridge/paseo] [--limit N], N от 1 до 500");
}
const root = positionals[0] ?? join(homedir(), "work/ai/codexpro/2/sandbox/.ai-bridge/paseo");

const now = await foreignNow().catch((error) => fail(`не удалось спросить mihomo (${MIHOMO}): ${error.message}`));
if (now !== "FOREIGN_STRICT") fail(`группа FOREIGN в mihomo стоит на «${now}», нужен FOREIGN_STRICT — мост не запускаю`);

// Контейнеры OrbStack достают до CDP Мака (host.docker.internal → 127.0.0.1:9222), а в codexpro-sandbox
// ChatGPT выполняет команды: пока он запущен, мост к Chrome с входом в ChatGPT не подключается.
const codexpro = await new Promise<string>((resolve) =>
  execFile("docker", ["inspect", "-f", "{{.State.Running}}", "codexpro-sandbox"], (_, stdout) => resolve(String(stdout).trim())),
);
if (codexpro === "true") fail("запущен codexpro-sandbox, а он видит CDP этого Chrome; остановите: docker stop codexpro-sandbox");

await mkdir(root, { recursive: true }); // мост запускают до первой задачи: плагин папку мог ещё не создать
// Только подключение к уже открытому Chrome: свой запуск браузера выбивает вход в ChatGPT.
const browser = await chromium
  .connectOverCDP("http://127.0.0.1:9222")
  .catch((error) => fail(`нет Chrome с отладкой на 127.0.0.1:9222 (tools/codexpro-sandbox/README.md): ${error.message}`));
const abort = new AbortController();
process.on("SIGINT", () => {
  if (abort.signal.aborted) process.exit(130);
  abort.abort();
  console.log("мост останавливается, идущий ответ ChatGPT будет остановлен; Ctrl+C ещё раз — выйти сразу");
});
try {
  const pages = browser.contexts().flatMap((c) => c.pages()).filter((p) => p.url().startsWith("https://chatgpt.com/"));
  if (pages.length !== 1) throw new FatalError(`нужна ровно одна вкладка chatgpt.com, открыто: ${pages.length}`);
  console.log(`мост: ${root} → открытый чат ChatGPT, не больше ${limit} сообщений; Ctrl+C — стоп`);
  const { sent } = await runBridge({ page: pages[0], root, limit, signal: abort.signal });
  console.log(`мост остановлен, отправлено сообщений: ${sent}`);
} catch (error) {
  if (!(error instanceof FatalError)) throw error;
  console.error(`мост остановлен: ${error.message}`);
  process.exitCode = 1;
} finally {
  await browser.close(); // для CDP только отключается, Chrome и вход остаются
}
