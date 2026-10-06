import { observationSchema, refBinding, argumentSchemas } from '../../src/browser/attached/protocol.js';
import type { Operation, Reply } from '../../src/browser/attached/protocol.js';
import { classifyElement, displayUrl, privateText, navigationUrl } from '../../src/browser/policy.js';
interface Access { scopeId: string; tabId: string; session: string; epoch: string; origin: string; expiresAt: number }
interface Entry { node: HTMLElement; documentId: string; snapshotId: string; action: string; href?: string; fingerprint: string; form: HTMLFormElement | null; modal?: HTMLElement }
export class ContentEngine {
  private access?: Access; private documentId: string; private documentUrl: string; private refs = new Map<string, Entry>(); private snapshotExpires = 0;
  private accessTimer?: number; private snapshotTimer?: number;
  constructor(private readonly win: Window & typeof globalThis, private readonly now = Date.now, private readonly id: () => string = () => crypto.randomUUID()) {
    this.documentId = id(); this.documentUrl = win.location.href;
    win.addEventListener('popstate', this.navigationChanged);
    win.addEventListener('hashchange', this.navigationChanged);
    win.addEventListener('pagehide', this.navigationChanged);
    win.addEventListener('pageshow', this.navigationChanged);
    // Navigation API observes History API changes without patching page JS or
    // injecting into the MAIN world. URL comparison below is an extra guard.
    (win as unknown as { navigation?: EventTarget }).navigation?.addEventListener('currententrychange', this.navigationChanged);
  }
  initialize(access: Access): void {
    if (access.origin !== this.win.location.origin || access.expiresAt <= this.now()) throw new Error('ACCESS_DENIED');
    if (!this.access || this.access.scopeId !== access.scopeId || this.access.epoch !== access.epoch || this.access.session !== access.session) this.refs.clear();
    this.access = access; this.win.clearTimeout(this.accessTimer); this.accessTimer = this.win.setTimeout(() => this.revoke(), Math.max(0, access.expiresAt - this.now()));
  }
  revoke(): void { this.win.clearTimeout(this.accessTimer); this.win.clearTimeout(this.snapshotTimer); this.access = undefined; this.refs.clear(); }
  private navigationChanged = (): void => { this.documentChanged(); };
  documentChanged(): void { this.documentId = this.id(); this.documentUrl = this.win.location.href; this.refs.clear(); this.snapshotExpires = 0; }
  destroy(): void {
    this.revoke();
    for (const event of ['popstate', 'hashchange', 'pagehide', 'pageshow']) this.win.removeEventListener(event, this.navigationChanged);
    (this.win as unknown as { navigation?: EventTarget }).navigation?.removeEventListener('currententrychange', this.navigationChanged);
  }
  private modal(): HTMLElement | undefined {
    return [...this.win.document.querySelectorAll<HTMLElement>('dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]')].filter(el => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })).at(-1);
  }
  private describe(el: HTMLElement, modal = this.modal()) {
    const doc = this.win.document; const input = el as HTMLInputElement;
    const tag = el.tagName.toLowerCase(); const declared = el.getAttribute('role');
    const role = declared && ['button','searchbox','textbox','link'].includes(declared) ? declared : ({ a: 'link', button: 'button', input: input.type === 'search' ? 'searchbox' : 'textbox', textarea: 'textbox', select: 'combobox', audio: 'media', video: 'media' } as Record<string,string>)[tag] ?? 'button';
    const labelled = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => doc.getElementById(id)?.textContent ?? '').join(' ');
    const name = privateText(el.getAttribute('aria-label') || labelled.trim() || [...input.labels ?? []].map(label => label.textContent).join(' ') || el.getAttribute('placeholder') || (!['input','textarea','select'].includes(tag) && !['textbox','searchbox'].includes(role) ? el.textContent ?? '' : '') || el.getAttribute('title') || tag);
    const raw = { tag, role, name, type: input.type ?? '', href: tag === 'a' ? (el as HTMLAnchorElement).href : undefined, disabled: !!input.disabled || el.getAttribute('aria-disabled') === 'true', cookieDialog: !!modal && /\b(cookies?|galletas)\b/i.test((modal.innerText ?? '').slice(0, 2000)), search: input.type === 'search' || role === 'searchbox' || !!el.closest('[role="search"]') || /^(search|buscar|búsqueda)(\b|$)/i.test(name) };
    const form = el.closest('form');
    // Compare only functional/security metadata. Never read field values.
    const fingerprint = JSON.stringify([raw, declared, el.getAttribute('contenteditable'), el.isContentEditable, input.readOnly, el.matches(':disabled'), input.autocomplete, el.getAttribute('aria-labelledby'), el.getAttribute('name'), el.getAttribute('form'), el.getAttribute('formaction'), el.getAttribute('formmethod'), form?.action, form?.method, form?.enctype, [...form?.elements ?? []].map(field => [field.tagName, field.getAttribute('type'), field.getAttribute('name'), field.getAttribute('autocomplete'), field.getAttribute('formaction'), field.getAttribute('formmethod'), field.matches(':disabled')]), !!form?.querySelector('input[type="password"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"]')]);
    return { raw, fingerprint, form, action: classifyElement(raw) };
  }
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
    let dispatched = false;
    try {
      const args = argumentSchemas[operation].parse(raw) as Record<string, unknown>;
      if (this.win.location.href !== this.documentUrl) this.documentChanged();
      const access = this.access;
      if (!access || access.session !== identity.session || access.epoch !== identity.epoch || access.expiresAt <= this.now() || access.origin !== this.win.location.origin || args.scopeId !== access.scopeId || args.tabId !== access.tabId) throw new Error('ACCESS_DENIED');
      if (deadlineAt <= this.now()) throw new Error('TIMEOUT');
      const challenge = this.challenge(); if (challenge) { this.refs.clear(); return { outcome: 'REQUIRES_USER_INTERACTION', handoffId: this.id(), reason: challenge }; }
      if (operation === 'observe') { const started = this.now(); const data = this.observe(access); return { outcome: 'OK', data, timings: { observationBuildMs: Math.min(30_000, Math.max(0, this.now() - started)) } }; }
      if (operation === 'scroll') { dispatched = true; this.win.scrollBy(0, args.direction === 'down' ? 600 : -600); this.refs.clear(); return { outcome: 'OK', data: { completed: true } }; }
      const bind = refBinding.parse(operation === 'type' || operation === 'press' || operation === 'media' ? { scopeId: args.scopeId, tabId: args.tabId, documentId: args.documentId, snapshotId: args.snapshotId, ref: args.ref } : args);
      const entry = this.refs.get(bind.ref);
      const conflict = (reason: 'DOCUMENT_CHANGED' | 'SNAPSHOT_EXPIRED' | 'SNAPSHOT_CONSUMED' | 'ELEMENT_CHANGED'): Reply => ({ outcome: 'ERROR', code: 'STALE_REF', conflict: { reason, execution: 'NOT_EXECUTED' } });
      if (bind.documentId !== this.documentId) return conflict('DOCUMENT_CHANGED');
      if (this.snapshotExpires <= this.now()) return conflict('SNAPSHOT_EXPIRED');
      if (!entry || entry.snapshotId !== bind.snapshotId) return conflict('SNAPSHOT_CONSUMED');
      const modal = this.modal();
      if (!entry.node.isConnected || !this.visible(entry.node) || entry.modal !== modal || modal && !modal.contains(entry.node)) return conflict('ELEMENT_CHANGED');
      const current = this.describe(entry.node, modal);
      if (current.form !== entry.form || current.fingerprint !== entry.fingerprint || current.action !== entry.action) return conflict('ELEMENT_CHANGED');
      if (entry.action === 'blocked') throw new Error('REJECTED');
      const el = entry.node; this.refs.clear(); // Consume snapshot before any side effect.
      dispatched = true;
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
    } catch (error) { const code = error instanceof Error ? error.message : ''; return { outcome: 'ERROR', code: ['STALE_REF', 'ACCESS_DENIED', 'REJECTED', 'TIMEOUT'].includes(code) ? code as 'REJECTED' : dispatched ? 'EXECUTION_UNKNOWN' : 'UNSUPPORTED' }; }
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
    this.refs.clear(); const snapshotId = this.id(); this.win.clearTimeout(this.snapshotTimer);
    const doc = this.win.document;
    const modal = this.modal(); const scope = modal ?? doc;
    const elements = []; let size = 0; let truncated = false;
    for (const el of scope.querySelectorAll<HTMLElement>('a[href],button,input,textarea,select,[role="button"],[role="searchbox"],[role="textbox"],video,audio')) {
      const input = el as HTMLInputElement;
      if (!this.visible(el) || ['password', 'hidden'].includes(input.type) || /password|one-time-code|cc-/.test(input.autocomplete ?? '')) continue;
      if (elements.length >= 40) { truncated = true; break; }
      const { raw, fingerprint, form, action } = this.describe(el, modal); const { tag, role, name } = raw;
      if (name === '[redacted]') continue;
      const info = { ref: this.id(), role: role.slice(0,30), name, type: raw.type.slice(0,20), disabled: raw.disabled, action, state: { ...(['audio','video'].includes(tag) ? { paused: (el as HTMLMediaElement).paused } : {}), ...(el.hasAttribute('aria-expanded') ? { expanded: el.getAttribute('aria-expanded') === 'true' } : {}) } };
      size += JSON.stringify(info).length; if (size > 10_000) { truncated = true; break; } elements.push(info);
      this.refs.set(info.ref, { node: el, fingerprint, form, modal, documentId: this.documentId, snapshotId, action: info.action, href: raw.href });
    }
    // Validate/build before starting the single authoritative 15-second TTL.
    const built = observationSchema.parse({ expiresAt: 1, tabId: access.tabId, scopeId: access.scopeId, documentId: this.documentId, snapshotId, url: displayUrl(this.win.location.href), title: privateText(doc.title), elements, truncated, ...(modal ? { dialog: { role: privateText(modal.getAttribute('role') ?? 'dialog',30), name: privateText(modal.getAttribute('aria-label') || modal.querySelector('h1,h2,h3')?.textContent || 'Dialog') } } : {}) });
    this.snapshotExpires = this.now() + 15_000; this.snapshotTimer = this.win.setTimeout(() => this.refs.clear(), 15_000);
    return { ...built, expiresAt: this.snapshotExpires };
  }
}
