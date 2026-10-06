import type { MediaSummary, BrowserCapability, FunctionalKind } from '../../src/browser/provider.js';
import { consequentialControl } from '../../src/browser/policy.js';
import { accessibleName } from './search-controls.js';

export interface MediaControl { target: HTMLMediaElement; container: HTMLElement; kind: FunctionalKind; capabilities: BrowserCapability[]; fingerprint: string }
const skipName = /^(skip ad|skip ads|skip advertisement|omitir anuncio|omitir anuncios|saltar anuncio)[.!]?$/i;
const playName = /^(play|reproducir|resume|reanudar|seguir reproduciendo)[.!]?$/i;
const pauseName = /^(pause|pausar|pausa)[.!]?$/i;
const adName = /^(advertisement|advertising|anuncio|publicidad|ad(?:\s+\d+\s+(?:of|de)\s+\d+)?)[.!]?$/i;
function rendered(el: HTMLElement): boolean { return !el.closest('[hidden],[aria-hidden="true"],[inert]') && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && !!el.getBoundingClientRect().width && !!el.getBoundingClientRect().height; }
export function mediaContainer(media: HTMLMediaElement): HTMLElement {
  let parent = media.parentElement;
  // A semantic region is preferred. A bounded ancestor with one media element
  // can represent a custom player, without knowing its classes or site.
  for (let depth = 0; parent && depth < 5 && !['BODY','HTML'].includes(parent.tagName); depth++, parent = parent.parentElement) {
    if (parent.matches('figure,[role="region"],[role="group"]') && parent.querySelectorAll('video,audio').length === 1) return parent;
  }
  parent = media.parentElement;
  let container: HTMLElement = media;
  for (let depth = 0; parent && depth < 3 && !['BODY','HTML'].includes(parent.tagName); depth++, parent = parent.parentElement) {
    if (parent.querySelectorAll('video,audio').length !== 1) break;
    container = parent;
  }
  return container;
}
function adEvidence(container: HTMLElement): boolean {
  return [...container.querySelectorAll<HTMLElement>('[aria-label],[role="status"],[role="note"],span')].slice(0,60)
    .some(el => rendered(el) && adName.test(accessibleName(el)));
}
export function resolveMedia(el: HTMLElement): MediaControl | undefined {
  const ownMedia = ['VIDEO','AUDIO'].includes(el.tagName);
  if (!ownMedia && (!el.matches('button,[role="button"]') || (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true')) return;
  if (!ownMedia && ((el as HTMLButtonElement).form || el.closest('form'))) return;
  const name = accessibleName(el);
  if (!ownMedia && consequentialControl(name)) return;
  const candidates = ownMedia ? [el as HTMLMediaElement] : [...el.ownerDocument.querySelectorAll<HTMLMediaElement>('video,audio')].filter(media => rendered(media) && mediaContainer(media).contains(el)).slice(0,2);
  if (candidates.length !== 1) return;
  const target = candidates[0]!; const container = mediaContainer(target);
  let kind: FunctionalKind; let capabilities: BrowserCapability[];
  if (ownMedia) { kind = 'MEDIA_ELEMENT'; capabilities = ['PLAY','PAUSE']; }
  else if (skipName.test(name) && (adEvidence(container) || /^(skip ad|skip ads|skip advertisement|omitir anuncios?|saltar anuncio)[.!]?$/i.test(name))) { kind = 'AD_SKIP'; capabilities = ['SKIP_AD']; }
  else if (playName.test(name)) { kind = 'MEDIA_PLAY'; capabilities = ['PLAY']; }
  else if (pauseName.test(name)) { kind = 'MEDIA_PAUSE'; capabilities = ['PAUSE']; }
  else return;
  return { target, container, kind, capabilities, fingerprint: JSON.stringify([kind, name, el.getAttribute('aria-controls'), el.getAttribute('aria-disabled'), (el as HTMLButtonElement).disabled]) };
}
export class MediaState {
  constructor(private readonly win: Window & typeof globalThis) {}
  async read(scope: ParentNode, deadlineAt: number, now = Date.now): Promise<MediaSummary> {
    const media = [...scope.querySelectorAll<HTMLMediaElement>('video,audio')].filter(rendered).slice(0,4);
    const empty: MediaSummary = { presence: 'NONE', playback: 'UNKNOWN', advertisement: 'UNKNOWN', skipAvailable: false };
    if (!media.length) return empty;
    // Multiple players are not silently merged into a claim about one song.
    if (media.length !== 1) return { ...empty, presence: 'AVAILABLE' };
    const target = media[0]!; const player = mediaContainer(target);
    const container = scope instanceof this.win.HTMLElement && !scope.contains(player) ? scope : player;
    const skipAvailable = [...container.querySelectorAll<HTMLElement>('button,[role="button"]')].slice(0,40).some(el => rendered(el) && resolveMedia(el)?.kind === 'AD_SKIP');
    const advertisement = adEvidence(container) || skipAvailable ? 'DETECTED' : 'UNKNOWN';
    const initial = target.currentTime;
    if (!target.paused && !target.ended && !target.error && target.readyState >= 2 && deadlineAt - now() > 200) {
      await new Promise<void>(resolve => this.win.setTimeout(resolve, 160));
    }
    const playback: MediaSummary['playback'] = !target.isConnected ? 'UNKNOWN' : target.error ? 'ERROR' : target.ended ? 'ENDED'
      : target.readyState === 0 ? 'LOADING' : target.paused ? 'PAUSED'
      : target.readyState < 3 ? 'BUFFERING' : target.currentTime > initial ? 'PLAYING' : 'UNKNOWN';
    return { presence: 'AVAILABLE', playback, advertisement, skipAvailable };
  }
  async execute(control: MediaControl, action: 'play' | 'pause'): Promise<'OK' | 'GESTURE' | 'ERROR' | 'UNKNOWN'> {
    if (!control.capabilities.includes(action === 'play' ? 'PLAY' : 'PAUSE')) return 'ERROR';
    try {
      if (control.kind !== 'MEDIA_ELEMENT') {
        // Caller dispatches the actual control once. Browser enforcement is
        // inferred only from a real play() rejection, never a label or an ad.
        return 'ERROR';
      }
      if (action === 'play') await control.target.play(); else control.target.pause();
      return 'OK';
    } catch (error) {
      if (error instanceof this.win.DOMException && error.name === 'NotAllowedError') return 'GESTURE';
      if (error instanceof this.win.DOMException && error.name === 'NotSupportedError') return 'ERROR';
      return 'UNKNOWN'; // Unexpected errors may follow a side effect; never retry.
    }
  }
}
