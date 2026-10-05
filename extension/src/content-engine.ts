import { observationSchema, refBinding, argumentSchemas } from '../../src/browser/attached/protocol.js';
import type { Operation, Reply } from '../../src/browser/attached/protocol.js';
import { classifyElement, displayUrl, privateText, navigationUrl } from '../../src/browser/policy.js';
interface Access { scopeId: string; tabId: string; session: string; epoch: string; origin: string; expiresAt: number }
interface Entry { node: HTMLElement; revision: number; documentId: string; snapshotId: string; action: string; href?: string }
export class ContentEngine {
  private access?: Access; private documentId: string; private revision = 0; private refs = new Map<string, Entry>(); private snapshotExpires = 0;
  private observer: MutationObserver; private accessTimer?: number; private snapshotTimer?: number;
  constructor(private readonly win: Window & typeof globalThis, private readonly now = Date.now, private readonly id: () => string = () => crypto.randomUUID()) {
    this.documentId = id(); this.observer = new win.MutationObserver(() => { ++this.revision; });
    this.observer.observe(win.document, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  initialize(access: Access): void {
    if (access.origin !== this.win.location.origin || access.expiresAt <= this.now()) throw new Error('ACCESS_DENIED');
    if (!this.access || this.access.scopeId !== access.scopeId || this.access.epoch !== access.epoch || this.access.session !== access.session) this.refs.clear();
    this.access = access; this.win.clearTimeout(this.accessTimer); this.accessTimer = this.win.setTimeout(() => this.revoke(), Math.max(0, access.expiresAt - this.now()));
  }
  revoke(): void { this.win.clearTimeout(this.accessTimer); this.win.clearTimeout(this.snapshotTimer); this.access = undefined; this.refs.clear(); }
  destroy(): void { this.revoke(); this.observer.disconnect(); }
  private visible(el: HTMLElement): boolean {
    if (el.closest('[hidden],[aria-hidden="true"],[inert]') || !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const rect = el.getBoundingClientRect(); if (!rect.width || !rect.height) return false;
    const x = Math.min(this.win.innerWidth - 1, Math.max(0, rect.left + rect.width / 2)); const y = Math.min(this.win.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
    const hit = el.ownerDocument.elementFromPoint(x, y); return !!hit && (hit === el || el.contains(hit));
  }
  private challenge(): Extract<Reply, { outcome: 'REQUIRES_USER_INTERACTION' }>['reason'] | undefined {
    const doc = this.win.document;
    if ([...doc.querySelectorAll<HTMLElement>('input[type="password"]')].some(el => this.visible(el))) return 'AUTHENTICATION';
    if ([...doc.querySelectorAll<HTMLElement>('input[autocomplete="one-time-code"]')].some(el => this.visible(el))) return 'MFA';
    for (const frame of doc.querySelectorAll<HTMLIFrameElement>('iframe')) {
      if (this.visible(frame) && /recaptcha|hcaptcha|challenges\.cloudflare\.com/i.test(frame.getAttribute('src') ?? '')) return 'CAPTCHA';
    }
    const headings = [...doc.querySelectorAll<HTMLElement>('h1,h2,[role="alert"]')].slice(0, 20);
    if (headings.some(el => this.visible(el) && /verify (that )?you are human|unusual traffic|security verification|verifica.*humano|tr[aá]fico inusual/i.test((el.textContent ?? '').slice(0, 200)))) return 'CHALLENGE';
    return undefined;
  }
  async run(operation: Operation, raw: Record<string, unknown>, deadlineAt: number, identity: { session: string; epoch: string }): Promise<Reply> {
    try {
      const args = argumentSchemas[operation].parse(raw) as Record<string, unknown>;
      const access = this.access;
      if (!access || access.session !== identity.session || access.epoch !== identity.epoch || access.expiresAt <= this.now() || access.origin !== this.win.location.origin || args.scopeId !== access.scopeId || args.tabId !== access.tabId) throw new Error('ACCESS_DENIED');
      if (deadlineAt <= this.now()) throw new Error('TIMEOUT');
      const challenge = this.challenge(); if (challenge) { this.refs.clear(); return { outcome: 'REQUIRES_USER_INTERACTION', handoffId: this.id(), reason: challenge }; }
      if (operation === 'observe') return { outcome: 'OK', data: this.observe(access) };
      if (operation === 'scroll') { this.win.scrollBy(0, args.direction === 'down' ? 600 : -600); this.refs.clear(); return { outcome: 'OK', data: { completed: true } }; }
      const bind = refBinding.parse(operation === 'type' || operation === 'press' || operation === 'media' ? { scopeId: args.scopeId, tabId: args.tabId, documentId: args.documentId, snapshotId: args.snapshotId, ref: args.ref } : args);
      const entry = this.refs.get(bind.ref);
      if (!entry || this.snapshotExpires <= this.now() || entry.documentId !== bind.documentId || entry.snapshotId !== bind.snapshotId || entry.revision !== this.revision || !entry.node.isConnected || !this.visible(entry.node)) throw new Error('STALE_REF');
      if (entry.action === 'blocked') throw new Error('REJECTED');
      const el = entry.node; this.refs.clear(); // Consume snapshot before any side effect.
      if (operation === 'click') {
        if (entry.action === 'navigation') this.win.location.assign(navigationUrl(entry.href!));
        else if (entry.action === 'media') return this.media(el, (el as HTMLMediaElement).paused ? 'play' : 'pause');
        else if (entry.action === 'consent' && el.tagName === 'BUTTON') el.click();
        else if (entry.action === 'search' && el.tagName === 'BUTTON') return this.submitSearch(el);
        else if (entry.action === 'search' && ['INPUT', 'TEXTAREA'].includes(el.tagName)) el.focus();
        else throw new Error('REJECTED');
      } else if (operation === 'type') {
        if (entry.action !== 'search' || !['INPUT', 'TEXTAREA'].includes(el.tagName)) return { outcome: 'REQUIRES_USER_INTERACTION', handoffId: this.id(), reason: 'UNSUPPORTED_CONTROL' };
        const text = String(args.text); if (privateText(text, 500) === '[redacted]') throw new Error('REJECTED');
        // Native editing methods preserve existing search text without reading it.
        const prototype = el.tagName === 'INPUT' ? this.win.HTMLInputElement.prototype : this.win.HTMLTextAreaElement.prototype;
        if (args.mode === 'append') { const field = el as HTMLInputElement | HTMLTextAreaElement; field.focus(); field.setSelectionRange(2147483647, 2147483647); field.setRangeText(text); } else Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(el, text); el.dispatchEvent(new this.win.Event('input', { bubbles: true })); el.dispatchEvent(new this.win.Event('change', { bubbles: true }));
      } else if (operation === 'media') {
        if (entry.action !== 'media') throw new Error('REJECTED'); return this.media(el, args.action as 'play' | 'pause');
      } else if (operation === 'press') {
        if (entry.action === 'media' && ['Space', 'Enter'].includes(String(args.key))) return this.media(el, (el as HTMLMediaElement).paused ? 'play' : 'pause');
        if (entry.action !== 'search') throw new Error('REJECTED');
        el.focus(); const key = String(args.key);
        if (key === 'Enter') {
          return this.submitSearch(el);
        } else { el.dispatchEvent(new this.win.KeyboardEvent('keydown', { key, bubbles: true })); el.dispatchEvent(new this.win.KeyboardEvent('keyup', { key, bubbles: true })); }
      } else throw new Error('REJECTED');
      return { outcome: 'OK', data: { completed: true } };
    } catch (error) { const code = error instanceof Error ? error.message : ''; return { outcome: 'ERROR', code: ['STALE_REF', 'ACCESS_DENIED', 'REJECTED', 'TIMEOUT'].includes(code) ? code as 'REJECTED' : 'UNSUPPORTED' }; }
  }
  private submitSearch(el: HTMLElement): Reply {
    const form = el.closest('form');
    // Attached Chrome has normal networking: a label "Search" must not authorize
    // a POST or a custom button handler. Unsupported search controls stay manual.
    if (!form || form.method.toLowerCase() !== 'get' || form.querySelector('input[type="password"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"]')) return { outcome: 'REQUIRES_USER_INTERACTION', handoffId: this.id(), reason: 'UNSUPPORTED_CONTROL' };
    navigationUrl(form.action); form.requestSubmit(); return { outcome: 'OK', data: { completed: true } };
  }
  private async media(el: HTMLElement, action: 'play' | 'pause'): Promise<Reply> {
    if (!['VIDEO', 'AUDIO'].includes(el.tagName)) return { outcome: 'ERROR', code: 'REJECTED' };
    const media = el as HTMLMediaElement;
    try { if (action === 'play') await media.play(); else media.pause(); return { outcome: 'OK', data: { completed: true, paused: media.paused } }; }
    catch { return { outcome: 'REQUIRES_USER_INTERACTION', handoffId: this.id(), reason: 'MEDIA_USER_GESTURE' }; }
  }
  private observe(access: Access) {
    this.refs.clear(); const snapshotId = this.id(); this.snapshotExpires = this.now() + 15_000; this.win.clearTimeout(this.snapshotTimer); this.snapshotTimer = this.win.setTimeout(() => this.refs.clear(), 15_000);
    const doc = this.win.document;
    const modal = [...doc.querySelectorAll<HTMLElement>('dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]')].filter(el => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })).at(-1);
    const scope = modal ?? doc; const cookieDialog = !!modal && /\b(cookies?|galletas)\b/i.test((modal.innerText ?? '').slice(0, 2000));
    const elements = []; let size = 0; let truncated = false;
    for (const el of scope.querySelectorAll<HTMLElement>('a[href],button,input,textarea,select,[role="button"],[role="searchbox"],[role="textbox"],video,audio')) {
      const input = el as HTMLInputElement;
      if (!this.visible(el) || ['password', 'hidden'].includes(input.type) || /password|one-time-code|cc-/.test(input.autocomplete ?? '')) continue;
      if (elements.length >= 40) { truncated = true; break; }
      const tag = el.tagName.toLowerCase(); const declared = el.getAttribute('role'); const role = declared && ['button','searchbox','textbox','link'].includes(declared) ? declared : ({ a: 'link', button: 'button', input: input.type === 'search' ? 'searchbox' : 'textbox', textarea: 'textbox', select: 'combobox', audio: 'media', video: 'media' } as Record<string,string>)[tag] ?? 'button';
      const labelled = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => doc.getElementById(id)?.textContent ?? '').join(' ');
      const name = privateText(el.getAttribute('aria-label') || labelled.trim() || [...input.labels ?? []].map(label => label.textContent).join(' ') || el.getAttribute('placeholder') || (!['input','textarea','select'].includes(tag) && !['textbox','searchbox'].includes(role) ? el.textContent ?? '' : '') || el.getAttribute('title') || tag);
      if (name === '[redacted]') continue;
      const raw = { tag, role, name, type: input.type ?? '', href: tag === 'a' ? (el as HTMLAnchorElement).href : undefined, disabled: !!input.disabled || el.getAttribute('aria-disabled') === 'true', cookieDialog, search: input.type === 'search' || role === 'searchbox' || !!el.closest('[role="search"]') || /^(search|buscar|búsqueda)(\b|$)/i.test(name) };
      const info = { ref: this.id(), role: role.slice(0,30), name, type: raw.type.slice(0,20), disabled: raw.disabled, action: classifyElement(raw), state: { ...(['audio','video'].includes(tag) ? { paused: (el as HTMLMediaElement).paused } : {}), ...(el.hasAttribute('aria-expanded') ? { expanded: el.getAttribute('aria-expanded') === 'true' } : {}) } };
      size += JSON.stringify(info).length; if (size > 10_000) { truncated = true; break; } elements.push(info);
      this.refs.set(info.ref, { node: el, revision: this.revision, documentId: this.documentId, snapshotId, action: info.action, href: raw.href });
    }
    return observationSchema.parse({ tabId: access.tabId, scopeId: access.scopeId, documentId: this.documentId, snapshotId, url: displayUrl(this.win.location.href), title: privateText(doc.title), elements, truncated, ...(modal ? { dialog: { role: privateText(modal.getAttribute('role') ?? 'dialog',30), name: privateText(modal.getAttribute('aria-label') || modal.querySelector('h1,h2,h3')?.textContent || 'Dialog') } } : {}) });
  }
}
