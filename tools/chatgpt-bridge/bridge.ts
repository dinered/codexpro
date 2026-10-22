// Мост Paseo → ChatGPT (учебный, ai/codexpro#2 п. 6), протокол v2 — tools/paseo-plugin/server/protocol.ts.
// Плагин codexpro-worker кладёт задачу в <root>/<сессия>/task-<id>.md и пульсирует её, пока ход идёт.
// Мост захватывает задачу (claim-<id>), вводит текст в открытый чат ChatGPT, ждёт конца ответа и пишет
// ответ в markdown в reply-<id>.md; не вышло — причину в error-<id>.md.
// Учебный мост: каждое ограничение работы с ChatGPT помечено меткой предохранителя (AGENTS.md); список — README моста.
// #учебно-не-боевое-01 — канал к модели — веб-интерфейс ChatGPT через CDP; в бою мост заменяют вызовом API модели
// из провайдера Paseo, а не укрепляют (docs/training-vs-production.md — там разбор всех таких меток).
import type { Page } from "playwright-core";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  acquire,
  BRIDGE_LOCK,
  fileName,
  isFresh,
  type Kind,
  LEASE_MS,
  ownerToken,
  owns,
  parseName,
  pulse,
  readRegular,
  release,
  writeAtomic,
} from "../paseo-plugin/server/protocol.ts";

// Разметка ChatGPT на 2026-10-06, интерфейс на русском (кнопки ищутся по подписи).
// Поменяется — править здесь и в имитации tests/e2e/fake-chatgpt.html.
// #учебно-не-боевое-02 — контракт с ChatGPT — снятая со страницы разметка и подписи кнопок; в бою — версионированный API.
export const SEL = {
  composer: '[data-composer-input] [contenteditable="true"]',
  turn: "[data-turn-key]", // пара «сообщение — ответ»; ключ стабилен, старые пары длинного чата выгружаются
  userBubble: "[data-user-message-bubble]",
  answer: '[data-markdown-text-style="assistant-message"]:not([data-markdown-text-tone="tertiary"])', // tertiary — «Думаю…»
  streaming: "[data-markdown-animated]", // блок ещё печатается
  stop: 'button[aria-label="Остановить"]', // видна, пока идёт ответ
  done: 'button[aria-label="Сгенерировать ответ заново"]', // появляется в паре, когда ответ готов
};

// #внимание-учебно-аналитический-предохранитель — только существующий чат: новых чатов мост не открывает (новый сменил бы адрес
// после первого сообщения, а мост привязан к адресу).
export const CHAT_URL = /^https:\/\/chatgpt\.com\/c\/[\w-]+/;

// #внимание-учебно-аналитический-предохранитель — лимит сообщений за запуск (Issue #2 п. 6: не больше 500) и пауза: не чаще одного
// сообщения в PAUSE_MS, в том числе после запуска. Лимит ядро проверяет при любом вызове; паузу ядро выдерживает
// само, параметр pauseMs меньше PAUSE_MS — только для тестов.
// #учебно-не-боевое-05 — лимит и пауза — константы одного запуска, без учёта токенов и денег, перезапуск обнуляет счётчик;
// в бою — лимиты частоты и бюджет в общем лимитёре для всех экземпляров.
export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = 20;
export const PAUSE_MS = 20_000;

export class FatalError extends Error {} // остановить мост целиком
export class TaskError extends Error {} // задача не выполнена (error-<id>.md), мост работает дальше; только до Enter

export interface BridgeOptions {
  page: Page;
  root: string; // каталог .ai-bridge/paseo
  limit?: number; // сообщений за запуск, 1..MAX_LIMIT
  // #учебно-не-боевое-22 — параметры только для тестов (pauseMs меньше PAUSE_MS, acceptQueued, сроки startTimeoutMs и
  // answerTimeoutMs, leaseMs, pollMs, retries) открыты в рабочем интерфейсе ядра, границы проверяются только у limit;
  // в бою тесты подставляют часы и источник задач, а не параметры
  pauseMs?: number; // наименьший промежуток между отправками; меньше PAUSE_MS — только для тестов
  pollMs?: number;
  startTimeoutMs?: number; // ChatGPT не принял сообщение или не начал отвечать
  answerTimeoutMs?: number; // от начала ответа
  leaseMs?: number;
  retries?: number; // повторы ввода текста — только до Enter
  log?: (line: string) => void;
  signal?: AbortSignal; // остановка оператором (Ctrl+C)
  acceptQueued?: boolean; // взять задачи, ждавшие до запуска моста, — только для тестов
}

