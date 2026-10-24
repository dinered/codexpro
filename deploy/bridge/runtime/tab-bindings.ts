import {mkdir, readFile, readdir, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Browser, Page} from 'playwright-core';

type Binding = {v: 1; key: string; targetId: string; conversationUrl: string | null; hasSent: boolean};
export const validChatKey = (key: string) => /^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(key);

export class TabBindings {
  private writes: Promise<void> = Promise.resolve();
  private browser: Browser;
  private root: string;
  private startUrl: string;
  constructor(browser: Browser, root: string, startUrl: string) { this.browser = browser; this.root = root; this.startUrl = startUrl; }
  private file(key: string) {
    if (!validChatKey(key)) throw new Error('Invalid persistent chat key');
    return join(this.root, `${key}.json`);
  }
  private conversation(url: string): string | null {
    const parsed = new URL(url);
    if (parsed.origin !== new URL(this.startUrl).origin) return null;
    const match = parsed.pathname.match(/\/(?:c)\/([a-zA-Z0-9_-]+)\/?$/);
    return match ? `${parsed.origin}${parsed.pathname}` : null;
  }
  async read(key: string): Promise<Binding | null> {
    try {
      const binding = JSON.parse(await readFile(this.file(key), 'utf8'));
      if (binding.v !== 1 || binding.key !== key || typeof binding.targetId !== 'string'
        || typeof binding.hasSent !== 'boolean'
        || (binding.conversationUrl !== null && this.conversation(binding.conversationUrl) !== binding.conversationUrl)) {
        throw new Error('Invalid saved chat binding');
      }
      return binding;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  private async assertExclusive(binding: Binding) {
    const files = await readdir(this.root).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const key = file.slice(0, -5);
      if (key === binding.key || !validChatKey(key)) continue;
      const other = await this.read(key);
      if (other && (other.targetId === binding.targetId ||
        (binding.conversationUrl !== null && other.conversationUrl === binding.conversationUrl))) {
        throw new Error('Another Paseo chat already owns this tab or conversation');
      }
    }
  }
  private save(binding: Binding) {
    // The router holds the process-wide flock; serialize its in-process claim updates too.
    const write = this.writes.catch(() => {}).then(async () => {
      await mkdir(this.root, {recursive: true, mode: 0o700});
      await this.assertExclusive(binding);
      const file = this.file(binding.key), temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(binding), {mode: 0o600, flag: 'wx'});
      await rename(temporary, file);
    });
    this.writes = write;
    return write;
  }
  private async target(page: Page) {
    const session = await page.context().newCDPSession(page);
    try { return (await session.send('Target.getTargetInfo')).targetInfo.targetId; }
    finally { await session.detach(); }
  }
  async page(key: string): Promise<Page> {
    let binding = await this.read(key);
    const pages = this.browser.contexts().flatMap(context => context.pages());
    if (binding) {
      await this.assertExclusive(binding);
      for (const page of pages) {
        if (await this.target(page) === binding.targetId) {
          await this.assertPage(key, page);
          return page;
        }
      }
      if (binding.conversationUrl) {
        const matches = pages.filter(page => this.conversation(page.url()) === binding!.conversationUrl);
        if (matches.length > 1) throw new Error('Multiple tabs match this saved conversation; operator must resolve');
        if (matches.length === 1) {
          binding.targetId = await this.target(matches[0]!);
          await this.save(binding);
          return matches[0]!;
        }
      } else if (binding.hasSent) {
        throw new Error('Closed tab has an unresolved conversation URL; operator must restore it');
      }
    }
    const page = await this.browser.contexts()[0]!.newPage();
    try {
      await page.goto(binding?.conversationUrl ?? this.startUrl);
      binding = binding ?? {v: 1, key, targetId: '', conversationUrl: null, hasSent: false};
      binding.targetId = await this.target(page);
      await this.save(binding);
      await this.assertPage(key, page);
      return page;
    } catch (error) {
      // This newly created tab belongs to this attempt only; operator tabs remain untouched.
      await page.close().catch(() => {});
      throw error;
    }
  }
  async assertPage(key: string, page: Page) {
    const binding = await this.read(key);
    if (!binding || page.isClosed() || await this.target(page) !== binding.targetId) throw new Error('Chat tab identity changed');
    const url = new URL(page.url());
    if (url.origin !== new URL(this.startUrl).origin) throw new Error('Chat tab left the configured platform');
    if (binding.conversationUrl) {
      if (this.conversation(url.href) !== binding.conversationUrl) throw new Error('Chat tab navigated to a different conversation');
    } else if (url.pathname !== new URL(this.startUrl).pathname) {
      // The first URL can appear after captureConversation read the home URL.
      // Bind this same target from one URL snapshot only after persisted send intent.
      const conversationUrl = this.conversation(url.href);
      if (!binding.hasSent || !conversationUrl) throw new Error('Unbound tab changed before its first confirmed send');
      binding.conversationUrl = conversationUrl;
      await this.save(binding); // Includes the cross-chat exclusivity check.
    }
  }
  async beforeSend(key: string, page: Page) {
    await this.assertPage(key, page);
    const binding = (await this.read(key))!;
    binding.hasSent = true; // Persist intent before the click; never recover into an empty chat afterward.
    await this.save(binding);
  }
  async captureConversation(key: string, page: Page) {
    const binding = (await this.read(key))!;
    if (binding.conversationUrl) return this.assertPage(key, page);
    if (await this.target(page) !== binding.targetId) throw new Error('Chat tab identity changed after send');
    const url = this.conversation(page.url());
    if (!url) return;
    if (!binding.hasSent) throw new Error('Conversation changed without a bridge send');
    binding.conversationUrl = url;
    await this.save(binding);
  }
}
