// Запуск моста: node main.ts [каталог .ai-bridge/paseo]. Chrome с ChatGPT — tools/codexpro-sandbox/README.md.
import { chromium } from "playwright-core";
import { homedir } from "node:os";
import { join } from "node:path";
import { runBridge, SEL } from "./bridge.ts";

const root = process.argv[2] ?? join(homedir(), "work/ai/codexpro/2/sandbox/.ai-bridge/paseo");
// Только подключение к уже открытому Chrome: свой запуск браузера выбивает вход в ChatGPT.
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
try {
  const pages = browser.contexts().flatMap((c) => c.pages()).filter((p) => p.url().startsWith("https://chatgpt.com/"));
  if (pages.length !== 1) throw new Error(`нужна ровно одна вкладка chatgpt.com, открыто: ${pages.length}`);
  if (!(await pages[0].locator(SEL.composer).isVisible())) throw new Error("нет поля ввода ChatGPT — вход не выполнен?");
  console.log(`мост: ${root} → открытый чат ChatGPT; Ctrl+C — стоп`);
  await runBridge({ page: pages[0], root });
} finally {
  await browser.close(); // для CDP только отключается, Chrome и вход остаются
}
