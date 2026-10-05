export type BrowserKey = 'Enter' | 'Escape' | 'Tab' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Space';
export interface BrowserTab { id: string; title: string; url: string; active: boolean; lastInteraction?: string }
export type BrowserActionClass = 'navigation' | 'search' | 'media' | 'consent' | 'blocked';
export interface BrowserElement { ref: string; role: string; name: string; type: string; disabled: boolean; state?: { paused?: boolean; checked?: boolean; expanded?: boolean }; action: BrowserActionClass }
export interface BrowserObservation { tabId: string; url: string; title: string; elements: BrowserElement[]; truncated: boolean; dialog?: { role: string; name: string } }
export interface BrowserStatus { available: boolean; connected: boolean; reason?: 'disabled' | 'unavailable'; visible: boolean }
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
