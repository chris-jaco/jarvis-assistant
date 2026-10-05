import { randomUUID } from 'node:crypto';
import { mkdir, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import type { BrowserContext, ElementHandle, Page } from 'playwright';
import { TokenFileSecurity } from '../tools/adapters/token-security.js';
import { ToolError } from '../tools/types.js';
import { classifyElement, displayUrl, navigationUrl, privateText } from './policy.js';
import type { BrowserElement, BrowserKey, BrowserObservation, BrowserProvider, BrowserStatus, BrowserTab } from './provider.js';
export interface LocalBrowserOptions { enabled: boolean; channel: 'chrome' | 'msedge' | 'chromium'; root?: string }
export function browserOptions(env: NodeJS.ProcessEnv): LocalBrowserOptions {
  const enabled = env.BROWSER_ENABLED ?? 'false'; const channel = env.BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chrome');
  if (!['true', 'false'].includes(enabled) || !['chrome', 'msedge', 'chromium'].includes(channel)) throw new Error('Invalid BROWSER_ENABLED or BROWSER_CHANNEL');
  return { enabled: enabled === 'true', channel: channel as LocalBrowserOptions['channel'] };
}
interface Ref { handle: ElementHandle<HTMLElement>; page: Page; revision: number; info: BrowserElement; href?: string }
// The injected context factory is for deterministic tests only. Production always launches headed.
export class LocalBrowserProvider implements BrowserProvider {
  private context?: BrowserContext; private connecting?: Promise<BrowserContext>;
  private tabs = new Map<string, Page>(); private active?: string; private last = new Map<string, string>();
  private refs = new Map<string, Ref>(); private unavailable = false; private closed = false; private security = new TokenFileSecurity();
  constructor(private readonly options: LocalBrowserOptions, private readonly launch?: () => Promise<BrowserContext>) {}
  async status(): Promise<BrowserStatus> { return { available: this.options.enabled && !this.unavailable, connected: !!this.context, visible: true, ...(!this.options.enabled ? { reason: 'disabled' as const } : this.unavailable ? { reason: 'unavailable' as const } : {}) }; }
  private check(signal: AbortSignal) { if (signal.aborted) throw new ToolError('TIMEOUT'); }
  private async init(): Promise<BrowserContext> {
    if (!this.options.enabled || this.closed) throw new ToolError('UNCONFIGURED');
    if (this.context) return this.context;
    if (!this.connecting) this.connecting = (async () => {
      try {
        let context: BrowserContext;
        if (this.launch) context = await this.launch();
        else {
          const root = resolve(this.options.root ?? process.cwd());
          for (const path of [resolve(root, '.local'), resolve(root, '.local/browser-profile')]) {
            let created = false; try { await mkdir(path, { mode: 0o700 }); created = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
            await this.security.validate(path, await lstat(path), true, created);
          }
          context = await chromium.launchPersistentContext(resolve(root, '.local/browser-profile'), { headless: false, chromiumSandbox: true, channel: this.options.channel === 'chromium' ? undefined : this.options.channel, timeout: 12_000, acceptDownloads: false, serviceWorkers: 'block' });
        }
        context.setDefaultTimeout(4000); context.setDefaultNavigationTimeout(8000);
        // No consequential network methods, even if a page's search/click handler is deceptive.
        await context.route('**/*', route => {
          if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) return route.abort('blockedbyclient');
          if (route.request().isNavigationRequest()) { try { navigationUrl(route.request().url()); } catch { return route.abort('blockedbyclient'); } }
          return route.continue();
        });
        await context.routeWebSocket('**/*', socket => socket.close());
        // String is fixed source, never model input. Avoid transpiler helper references
        // inside serialized page functions, and keep the revision in a private closure.
        const observer = `(() => {
          if (Object.getOwnPropertyDescriptor(window, '__atlasRevision')) return;
          let revision = 0;
          Object.defineProperty(window, '__atlasRevision', { get() { return revision; }, configurable: false });
          new MutationObserver(() => { ++revision; }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        })()`;
        await context.addInitScript(observer);
        for (const page of context.pages()) await page.evaluate(observer);
        this.context = context; this.unavailable = false;
        context.on('page', page => this.track(page)); context.on('close', () => { this.context = undefined; this.tabs.clear(); this.active = undefined; void this.clearRefs(); });
        for (const page of context.pages()) this.track(page);
        return context;
      } catch { this.unavailable = true; throw new ToolError('UNCONFIGURED'); }
      finally { this.connecting = undefined; }
    })();
    return this.connecting;
  }
  private track(page: Page) {
    const id = randomUUID(); this.tabs.set(id, page); this.active ??= id;
    page.on('close', () => { this.tabs.delete(id); this.last.delete(id); if (this.active === id) this.active = this.tabs.keys().next().value; void this.clearRefs(); });
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) void this.clearRefs(); });
    page.on('dialog', dialog => { void dialog.dismiss(); });
    page.on('download', download => { void download.cancel(); });
  }
  private async clearRefs() { const refs = [...this.refs.values()]; this.refs.clear(); await Promise.all(refs.map(ref => ref.handle.dispose().catch(() => {}))); }
  private async page(signal: AbortSignal): Promise<Page> { this.check(signal); const context = await this.init(); this.check(signal); if (!this.active) await context.newPage(); const page = this.tabs.get(this.active!); if (!page || page.isClosed()) throw new ToolError('CONFLICT'); return page; }
  private async tab(id: string, page: Page): Promise<BrowserTab> { return { id, title: privateText(await page.title()), url: displayUrl(page.url()), active: id === this.active, ...(this.last.has(id) ? { lastInteraction: this.last.get(id) } : {}) }; }
  private touch() { if (this.active) this.last.set(this.active, new Date().toISOString()); }
  async ensureBrowser(signal: AbortSignal) { await this.page(signal); return this.status(); }
  async listTabs(signal: AbortSignal) { await this.page(signal); return Promise.all([...this.tabs].map(([id, page]) => this.tab(id, page))); }
  async getActiveTab(signal: AbortSignal) { const page = await this.page(signal); return this.tab(this.active!, page); }
  async switchTab(id: string, signal: AbortSignal) { await this.page(signal); const page = this.tabs.get(id); if (!page) throw new ToolError('CONFLICT'); await this.clearRefs(); this.active = id; await page.bringToFront(); this.touch(); return this.tab(id, page); }
  async closeTab(id: string, signal: AbortSignal) { await this.page(signal); const page = this.tabs.get(id); if (!page) throw new ToolError('CONFLICT'); await page.close(); }
  async openTab(url: string, signal: AbortSignal) { const target = navigationUrl(url); await this.page(signal); this.check(signal); const page = await this.context!.newPage(); this.active = [...this.tabs].find(([, value]) => value === page)![0]; return this.navigate(target, signal); }
  async navigate(url: string, signal: AbortSignal) { const target = navigationUrl(url); const page = await this.page(signal); await this.clearRefs(); this.check(signal); await page.goto(target, { waitUntil: 'domcontentloaded' }); this.touch(); return this.tab(this.active!, page); }
  async observe(signal: AbortSignal): Promise<BrowserObservation> {
    const page = await this.page(signal); await this.clearRefs();
    // Fixed trusted extractor; caller cannot provide JS or selectors. Values are never read.
    const handles = await page.locator('a[href],button,input,textarea,select,[role="button"],[role="searchbox"],[role="textbox"],video,audio').elementHandles();
    const revision = await this.revision(page); const elements: BrowserElement[] = []; let size = 0;
    for (const handle of handles.slice(0, 300)) {
      this.check(signal);
      const raw = await handle.evaluate(node => {
        const el = node as HTMLElement; const input = el as HTMLInputElement;
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || el.closest('[hidden],[aria-hidden="true"], [inert]') || ['password', 'hidden'].includes(input.type) || input.autocomplete?.match(/password|one-time-code|cc-/)) return null;
        const tag = el.tagName.toLowerCase(); const declaredRole = el.getAttribute('role') ?? ''; const role = (['link', 'button', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'slider', 'switch'].includes(declaredRole) ? declaredRole : undefined) ?? ({ a: 'link', input: input.type === 'search' ? 'searchbox' : 'textbox', textarea: 'textbox', button: 'button', select: 'combobox', video: 'media', audio: 'media' } as Record<string, string>)[tag] ?? 'button';
        const labelled = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ');
        const name = el.getAttribute('aria-label') || labelled.trim() || Array.from(input.labels ?? []).map(label => label.textContent).join(' ') || el.getAttribute('placeholder') || (['input', 'textarea', 'select'].includes(tag) || ['textbox', 'searchbox'].includes(role) || el.isContentEditable ? '' : el.textContent) || el.getAttribute('title') || tag;
        return { tag, role, name: name.slice(0, 500), type: input.type ?? '', disabled: !!input.disabled || el.getAttribute('aria-disabled') === 'true', href: tag === 'a' ? (el as HTMLAnchorElement).href : undefined,
          state: { ...(['video', 'audio'].includes(tag) ? { paused: (el as HTMLMediaElement).paused } : {}), ...(['checkbox', 'radio'].includes(input.type) ? { checked: input.checked } : {}), ...(el.hasAttribute('aria-expanded') ? { expanded: el.getAttribute('aria-expanded') === 'true' } : {}) },
          search: input.type === 'search' || role === 'searchbox' || !!el.closest('[role="search"]') || /^(search|buscar|búsqueda|rechercher|suche)(\b|$)/i.test(name.trim()) };
      });
      if (!raw) { await handle.dispose(); continue; }
      const name = privateText(raw.name); if (name === '[redacted]') { await handle.dispose(); continue; }
      const info: BrowserElement = { ref: randomUUID(), role: raw.role.slice(0, 30), name, type: raw.type.slice(0, 20), disabled: raw.disabled, state: raw.state, action: classifyElement(raw) };
      size += JSON.stringify(info).length; if (elements.length >= 40 || size > 10_000) { await handle.dispose(); break; }
      elements.push(info); this.refs.set(info.ref, { handle: handle as ElementHandle<HTMLElement>, page, revision, info, href: raw.href });
    }
    for (const handle of handles) if (![...this.refs.values()].some(ref => ref.handle === handle)) await handle.dispose().catch(() => {});
    if (revision !== await this.revision(page)) { await this.clearRefs(); throw new ToolError('CONFLICT'); }
    return { tabId: this.active!, url: displayUrl(page.url()), title: privateText(await page.title()), elements, truncated: handles.length > elements.length };
  }
  private async revision(page: Page) { const revision = await page.evaluate(() => (window as unknown as { __atlasRevision?: number }).__atlasRevision); if (typeof revision !== 'number' || revision < 0) throw new ToolError('CONFLICT'); return revision; }
  private async ref(id: string, signal: AbortSignal) {
    const page = await this.page(signal); const ref = this.refs.get(id);
    if (!ref || ref.page !== page || ref.revision !== await this.revision(page) || !await ref.handle.evaluate(el => el.isConnected)) throw new ToolError('CONFLICT');
    if (ref.info.action === 'blocked') throw new ToolError('REJECTED'); return ref;
  }
  async click(id: string, signal: AbortSignal) {
    const ref = await this.ref(id, signal); this.check(signal);
    if (ref.info.action === 'navigation') { await this.navigate(ref.href!, signal); return; } // Direct GET, never run arbitrary onclick.
    if (ref.info.action === 'media') await ref.handle.evaluate(async el => { const media = el as HTMLMediaElement; if (media.paused) await media.play(); else media.pause(); });
    else if (ref.info.role === 'button') await ref.handle.click(); else if (['textbox', 'searchbox'].includes(ref.info.role)) await ref.handle.focus(); else throw new ToolError('REJECTED');
    this.touch(); await this.clearRefs();
  }
  async type(id: string, text: string, mode: 'replace' | 'append', signal: AbortSignal) {
    const ref = await this.ref(id, signal); if (ref.info.action !== 'search' || !['textbox', 'searchbox'].includes(ref.info.role)) throw new ToolError('REJECTED');
    if (privateText(text, 2000) === '[redacted]') throw new ToolError('REJECTED');
    this.check(signal); if (mode === 'replace') await ref.handle.fill(text); else { await ref.handle.focus(); await ref.handle.press('ControlOrMeta+End'); await ref.page.keyboard.insertText(text); } this.touch(); await this.clearRefs();
  }
  async press(id: string, key: BrowserKey, signal: AbortSignal) {
    const ref = await this.ref(id, signal);
    if (!['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(key)) throw new ToolError('INVALID_INPUT');
    if (ref.info.action === 'media') { if (!['Space', 'Enter'].includes(key)) throw new ToolError('REJECTED'); await this.click(id, signal); return; }
    if (ref.info.action !== 'search' || !['textbox', 'searchbox'].includes(ref.info.role)) throw new ToolError('REJECTED');
    this.check(signal); await ref.handle.press(key); this.touch(); await this.clearRefs();
  }
  async scroll(direction: 'up' | 'down', signal: AbortSignal) { const page = await this.page(signal); await page.mouse.wheel(0, direction === 'down' ? 600 : -600); this.touch(); await this.clearRefs(); }
  async back(signal: AbortSignal) { const page = await this.page(signal); await this.clearRefs(); this.check(signal); await page.goBack({ waitUntil: 'domcontentloaded' }); this.touch(); return this.tab(this.active!, page); }
  async forward(signal: AbortSignal) { const page = await this.page(signal); await this.clearRefs(); this.check(signal); await page.goForward({ waitUntil: 'domcontentloaded' }); this.touch(); return this.tab(this.active!, page); }
  async reload(signal: AbortSignal) { const page = await this.page(signal); await this.clearRefs(); this.check(signal); await page.reload({ waitUntil: 'domcontentloaded' }); this.touch(); return this.tab(this.active!, page); }
  async close() { this.closed = true; try { await this.connecting; } catch { /* No raw launch error is exposed. */ } await this.clearRefs(); await this.context?.close(); }
}