interface Task {
  session: string;
  id: string;
  dir: string;
  born: number; // создание файла задачи — по нему очередь (mtime двигает пульс плагина)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fileOf = (task: Task, kind: Kind) => join(task.dir, fileName(kind, task.id));

// Для сравнений текста: поле ввода и пузырь сообщения показывают разметку отрисованной (`код` — без кавычек).
export function normalize(s: string): string {
  return s.replace(/[\s*_~`#>]/g, "");
}

export async function runBridge({
  page,
  root,
  limit = DEFAULT_LIMIT,
  pauseMs = PAUSE_MS,
  pollMs = 1000,
  startTimeoutMs = 120_000,
  answerTimeoutMs = 600_000,
  leaseMs = LEASE_MS,
  retries = 2,
  log = console.log,
  signal,
  acceptQueued = false,
}: BridgeOptions): Promise<{ sent: number }> {
  // #внимание-учебно-аналитический-предохранитель — лимит в пределах 1..MAX_LIMIT при любом вызове ядра
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new FatalError(`лимит сообщений за запуск — целое от 1 до ${MAX_LIMIT}, задано: ${limit}`);
  }
  // #внимание-учебно-аналитический-предохранитель — каталог задач не ссылка: в режиме codexpro ChatGPT сам пишет в рабочую папку
  if (!(await lstat(root).catch(() => null))?.isDirectory()) throw new FatalError(`нет каталога задач (или это ссылка): ${root}`);
  const token = ownerToken();
  const lock = join(root, BRIDGE_LOCK);
  // #внимание-учебно-аналитический-предохранитель — один мост на каталог задач: второй не стартует
  if (!(await acquire(lock, token, leaseMs))) {
    throw new FatalError(`другой мост уже работает — или прошлый упал меньше ${leaseMs / 1000} с назад: подождите и запустите снова`);
  }

  const url = page.url();
  const composer = page.locator(SEL.composer);
  const stop = page.locator(SEL.stop).visible().first();
  // #внимание-учебно-аналитический-предохранитель — отправленное второй раз не уходит, что бы ни стало с файлами
  // #учебно-не-боевое-06 — «не больше одного раза» держится на памяти процесса, после падения чат сверяет человек;
  // в бою вызов API без состояния можно повторить, а дубликаты отсекает ключ задачи в очереди
  const sentIds = new Set<string>();
  const queuedAtStart = new Set<string>(); // ходы, ждавшие до запуска моста: в ChatGPT не уходят никогда
  let sent = 0;
  let sentAt = Date.now(); // последняя отправка — для паузы; запуск считается отправкой: перезапуск паузу не обходит

  // #внимание-учебно-аналитический-предохранитель — каждый опрос и прямо перед Enter: замок наш и жив, вкладка в том же чате.
  async function beat() {
    await pulse(lock).catch(() => {});
    if (!(await owns(lock, token))) throw new FatalError("замок моста потерян — запущен другой мост?");
    if (page.url() !== url) throw new FatalError("вкладка ChatGPT ушла из чата, к которому привязан мост");
  }

  // Задача ещё нужна и захват наш (заодно продлить его). До Enter задача нужна, пока плагин её пульсирует;
  // после Enter — пока файл задачи на месте: пульс мог пропасть на время сна Мака, а сообщение уже ушло,
  // и брошенный без reply/error ход висел бы в Paseo. «Стоп» в Paseo удаляет файл задачи.
  // #внимание-учебно-аналитический-предохранитель — задача без пульса плагина (остаток мёртвого хода) не уходит.
  async function wanted(task: Task, entered = false) {
    const claim = fileOf(task, "claim");
    const file = fileOf(task, "task");
    const alive = entered ? !!(await lstat(file).catch(() => null))?.isFile() : await isFresh(file, leaseMs);
    if (!alive || !(await owns(claim, token))) return false;
    await pulse(claim).catch(() => {});
    return true;
  }

  // Живые задачи без ответа (плагин их пульсирует), старые первыми; при live = false — все задачи, даже с ответом.
  // #внимание-учебно-аналитический-предохранитель — ссылки (на папки и файлы) пропускаются: их мог подложить ChatGPT.
  // #учебно-не-боевое-13 — кто создал task-файл, не проверяется: задачу, подложенную после снимка очереди при запуске,
  // мост отправит в ChatGPT от имени оператора; в бою канал управления вне досягаемости модели.
  // #учебно-не-боевое-26 — задачи всех сессий уходят в один чат: контекст модели общий, а не история сессии Paseo;
  // в бою провайдер передаёт историю своей сессии в каждом запросе.
  async function pending(live = true) {
    const tasks: Task[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      const names = await readdir(dir).catch(() => [] as string[]);
      for (const name of names) {
        const parsed = parseName(name);
        if (parsed?.kind !== "task" || sentIds.has(parsed.id)) continue;
        const answered = names.includes(fileName("reply", parsed.id)) || names.includes(fileName("error", parsed.id));
        if (live && answered) continue;
        const info = await lstat(join(dir, name)).catch(() => null);
        if (info?.isFile() && (!live || (await isFresh(join(dir, name), leaseMs)))) {
          tasks.push({ session: entry.name, id: parsed.id, dir, born: info.birthtimeMs || info.mtimeMs });
        }
      }
    }
    return tasks.sort((a, b) => a.born - b.born);
  }

  // Одна захваченная задача: ответ, отмена или ошибка — в файл; захват снимается всегда.
  async function handle(task: Task) {
    const name = `${task.session}/${task.id}`;
    try {
      const text = await readRegular(fileOf(task, "task"));
      if (text === null) return; // задачу уже убрали
      if (!text.trim()) throw new TaskError("пустая задача");
      const answer = await ask(task, text);
      if (answer !== null) {
        if (!(await wanted(task, true))) return log(`${name}: ход отменён, ответ не отдан`);
        await writeAtomic(fileOf(task, "reply"), answer);
        return log(`${name}: ответ отдан`);
      }
      if (!signal?.aborted) return log(`${name}: ход отменён, ответ ChatGPT остановлен`);
      await writeAtomic(fileOf(task, "error"), "мост остановлен оператором");
      log(`${name}: мост остановлен оператором`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeAtomic(fileOf(task, "error"), message).catch(() => {});
      log(`${name}: ${message}`);
      if (!(error instanceof TaskError)) throw error;
    } finally {
      await release(fileOf(task, "claim"), token);
    }
  }

  // Вводит текст в чат и ждёт конца ответа. Ответ в markdown; null — задача больше не нужна.
  // ponytail: опрос раз в pollMs, без MutationObserver — конец ответа виден с задержкой до 2×pollMs
  // #учебно-не-боевое-10 — опрос страницы; в бою — поток ответа API
  // #учебно-не-боевое-27 — модель и параметры — что выбрано в чате; мост их не задаёт и не записывает. В бою версия
  // модели и параметры — в запросе, модель из ответа — в журнале хода.
  async function ask(task: Task, text: string): Promise<string | null> {
    // #внимание-учебно-аналитический-предохранитель — нет поля ввода (вход слетел, другая страница): стоп
    if (!(await composer.isVisible())) throw new FatalError("нет поля ввода ChatGPT — вход слетел?");
    // #внимание-учебно-аналитический-предохранитель — чат занят (идёт ответ или черновик в поле ввода): в чужой ход мост не вмешивается
    if ((await stop.isVisible()) || (await composer.innerText()).trim()) {
      throw new FatalError("чат ChatGPT занят: идёт ответ или в поле ввода есть текст — мост его не трогает");
    }
    const before = new Set(await turnKeys());

    // строки через Shift+Enter (голый Enter отправил бы раньше времени); ввелось не то — стереть и ещё раз
    for (let attempt = 0; ; attempt++) {
      await composer.focus(); // не click(): в фоновой вкладке он ждёт отрисовки и может зависнуть
      for (const [i, line] of text.split(/\r?\n/).entries()) {
        if (i) await page.keyboard.press("Shift+Enter");
        if (line) await page.keyboard.insertText(line);
      }
      if (normalize(await composer.innerText()) === normalize(text)) break;
      await clear();
      if (attempt >= retries) throw new TaskError("текст задачи не вводится в поле ChatGPT как есть");
    }
    if (signal?.aborted || !(await wanted(task))) {
      await clear();
      return null;
    }

    // прямо перед Enter: вкладка всё ещё в том чате и замок наш; нет — введённый текст задачи не оставлять в поле
    await beat().catch(async (error) => {
      if (normalize(await composer.innerText().catch(() => "")) === normalize(text)) await clear();
      throw error;
    });
    await page.keyboard.press("Enter");
    sent++;
    sentAt = Date.now();
    sentIds.add(task.id);
    log(`${task.session}/${task.id}: отправлено в ChatGPT (${sent}/${limit})`);
    // #внимание-учебно-аналитический-предохранитель — после Enter повторов нет: повтор отправил бы сообщение дважды. И мост встаёт, если
    // ChatGPT не принял сообщение, не начал или не закончил ответ либо закончил ход без текста: так он показывает и лимит, и
    // ошибку — слать дальше нельзя. Ошибку после части текста мост не отличает от конца ответа (README, «Известные ограничения»).
    // #учебно-не-боевое-04 — сбой виден только по отсутствию признаков на странице, ответ на него — стоп и человек; в бою —
    // коды ошибок API, повторы с растущей паузой и предохранитель цепи
    const enteredAt = sentAt;
    let key = ""; // наша пара
    let acceptedAt = 0;
    let startedAt = 0;
    let last: string | undefined;
    for (;;) {
      await sleep(pollMs);
      await beat();
      // #внимание-учебно-аналитический-предохранитель — «Стоп» в Paseo или остановка моста оператором: «Остановить» в ChatGPT
      if (signal?.aborted || !(await wanted(task, true))) {
        await stopAndWaitIdle();
        return null;
      }
      const now = Date.now();
      if (!key) {
        const fresh = (await turnKeys()).filter((k) => !before.has(k)); // не по числу пар: старые выгружаются
        // #внимание-учебно-аналитический-предохранитель — в чате только сообщения моста: чужое или не тот текст — стоп
        if (fresh.length > 1) throw new FatalError("в чат ChatGPT пишет кто-то ещё");
        const bubble = fresh.length ? (await readTurnOf(fresh[0])).bubble : "";
        if (!bubble.trim()) {
          if (now - enteredAt < startTimeoutMs) continue;
          // #внимание-учебно-аналитический-предохранитель — ChatGPT не принял сообщение (лимит, капча, вход): мост останавливается, обходить не пытается
          throw new FatalError(`ChatGPT не принял сообщение за ${startTimeoutMs / 1000} с: лимит, капча или вход слетел?`);
        }
        if (normalize(bubble) !== normalize(text)) throw new FatalError("в чате ChatGPT ушёл не тот текст, что вводил мост");
        key = fresh[0];
        acceptedAt = now;
      }
      const turn = await readTurnOf(key);
      const busy = await stop.isVisible();
      if (!startedAt && (busy || turn.markdown)) startedAt = now;
      // #внимание-учебно-аналитический-предохранитель — сроки: не начал отвечать или не закончил — «Остановить», ошибка хода и стоп моста
      if (!startedAt && now - acceptedAt > startTimeoutMs) {
        await stopAndWaitIdle();
        throw new FatalError(`ChatGPT не начал отвечать за ${startTimeoutMs / 1000} с — лимит или ошибка? Проверьте чат`);
      }
      // конец: «Остановить» нет, «Сгенерировать заново» есть, ничего не печатается и текст не менялся с прошлого опроса
      if (startedAt && !busy && turn.done && !turn.streaming && turn.markdown === last) {
        // пустой reply плагин не примет — ход завис бы; а пустой «готовый» ответ — так ChatGPT показывает ошибку
        if (!turn.markdown) throw new FatalError("в ответе ChatGPT нет текста — ошибка или лимит? Проверьте чат");
        return turn.markdown;
      }
      if (startedAt && now - startedAt > answerTimeoutMs) {
        await stopAndWaitIdle();
        throw new FatalError(`ChatGPT не закончил ответ за ${answerTimeoutMs / 1000} с — проверьте чат`);
      }
      last = turn.markdown;
    }
  }

  // Остановить ответ ChatGPT и дождаться, пока чат освободится.
  async function stopAndWaitIdle() {
    if (await stop.isVisible()) await stop.click({ force: true, timeout: 2000 }).catch(() => {});
    const end = Date.now() + 30_000;
    while (await stop.isVisible()) {
      if (Date.now() > end) throw new FatalError("ChatGPT не остановил ответ за 30 с");
      await pulse(lock).catch(() => {}); // ожидание может пережить срок замка
      await sleep(pollMs);
    }
  }

  async function clear() {
    await composer.focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
  }

  const turnKeys = () => page.locator(SEL.turn).evaluateAll((els) => els.map((el) => el.getAttribute("data-turn-key") ?? ""));
  const readTurnOf = (key: string) => page.locator(`[data-turn-key=${JSON.stringify(key)}]`).evaluateAll(readTurn, SEL);

  try {
    if (!CHAT_URL.test(url)) throw new FatalError("вкладка ChatGPT должна быть открыта в существующем чате (https://chatgpt.com/c/…)");
    if (!acceptQueued) {
      // #внимание-учебно-аналитический-предохранитель — очередь при запуске пуста: в ChatGPT уходит только то, что оператор отправил при
      // работающем мосте, а не забытый ход из прошлого (проверка Paseo через CLI, упавший тест или мост). Сначала снимок всех ходов,
      // даже без пульса (плагин стоял) или с ответом: такой оживёт позже — в ChatGPT не уйдёт. Ход, пришедший после снимка, — новый.
      for (const task of await pending(false)) queuedAtStart.add(task.id);
      const live = (await pending()).filter((task) => queuedAtStart.has(task.id));
      if (live.length) {
        const names = live.map((task) => `${task.session}/${task.id}`).join(", ");
        const claimed = await Promise.all(live.map((task) => lstat(fileOf(task, "claim")).then(() => true, () => false)));
        // захват остался от упавшего моста: сообщение могло уже уйти, и отправить его из Paseo снова — второе сообщение
        const warning = claimed.includes(true) ? "; мост упал во время хода — сообщение могло уже уйти в ChatGPT: проверьте чат" : "";
        throw new FatalError(`в очереди уже есть задачи (${names}): отмените их в Paseo («Стоп») и запустите мост заново${warning}`);
      }
    }
    // #модельный-учебно-аналитический-контроль — действующие лимит и пауза в журнале: их сверяет чек-лист живого прогона.
    // Строка — после проверок: с неё оператор отправляет сообщения.
    // #учебно-не-боевое-21 — рамки прогона сверяют люди по журналу и чек-листу; в бою правила применяет сама система.
    log(`мост запущен: ${root} → чат ${new URL(url).pathname}, не больше ${limit} сообщений за запуск, пауза ${pauseMs / 1000} с; остановить — Ctrl+C`);
    while (sent < limit && !signal?.aborted) {
      await beat();
      // #внимание-учебно-аналитический-предохранитель — пауза ждётся до захвата задачи: захват за время паузы не протухнет
      const tasks = Date.now() - sentAt >= pauseMs ? await pending() : [];
      for (const task of tasks) {
        const claim = await acquire(fileOf(task, "claim"), token, leaseMs);
        if (!claim) continue; // её ведёт другой исполнитель
        // #внимание-учебно-аналитический-предохранитель — не отправляются задача упавшего моста (он мог успеть её отправить: повтор —
        // второе сообщение в ChatGPT) и ход, ждавший до запуска моста
        const refusal =
          claim === "taken-over"
            ? "мост упал во время задачи, сообщение могло уйти в ChatGPT — проверьте чат"
            : queuedAtStart.has(task.id)
              ? "ход ждал до запуска моста, мост его не отправляет — отправьте сообщение заново"
              : null;
        if (refusal) {
          await writeAtomic(fileOf(task, "error"), refusal);
          await release(fileOf(task, "claim"), token);
          log(`${task.session}/${task.id}: ${refusal}`);
          continue;
        }
        await handle(task);
        break; // после ответа очередь читается заново
      }
      // #учебно-не-боевое-10 — опрос папки задач; в бою — подписка на очередь
      await sleep(pollMs);
    }
    if (sent >= limit) log(`лимит ${limit} сообщений за запуск — мост остановлен`);
    return { sent };
  } finally {
    await release(lock, token);
    // #модельный-учебно-аналитический-контроль — итог при любом исходе после захвата замка, в том числе при FatalError:
    // по нему Claude сверяет прогон (tools/chatgpt-bridge/README.md, «Живой прогон»)
    log(`отправлено сообщений за запуск: ${sent} из ${limit}`);
  }
}

// Пара по ключу: текст пузыря сообщения, ответ в markdown и признаки конца ответа. Пары нет на странице
// (выгружена при прокрутке) — пусто, опрос подождёт. Выполняется в странице: Playwright передаёт исходник
// функции, поэтому только DOM и все помощники внутри.
// ponytail: markdown — только разметка из списка ниже; картинки пропадают, формулы — плоским текстом, блоки в ячейках
// склеиваются в строку, текст не экранируется (буквальные * _ # станут разметкой)
// #учебно-не-боевое-03 — ответ восстанавливается из отрисованной разметки с потерями; в бою API отдаёт текст как есть
function readTurn(turns: Element[], sel: typeof SEL) {
  const turn = turns[0];
  if (!turn) return { bubble: "", markdown: "", done: false, streaming: false };
  const BLOCK = /^(BLOCKQUOTE|DIV|H[1-6]|HR|OL|P|PRE|SECTION|TABLE|UL)$/;
  const wrap = (mark: string, s: string) => (s.trim() ? mark + s + mark : s);

  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof HTMLElement) || node.tagName === "BUTTON") return "";
    const inner = [...node.childNodes].map(inline).join("");
    switch (node.tagName) {
      case "BR":
        return "\n";
      case "CODE": {
        const code = node.textContent ?? "";
        return code.includes("`") ? `\`\` ${code} \`\`` : `\`${code}\``;
      }
      case "A": {
        const href = node.getAttribute("href");
        return href ? `[${inner}](${href})` : inner;
      }
      case "STRONG":
      case "B":
        return wrap("**", inner);
      case "EM":
      case "I":
        return wrap("_", inner);
      default:
        return inner;
    }
  };

