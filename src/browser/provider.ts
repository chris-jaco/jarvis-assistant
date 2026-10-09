import type { ConversationEvidence } from './consequential/conversation-evidence.js';
import type { SemanticContext } from './consequential/semantic.js';
export type BrowserKey = 'Enter' | 'Escape' | 'Tab' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Space';
export interface BrowserTab { id: string; title: string; url: string; active: boolean; lastInteraction?: string }
export type FunctionalKind = 'SEARCH_INPUT' | 'SEARCH_SUBMIT' | 'RESULT_LINK' | 'NAVIGATION_LINK' | 'MEDIA_ELEMENT' | 'MEDIA_PLAY' | 'MEDIA_PAUSE' | 'AD_SKIP' | 'BLOCKED';
export type BrowserCapability = 'TYPE_SEARCH' | 'SUBMIT_SEARCH' | 'OPEN_LINK' | 'PLAY' | 'PAUSE' | 'SKIP_AD';
export interface MediaSummary { presence: 'NONE' | 'AVAILABLE'; playback: 'UNKNOWN' | 'LOADING' | 'PLAYING' | 'PAUSED' | 'ENDED' | 'BUFFERING' | 'ERROR'; advertisement: 'UNKNOWN' | 'DETECTED'; skipAvailable: boolean }
export type BrowserActionClass = 'navigation' | 'search' | 'media' | 'consent' | 'blocked';
export interface BrowserElement { functionalKind?: FunctionalKind; capabilities?: BrowserCapability[]; ref: string; role: string; name: string; type: string; disabled: boolean; state?: { paused?: boolean; checked?: boolean; expanded?: boolean }; action: BrowserActionClass }
export interface BrowserObservation { conversationEvidence?:ConversationEvidence; conversationContext?:SemanticContext; media?: MediaSummary; tabId: string; url: string; title: string; elements: BrowserElement[]; truncated: boolean; dialog?: { role: string; name: string } }
export interface BrowserStatus { connections?: string[]; available: boolean; connected: boolean; reason?: 'disabled' | 'unavailable'; visible: boolean }
// Atlas tools depend only on this contract. No Playwright types, selectors or JS.
export interface BrowserProvider {
  status(): Promise<BrowserStatus>;
  ensureBrowser(signal: AbortSignal): Promise<BrowserStatus>;
  listTabs(signal: AbortSignal): Promise<BrowserTab[]>;
  getActiveTab(signal: AbortSignal): Promise<BrowserTab | null>;
  openTab(url: string, signal: AbortSignal): Promise<BrowserTab>;
  switchTab(tabId: string, signal: AbortSignal): Promise<BrowserTab>;
  closeTab(tabId: string, signal: AbortSignal): Promise<void>;
  navigate(url: string, signal: AbortSignal): Promise<BrowserTab>;
  observe(signal: AbortSignal): Promise<BrowserObservation>;
  click(ref: string, signal: AbortSignal): Promise<void>;
  type(ref: string, text: string, mode: 'replace' | 'append', signal: AbortSignal): Promise<void>;
  press(ref: string, key: BrowserKey, signal: AbortSignal): Promise<void>;
  scroll(direction: 'up' | 'down', signal: AbortSignal): Promise<void>;
  back(signal: AbortSignal): Promise<BrowserTab>;
  forward(signal: AbortSignal): Promise<BrowserTab>;
  reload(signal: AbortSignal): Promise<BrowserTab>;
  close(): Promise<void>;
}
