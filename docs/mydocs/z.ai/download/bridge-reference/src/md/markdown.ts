// HTML ответа платформы → markdown (Ф-5). Конвертер работает в Node (linkedom),
// поэтому он юнит-тестируем без браузера и общий для всех драйверов: любой
// драйвер отдаёт HTML, конвертация одинаковая.

// Оговорённые потери (Ф-5; полный список — в README моста):
//  1. картинки не переносятся;
//  2. формулы остаются плоским текстом;
//  3. блоки внутри ячеек таблиц склеиваются в строку; вложенная таблица
//     спрямляется в ячейке внешней;
//  4. текст не экранируется: буквальные * _ # в тексте станут разметкой.

import { parseHTML } from "linkedom";

const BLOCK = /^(ASIDE|BLOCKQUOTE|DETAILS|DIV|FIGURE|H[1-6]|HR|OL|P|PRE|SECTION|TABLE|UL)$/;

export function htmlToMarkdown(html: string): string {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return blocksOf(document.body).join("\n\n");
}

/** Строчное содержимое узла: текст и инлайн-разметка. */
function inlineOf(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? ""; // TEXT_NODE
  if (node.nodeType !== 1) return ""; // комментарии и прочее — мимо
  const el = node as Element;
  if (el.tagName === "BUTTON") return ""; // служебные кнопки внутри ответов — не текст
  const inner = [...el.childNodes].map(inlineOf).join("");
  switch (el.tagName) {
    case "BR":
      return "\n";
    case "CODE": {
      const code = el.textContent ?? "";
      return code.includes("`") ? `\`\` ${code} \`\`` : `\`${code}\``;
    }
    case "A": {
      const href = el.getAttribute("href");
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
}

function wrap(mark: string, text: string): string {
  return text.trim() ? mark + text + mark : text;
}

/** Дети узла как блоки markdown: инлайн-подряд склеиваются в абзац. */
function blocksOf(parent: Node): string[] {
  const out: string[] = [];
  let run = "";
  const flush = (): void => {
    if (run.trim()) out.push(run.trim());
    run = "";
  };
  for (const node of parent.childNodes) {
    if (node.nodeType === 1 && BLOCK.test((node as Element).tagName)) {
      flush();
      const text = blockOf(node as Element);
      if (text) out.push(text);
    } else {
      run += inlineOf(node);
    }
  }
  flush();
  return out;
}

function blockOf(el: Element): string {
  const tag = el.tagName;
  const heading = /^H([1-6])$/.exec(tag)?.[1];
  if (heading) return `${"#".repeat(Number(heading))} ${inlineOf(el).trim()}`;
  if (tag === "HR") return "---";
  if (tag === "PRE") {
    // подпись языка и кнопки в шапке блока — мимо: берём только код
    const code = el.querySelector("code") ?? el;
    const text = (code.textContent ?? "").replace(/\n$/, "");
    const lang = /language-(\S+)/.exec(code.getAttribute("class") ?? "")?.[1] ?? "";
    const fence = "`".repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((run) => run.length + 1)));
    return `${fence}${lang}\n${text}\n${fence}`;
  }
  if (tag === "UL" || tag === "OL") {
    let number = tag === "OL" ? Number(el.getAttribute("start") ?? "1") || 1 : 1;
    return [...el.children]
      .filter((li) => li.tagName === "LI")
      .map((li) => {
        const marker = tag === "OL" ? `${number++}. ` : "- ";
        // абзацы пункта — через пустую строку; плотный пункт — построчно
        const hasParagraph = [...li.children].some((child) => child.tagName === "P");
        const sep = hasParagraph ? "\n\n" : "\n";
        // продолжение пункта — с отступом на ширину маркера (CommonMark)
        return marker + blocksOf(li).join(sep).replace(/\n(?!\n)/g, `\n${" ".repeat(marker.length)}`);
      })
      .join("\n");
  }
  if (tag === "BLOCKQUOTE") {
    return blocksOf(el)
      .join("\n\n")
      .replace(/^/gm, "> ");
  }
  if (tag === "TABLE") {
    // строки — только из прямых детей секций: querySelectorAll захватил бы
    // строки вложенных таблиц и спрямил их в внешнюю (см. оговорённые потери)
    const sections = [...el.children].filter((child) => /^(THEAD|TBODY|TFOOT)$/.test(child.tagName));
    const rows = (sections.length ? sections : [el]).flatMap((section) =>
      [...section.children].filter((row) => row.tagName === "TR"),
    );
    const cells = rows.map((tr) =>
      [...tr.children].map((cell) => inlineOf(cell).replace(/\s+/g, " ").trim().replace(/\|/g, "\\|")),
    );
    if (!cells.length) return "";
    const width = Math.max(...cells.map((row) => row.length));
    const line = (row: string[]): string => `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`;
    return [line(cells[0]!), line(Array.from({ length: width }, () => "---")), ...cells.slice(1).map(line)].join("\n");
  }
  return blocksOf(el).join("\n\n");
}

/**
 * Для сверки введённого текста с задачей (Ф-4). Правило фиксирует Д-7: эталон ввода —
 * plain text; сверка снимает экранирование и схлопывает пробельные пролёлы
 * (переводы строк, табуляции, nbsp — к одному пробелу), разметка и прочие символы
 * сохраняются: «2 * 3» и «> цитата» не теряют смысла, разные тексты не склеиваются.
 */
export function normalizeText(s: string): string {
  return s
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, "$1") // платформенное экранирование — снять
    .replace(/\s+/g, " ")
    .trim();
}
