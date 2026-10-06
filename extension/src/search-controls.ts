import { consequentialControl, navigationUrl } from '../../src/browser/policy.js';

export interface SearchControl {
  input: HTMLInputElement;
  button?: HTMLElement;
  form: HTMLFormElement | null;
  mode: 'GET' | 'SPA';
  fingerprint: string;
}
export function accessibleName(el: HTMLElement): string {
  const labels = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).slice(0, 8)
    .map(id => el.ownerDocument.getElementById(id)?.textContent?.slice(0, 120) ?? '').join(' ');
  return (el.getAttribute('aria-label') || labels.trim() || el.getAttribute('placeholder') || el.getAttribute('title')
    || (el.tagName === 'INPUT' ? [...(el as HTMLInputElement).labels ?? []].map(label => label.textContent?.slice(0,120)).join(' ') : el.textContent) || '').trim().slice(0,120);
}
const searchName = /^(search|buscar|búsqueda)(\b|$)/i;
const composer = /\b(chat|compose|composer|message|mensaje|redactar|destinatario|recipient|reply|respuesta)\b/i;
const inputs = 'input:not([type]),input[type="text"],input[type="search"]';
const buttons = 'button,[role="button"],input[type="submit"]';
function unsafe(el: HTMLElement): boolean {
  if (consequentialControl(accessibleName(el)) || composer.test(accessibleName(el)) || el.closest('[contenteditable="true"],[role="log"]')) return true;
  const context = el.closest('form,[role="search"],[role="dialog"]');
  if (context && (composer.test(accessibleName(context as HTMLElement)) || context.querySelector('textarea,[contenteditable="true"],input[type="password"],input[type="email"],input[type="file"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"]'))) return true;
  return !!(el as HTMLInputElement).disabled || el.getAttribute('aria-disabled') === 'true';
}
function searchInput(el: Element): el is HTMLInputElement {
  const input = el as HTMLInputElement;
  return el.tagName === 'INPUT' && ['text','search'].includes(input.type) && !input.readOnly && !unsafe(input)
    && (input.type === 'search' || input.getAttribute('role') === 'searchbox' || searchName.test(accessibleName(input)) || !!input.closest('[role="search"]'));
}
function validForm(form: HTMLFormElement, button?: HTMLElement): boolean {
  if (form.method.toLowerCase() !== 'get' || form.querySelector('textarea,[contenteditable="true"],input[type="password"],input[type="email"],input[type="file"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"]')) return false;
  if ([...form.elements].some(el => consequentialControl(accessibleName(el as HTMLElement)) || composer.test(accessibleName(el as HTMLElement)))) return false;
  if (button?.hasAttribute('formmethod') && button.getAttribute('formmethod')!.toLowerCase() !== 'get') return false;
  try { navigationUrl(button?.getAttribute('formaction') ? new URL(button.getAttribute('formaction')!, form.ownerDocument.baseURI).href : form.action); return true; } catch { return false; }
}
// Relationships are resolved from actual nodes; never from a model selector or
// proximity. Ambiguity and consequential context take precedence over labels.
export function resolveSearch(el: HTMLElement): SearchControl | undefined {
  if (unsafe(el)) return;
  const isInput = searchInput(el);
  const isButton = el.matches(buttons) && searchName.test(accessibleName(el));
  if (!isInput && !isButton) return;
  const form = (el as HTMLInputElement | HTMLButtonElement).form ?? el.closest('form');
  let candidates: HTMLInputElement[] = [];
  if (form) candidates = [...form.elements].filter(searchInput);
  else {
    const scope = el.closest('[role="search"]');
    if (scope) candidates = [...scope.querySelectorAll(inputs)].filter(searchInput);
    if (isButton && el.hasAttribute('aria-controls')) {
      const controlled = el.getAttribute('aria-controls')!.split(/\s+/).slice(0,8).map(id => el.ownerDocument.getElementById(id));
      const direct = controlled.filter((node): node is HTMLInputElement => !!node && searchInput(node));
      if (direct.length) candidates = direct;
    }
    if (isInput && !candidates.length) candidates = [el as HTMLInputElement];
  }
  if (candidates.length !== 1 || isInput && candidates[0] !== el) return;
  const input = candidates[0]!;
  // An external SPA button must not smuggle submission into a POST form.
  const inputForm = input.form;
  const effectiveForm = form ?? inputForm;
  if (effectiveForm && !validForm(effectiveForm, isButton ? el : undefined)) return;
  if (!effectiveForm && isButton && !input.closest('[role="search"]')) return;
  const fingerprint = JSON.stringify([input.getAttribute('id'), input.getAttribute('role'), accessibleName(input), el.getAttribute('aria-controls'), effectiveForm?.action, effectiveForm?.method, el.getAttribute('formaction'), el.getAttribute('formmethod')]);
  return { input, button: isButton ? el : undefined, form: effectiveForm, mode: effectiveForm ? 'GET' : 'SPA', fingerprint };
}
export function submitSearch(control: SearchControl, win: Window & typeof globalThis): void {
  if (control.mode === 'GET' && control.form) {
    if (!validForm(control.form, control.button)) throw new Error('REJECTED');
    const button = control.button;
    const nativeSubmit = button && button.matches('button:not([type]),button[type="submit"],input[type="submit"]') && (button as HTMLButtonElement).form === control.form;
    control.form.requestSubmit(nativeSubmit ? button as HTMLButtonElement : undefined);
  } else if (control.button) control.button.click();
  else {
    control.input.focus();
    control.input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    control.input.dispatchEvent(new win.KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  }
}
