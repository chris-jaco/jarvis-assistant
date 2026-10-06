import type { BrowserConflictDetail, BrowserTimings } from '../browser/attached/protocol.js';
// Shared metadata contract, safe for the browser bundle; no Node imports.
export const browserToolIds = ['browser.status', 'browser.tabs', 'browser.open', 'browser.navigate', 'browser.switch', 'browser.close', 'browser.observe', 'browser.click', 'browser.type', 'browser.press', 'browser.scroll', 'browser.back', 'browser.forward', 'browser.reload', 'browser.requestAccess', 'browser.revokeAccess', 'browser.media', 'browser.endTask', 'browser.resume'] as const;
export type BrowserToolId = typeof browserToolIds[number];
export function isBrowserTool(id: string): id is BrowserToolId { return (browserToolIds as readonly string[]).includes(id); }
export type BrowserStage = 'http_received' | 'http_result' | 'http_busy' | 'session_closed' | 'session_replaced' | 'session_expired' | 'adapter' | 'execution_abort' | 'provider_state' | 'provider_initialization' | 'initialization_wait' | 'profile_security' | 'browser_launch' | 'context_ready' | 'startup_page' | 'tab_creation' | 'navigation' | 'tab_metadata' | 'observe' | 'action' | 'provider_result' | 'executor_result' | 'realtime_received' | 'realtime_result';
export type BrowserCode = 'RUNNING' | 'OK' | 'TIMEOUT' | 'UNCONFIGURED' | 'CONFLICT' | 'REJECTED' | 'UPSTREAM' | 'INVALID_INPUT' | 'BUSY' | 'CLOSED' | 'EXECUTION_UNKNOWN';
export interface BrowserDiagnostic {
  stage: BrowserStage; code: BrowserCode; elapsedMs: number;
  call?: string; clientRequest?: number; tool?: BrowserToolId; duplicate?: boolean;
  reason?: BrowserConflictDetail['reason']; timings?: BrowserTimings;
  channel?: 'chrome' | 'msedge' | 'chromium'; connected?: boolean; initializing?: boolean;
}
export type BrowserDiagnosticSink = (entry: BrowserDiagnostic) => void;
export function browserTracer(enabled: boolean, sink: BrowserDiagnosticSink = entry => console.info('[ATLAS browser]', JSON.stringify(entry))): BrowserDiagnosticSink {
  return enabled ? entry => { try {
    const { stage, code, elapsedMs, call, clientRequest, tool, duplicate, channel, connected, initializing } = entry;
    const reason = ['SNAPSHOT_CONSUMED','SNAPSHOT_EXPIRED','DOCUMENT_CHANGED','ELEMENT_CHANGED'].includes(entry.reason ?? '') ? entry.reason : undefined;
    const timings: BrowserTimings = {};
    for (const field of ['queueMs','injectionMs','initializationMs','observationBuildMs','returnMs','transportMs'] as const) { const value = entry.timings?.[field]; if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 30_000) timings[field] = value; }
    sink({ stage, code, elapsedMs, ...(call ? { call } : {}), ...(clientRequest !== undefined ? { clientRequest } : {}), ...(tool ? { tool } : {}), ...(duplicate !== undefined ? { duplicate } : {}), ...(channel ? { channel } : {}), ...(connected !== undefined ? { connected } : {}), ...(initializing !== undefined ? { initializing } : {}), ...(reason ? { reason } : {}), ...(Object.keys(timings).length ? { timings } : {}) });
  } catch { /* Diagnostics cannot affect execution. */ } } : () => {};
}
export function browserCode(category: unknown): BrowserCode {
  return typeof category === 'string' && ['TIMEOUT', 'UNCONFIGURED', 'CONFLICT', 'REJECTED', 'UPSTREAM', 'INVALID_INPUT', 'EXECUTION_UNKNOWN'].includes(category) ? category as BrowserCode : 'UPSTREAM';
}
