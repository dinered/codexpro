import {ChatGptDriver} from '../src/driver/chatgpt.ts';
import type {Page} from 'playwright-core';
import type {PlatformProfile} from '../src/driver/selectors.ts';
import {TabBindings} from './tab-bindings.ts';

export class BoundDriver extends ChatGptDriver {
  private bindings: TabBindings;
  private key: string;
  constructor(page: Page, profile: PlatformProfile, bindings: TabBindings, key: string) { super(page, profile); this.bindings = bindings; this.key = key; }
  private async check() { await this.bindings.captureConversation(this.key, this.page); await this.bindings.assertPage(this.key, this.page); }
  override async bind() { await this.check(); await super.bind(); }
  override async selftest() { await this.check(); await super.selftest(); }
  override async ensureReady(ms: number) { await this.check(); await super.ensureReady(ms); }
  override async chatBusy() { await this.check(); return super.chatBusy(); }
  override async typeText(text: string) { await this.check(); await super.typeText(text); }
  // R3 (ревью PR #10): порционный ввод (У-3) идёт через appendText — без этого
  // override запись порций обходила проверку привязки: после навигации во время
  // паузы следующая порция могла уйти в composer другой conversation. Проверка
  // выполняется до записи КАЖДОЙ порции (движок зовёт appendText на порцию).
  override async appendText(text: string) { await this.check(); await super.appendText(text); }
  override async composerText() { await this.check(); return super.composerText(); }
  override async clearComposer() { await this.check(); await super.clearComposer(); }
  override async pressSend() {
    await this.bindings.beforeSend(this.key, this.page);
    await super.pressSend();
    await this.bindings.captureConversation(this.key, this.page);
  }
  override async readAnswer() { await this.check(); return super.readAnswer(); }
  override async stopGeneration() { await this.check(); await super.stopGeneration(); }
  override async challenge() { await this.check(); return super.challenge(); }
}