  // Дети узла — блоки markdown: строчное подряд склеивается в абзац.
  const blocks = (parent: Node): string[] => {
    const out: string[] = [];
    let run = "";
    const flush = () => {
      if (run.trim()) out.push(run.trim());
      run = "";
    };
    for (const node of parent.childNodes) {
      if (node instanceof HTMLElement && BLOCK.test(node.tagName)) {
        flush();
        const text = block(node);
        if (text) out.push(text);
      } else run += inline(node);
    }
    flush();
    return out;
  };

  const block = (el: HTMLElement): string => {
    const tag = el.tagName;
    const level = /^H([1-6])$/.exec(tag)?.[1];
    if (level) return `${"#".repeat(+level)} ${inline(el).trim()}`;
    if (tag === "HR") return "---";
    if (tag === "PRE") {
      // только текст code: подпись языка и кнопки в шапке блока — мимо
      const code = el.querySelector("code") ?? el;
      const text = code.innerText.replace(/\n$/, "");
      const lang = /language-(\S+)/.exec(code.className)?.[1] ?? "";
      const fence = "`".repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((run) => run.length + 1)));
      return `${fence}${lang}\n${text}\n${fence}`;
    }
    if (tag === "UL" || tag === "OL") {
      let n = tag === "OL" ? (el as HTMLOListElement).start : 1;
      return [...el.children]
        .filter((li) => li.tagName === "LI")
        .map((li) => {
          const marker = tag === "OL" ? `${n++}. ` : "- ";
          // абзацы пункта (<p> внутри <li>) — через пустую строку, иначе они слились бы в один; плотный пункт — построчно
          const sep = li.querySelector(":scope > p") ? "\n\n" : "\n";
          // продолжение пункта — с отступом на ширину маркера (CommonMark): «- » — 2, «9. » — 3, «10. » — 4
          return marker + blocks(li).join(sep).replace(/\n(?!\n)/g, "\n" + " ".repeat(marker.length));
        })
        .join("\n");
    }
    if (tag === "BLOCKQUOTE") return blocks(el).join("\n\n").replace(/^/gm, "> ");
    if (tag === "TABLE") {
      const rows = [...el.querySelectorAll("tr")].map((tr) =>
        [...tr.children].map((cell) => inline(cell).replace(/\s+/g, " ").trim().replace(/\|/g, "\\|")),
      );
      if (!rows.length) return "";
      const width = Math.max(...rows.map((row) => row.length));
      const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
      return [line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n");
    }
    return blocks(el).join("\n\n");
  };

  return {
    bubble: [...turn.querySelectorAll<HTMLElement>(sel.userBubble)].map((el) => el.innerText).join("\n"),
    markdown: [...turn.querySelectorAll<HTMLElement>(sel.answer)].flatMap((el) => blocks(el)).join("\n\n"),
    done: !!turn.querySelector(sel.done),
    streaming: !!turn.querySelector(sel.streaming),
  };
}
