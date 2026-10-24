// Драйвер web ChatGPT (Playwright поверх CDP). Здесь — вся привязка к странице;
// движок хода и протокол о вёрстке не знают ничего. Селекторы приходят из
// selectors/chatgpt.yaml, смена вёрстки не требует пересборки (birdview §6).

import type { Page } from "playwright-core";
import type { AnswerSnapshot, Challenge } from "../core/types.ts";
import { driverFailure, type ChatDriver } from "./types.ts";
import type { PlatformProfile } from "./selectors.ts";

export class ChatGptDriver implements ChatDriver {
  readonly name = "chatgpt";
  readonly page: Page;
  private readonly profile: PlatformProfile;

  constructor(page: Page, profile: PlatformProfile) {
    this.page = page;
    this.profile = profile;
  }

  async bind(): Promise<void> {
    // переход внутри домена допустим — page переживает навигацию; проверяем лишь домен (Ф-7)
    if (!(await this.onDomain())) {
      throw driverFailure("platform", `вкладка вне домена ${this.profile.domain}: ${this.page.url()}`);
    }
  }

  async onDomain(): Promise<boolean> {
    return this.page.url().startsWith(this.profile.domain);
  }

  async ensureReady(timeoutMs: number): Promise<void> {
    const composer = this.page.locator(this.profile.selectors.composer);
    try {
      await composer.waitFor({ state: "visible", timeout: timeoutMs });
    } catch {
      throw driverFailure("composer-missing", `нет поля ввода за ${timeoutMs} мс — вход слетел или вёрстка изменилась`);
    }
  }

  async chatBusy(): Promise<boolean> {
    // генерация идёт или в поле чужой черновик (Н-4) — в чужой ход не вмешиваемся
    if (await this.stopVisible()) return true;
    const text = await this.composerText();
    return text.trim().length > 0;
  }

  async typeText(text: string): Promise<void> {
    // строки через Shift+Enter: голый Enter отправил бы сообщение раньше времени (Ф-4)
    await this.page.locator(this.profile.selectors.composer).focus();
    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (index) await this.page.keyboard.press("Shift+Enter");
      if (line) await this.page.keyboard.insertText(line);
    }
  }

  async composerText(): Promise<string> {
    return this.page
      .locator(this.profile.selectors.composer)
      .innerText()
      .catch(() => "");
  }

  async clearComposer(): Promise<void> {
    await this.page.locator(this.profile.selectors.composer).focus();
    await this.page.keyboard.press("ControlOrMeta+A");
    await this.page.keyboard.press("Backspace");
  }

  async pressSend(): Promise<void> {
    // Enter в поле: фокус уже там после typeText
    await this.page.keyboard.press("Enter");
  }

  async readAnswer(): Promise<AnswerSnapshot> {
    const snapshot = await this.page
      .evaluate(readPage, { sel: this.profile.selectors, domain: this.profile.domain })
      .catch((error) => {
        throw driverFailure("platform", `страница не отвечает: ${error instanceof Error ? error.message : error}`);
      });
    return snapshot;
  }

  async stopGeneration(): Promise<void> {
    const stop = this.page.locator(this.profile.selectors.stop_button).first();
    if (await stop.isVisible().catch(() => false)) {
      await stop.click({ force: true, timeout: 2_000 }).catch(() => {});
    }
  }

  async challenge(): Promise<Challenge | null> {
    if (!(await this.onDomain())) return null;
    const sel = this.profile.selectors.challenge;
    if (sel && (await this.page.locator(sel).first().isVisible().catch(() => false))) {
      return { kind: "captcha", detail: "платформа показывает проверку (капча/подтверждение)" };
    }
    return null;
  }

  async selftest(): Promise<void> {
    // birdview §1: самопроверка на старте. Структурные селекторы (turn/answer)
    // на пустом чате отсутствуют — их вёрстка проверится первым же ходом;
    // на старте отвечаем за composer и домен.
    if (!(await this.onDomain())) {
      throw driverFailure("platform", `самопроверка: вкладка вне домена ${this.profile.domain}`);
    }
    await this.ensureReady(10_000);
  }

  async close(): Promise<void> {
    // page принадлежит браузеру оператора (CDP) — только отвязываемся
  }

  private async stopVisible(): Promise<boolean> {
    return this.page
      .locator(this.profile.selectors.stop_button)
      .first()
      .isVisible()
      .catch(() => false);
  }
}

/** Выполняется в странице: снимок последнего хода (Ф-6). Только DOM, без внешних ссылок. */
function readPage(input: { sel: PlatformProfile["selectors"]; domain: string }): AnswerSnapshot {
  const { sel } = input;
  const turns = document.querySelectorAll(sel.turn);
  const last = turns.length ? turns[turns.length - 1]! : null;
  const html = last ? [...last.querySelectorAll(sel.answer)].map((el) => el.outerHTML).join("") : "";
  // признак генерации — только ВИДИМЫЙ индикатор: спрятанный, но присутствующий
  // в DOM «Стоп» не должен держать busy вечно до тайм-аута хода (Ф-6, birdview §3)
  const busy = visibleIn(sel.stop_button) || !!(sel.streaming && visibleIn(sel.streaming));
  const sendIdle = sel.send_button
    ? // холостое состояние — видимая и активная кнопка; спрятанная холостым не считается
      [...document.querySelectorAll(sel.send_button)].some(
        (button) => isVisible(button) && !(button as HTMLButtonElement).disabled,
      )
    : true;
  return { html, busy, sendIdle };
}

function visibleIn(selector: string): boolean {
  return [...document.querySelectorAll(selector)].some((el) => isVisible(el));
}

/** Видим ли элемент: без display:none/visibility:hidden, с непустой геометрией. */
function isVisible(el: Element): boolean {
  if ((el as HTMLElement).hidden === true || el.getAttribute("aria-hidden") === "true") return false;
  const style = document.defaultView?.getComputedStyle(el);
  if (style && (style.display === "none" || style.visibility === "hidden")) return false;
  return el.getClientRects().length > 0;
}
