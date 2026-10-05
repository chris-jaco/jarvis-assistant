import { ToolError } from '../tools/types.js';
import type { BrowserActionClass } from './provider.js';
const consequential = /(?:send|submit|publish|post|buy|purchase|checkout|pay|book|reserve|delete|remove|cancel|logout|sign.?out|password|security|account|unsubscribe|enviar|publicar|comprar|pagar|reservar|eliminar|borrar|cancelar|cuenta|seguridad|suscri)/i;
const secret = /(?:token|secret|password|authorization|cookie|api.?key|oauth|session|code)[\s:=]|\b(?:Bearer\s|sk-|ya29\.|eyJ[A-Za-z0-9_-]+\.)/i;
export function privateText(text: string, limit = 120): string {
  if (secret.test(text) || /\b(?:\d[ -]?){13,19}\b|\b(?:gh[pousr]_|github_pat_|AIza)[A-Za-z0-9_-]{20,}/.test(text) || /(?:password|contrase[nñ]a|access.token|refresh.token|api.?key|verification code|c[oó]digo de verificaci[oó]n)/i.test(text)) return '[redacted]';
  return text.replace(/\s+/g, ' ').trim().slice(0, limit);
}
export function navigationUrl(raw: string): string {
  let url: URL; try { url = new URL(raw); } catch { throw new ToolError('INVALID_INPUT'); }
  const host = url.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port && !['80', '443'].includes(url.port)
    || !host.includes('.') || host.endsWith('.local') || host.endsWith('.localhost') || host === 'localhost'
    || /^[\d.]+$/.test(host) || host.includes(':') || consequential.test(decodeURIComponent(url.pathname)) || secret.test(url.href) || consequential.test(decodeURIComponent(url.search))) throw new ToolError('REJECTED');
  return url.href;
}
export function displayUrl(raw: string): string {
  try { const url = new URL(raw); if (!['http:', 'https:'].includes(url.protocol)) return 'about:blank'; return url.origin + (secret.test(url.pathname) ? '/[redacted]' : url.pathname.slice(0, 200)); } catch { return 'about:blank'; }
}
export function classifyElement(element: { tag: string; role: string; name: string; type: string; href?: string; search: boolean; disabled: boolean }): BrowserActionClass {
  if (element.disabled || consequential.test(element.name) || ['password', 'file', 'email', 'tel', 'hidden'].includes(element.type)) return 'blocked';
  if (element.tag === 'a' && element.href) { try { navigationUrl(element.href); return 'navigation'; } catch { return 'blocked'; } }
  if (element.tag === 'video' || element.tag === 'audio') return 'media';
  if (element.search && ['input', 'button', 'textarea'].includes(element.tag)) return 'search';
  return 'blocked';
}
