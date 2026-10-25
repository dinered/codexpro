import {ChatGptDriver} from '../src/driver/chatgpt.ts';
import type {Page} from 'playwright-core';
import type {PlatformProfile} from '../src/driver/selectors.ts';
import {TabBindings} from './tab-bindings.ts';
import {SubmissionGuard, type SubmissionSnapshot} from './submission.ts';

export class BoundDriver extends ChatGptDriver {
  private readonly bindings: TabBindings;
  private readonly key: string;
  private submission: SubmissionGuard | null = null;
  private stopping = false;
  private intendedText = '';
  private readonly now: () => number;
  private readonly composerSelector: string;
  constructor(page: Page, profile: PlatformProfile, bindings: TabBindings, key: string, now = Date.now) {
    super(page, profile);
    this.bindings = bindings;
    this.key = key;
    this.now = now;
    this.composerSelector = profile.selectors.composer;
  }
  private async check() { await this.bindings.captureConversation(this.key, this.page); await this.bindings.assertPage(this.key, this.page); }
  override async bind() { await this.check(); await super.bind(); }
  override async selftest() { await this.check(); await super.selftest(); }
  override async ensureReady(ms: number) { await this.check(); await super.ensureReady(ms); }
  override async chatBusy() { await this.check(); return super.chatBusy(); }
  override async typeText(text: string) { await this.check(); this.intendedText = ''; await super.typeText(text); }
  // R3 (ревью PR #10): порционный ввод (У-3) идёт через appendText — без этого
  // override запись порций обходила проверку привязки: после навигации во время
  // паузы следующая порция могла уйти в composer другой conversation. Проверка
  // выполняется до записи КАЖДОЙ порции (движок зовёт appendText на порцию).
  override async appendText(text: string) { await this.check(); await super.appendText(text); this.intendedText += text; }
  override async composerText() { await this.check(); return super.composerText(); }
  override async clearComposer() { await this.check(); await super.clearComposer(); this.intendedText = ''; }
  override async pressSend() {
    await this.check();
    this.submission = new SubmissionGuard(await super.readAnswer() as SubmissionSnapshot, this.intendedText, this.now());
    this.intendedText = '';
    this.stopping = false;
    await this.bindings.beforeSend(this.key, this.page);
    // Re-establish composer focus immediately before the single Enter. Never retry it.
    await this.page.locator(this.composerSelector).focus();
    await super.pressSend();
    await this.bindings.captureConversation(this.key, this.page);
  }
  override async readAnswer() {
    await this.check();
    const snapshot = await super.readAnswer();
    return this.submission && !this.stopping ? this.submission.answer(snapshot as SubmissionSnapshot, this.now()) : snapshot;
  }
  override async stopGeneration() { await this.check(); this.stopping = true; await super.stopGeneration(); }
  override async challenge() { await this.check(); return super.challenge(); }
}
