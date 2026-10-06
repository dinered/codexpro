import { expect, test } from "@playwright/test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBridge, SEL } from "../../tools/chatgpt-bridge/bridge.ts";

// Мост против имитации ChatGPT: живой ChatGPT здесь не нужен.
const FAKE = new URL("fake-chatgpt.html", import.meta.url).href;
const quiet = () => {};

async function sessions(...texts: string[]) {
  const root = await mkdtemp(join(tmpdir(), "chatgpt-bridge-"));
  const boxes: string[] = [];
  for (const [i, text] of texts.entries()) {
    const box = join(root, `s${i + 1}`);
    await mkdir(box);
    await writeFile(join(box, "task.md"), text);
    boxes.push(box);
  }
  return { root, boxes };
}

const sent = (page: import("@playwright/test").Page) => page.evaluate(() => (window as any).sent);

test("задача из task.md уходит в чат, ответ — в reply.md; лимит соблюдается", async ({ page }) => {
  await page.goto(FAKE);
  const { root, boxes } = await sessions("строка 1\nстрока 2", "вторая задача");

  await runBridge({ page, root, limit: 1, pollMs: 50, ignoreExisting: false, log: quiet });

  expect(await sent(page)).toEqual(["строка 1\nстрока 2"]);
  expect(await readFile(join(boxes[0], "reply.md"), "utf8")).toBe("Эхо: строка 1\nстрока 2");
  await expect(access(join(boxes[1], "reply.md"))).rejects.toThrow();
});

test("«Стоп» в Paseo (task.md удалён) останавливает ответ в ChatGPT", async ({ page }) => {
  await page.goto(`${FAKE}?ms=200`);
  const { root, boxes } = await sessions("долгая задача");

  const run = runBridge({ page, root, limit: 1, pollMs: 50, ignoreExisting: false, log: quiet });
  await expect(page.locator(SEL.answer)).toHaveCount(1); // ответ пошёл
  await rm(join(boxes[0], "task.md"));
  await run;

  expect(await page.evaluate(() => (window as any).stopped)).toBe(1);
  await expect(access(join(boxes[0], "reply.md"))).rejects.toThrow();
});

test("задачи, лежавшие до запуска моста, не отправляются", async ({ page }) => {
  await page.goto(FAKE);
  const { root } = await sessions("старая задача");
  let skipped!: () => void;
  const ready = new Promise<void>((resolve) => (skipped = resolve));

  const run = runBridge({ page, root, limit: 1, pollMs: 50, log: (line) => line.includes("до запуска") && skipped() });
  await ready;
  await mkdir(join(root, "s2"));
  await writeFile(join(root, "s2", "task.md"), "новая задача");
  await run;

  expect(await sent(page)).toEqual(["новая задача"]);
});
