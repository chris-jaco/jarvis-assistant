import type { BrowserConflictDetail, BrowserTimings } from './attached/protocol.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { browserTracer, browserCode } from '../diagnostics/browser.js';
import type { BrowserDiagnostic, BrowserDiagnosticSink, BrowserStage, BrowserToolId } from '../diagnostics/browser.js';
import { ToolError } from '../tools/types.js';
interface Call { call: string; tool: BrowserToolId; clientRequest?: number; duplicate: boolean }
export class BrowserDiagnostics {
  private scope = new AsyncLocalStorage<Call>(); private sequence = 0;
  private calls = new WeakMap<object, Map<string, string>>(); private active = new WeakMap<object, Call>();
  private readonly sink: BrowserDiagnosticSink;
  constructor(readonly enabled = false, sink?: BrowserDiagnosticSink) { this.sink = browserTracer(enabled, sink); }
  received(owner: object, invocation: string, tool: BrowserToolId, clientRequest?: number): Call {
    let cache = this.calls.get(owner); if (!cache) { cache = new Map(); this.calls.set(owner, cache); }
    const previous = cache.get(invocation); const call = previous ?? `b${++this.sequence}`;
    if (!previous && cache.size < 100) cache.set(invocation, call);
    return { call, tool, duplicate: !!previous, ...(clientRequest === undefined ? {} : { clientRequest }) };
  }
  async inCall<T>(owner: object, call: Call, work: () => Promise<T>): Promise<T> {
    if (!this.enabled) return work();
    this.active.set(owner, call);
    try { return await this.scope.run(call, work); }
    finally { this.active.delete(owner); }
  }
  event(stage: BrowserStage, code: BrowserDiagnostic['code'], elapsedMs = 0, state: Pick<BrowserDiagnostic, 'channel' | 'connected' | 'initializing'> = {}): void {
    this.sink({ ...this.scope.getStore(), stage, code, elapsedMs: Math.max(0, Math.round(elapsedMs)), ...state });
  }
  metadata(timings: BrowserTimings, reason?: BrowserConflictDetail['reason']): void {
    this.sink({ ...this.scope.getStore(), stage: 'provider_result', code: reason ? 'CONFLICT' : 'OK', elapsedMs: timings.transportMs ?? 0, timings, ...(reason ? { reason } : {}) });
  }
  capture(stage: BrowserStage, code: BrowserDiagnostic['code']): () => void {
    const call = this.scope.getStore();
    return () => this.sink({ ...call, stage, code, elapsedMs: 0 });
  }
  lifecycle(owner: object, stage: 'http_busy' | 'session_closed' | 'session_replaced' | 'session_expired'): void {
    this.sink({ ...this.active.get(owner), stage, code: stage === 'http_busy' ? 'BUSY' : 'CLOSED', elapsedMs: 0 });
  }
  async run<T>(stage: BrowserStage, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const started = performance.now(); const call = this.scope.getStore(); let ended = false;
    this.event(stage, 'RUNNING');
    const end = (code: BrowserDiagnostic['code']) => { if (!ended) { ended = true; this.sink({ ...call, stage, code, elapsedMs: Math.max(0, Math.round(performance.now() - started)) }); } };
    const abort = () => end('TIMEOUT'); signal?.addEventListener('abort', abort, { once: true });
    try { if (signal?.aborted) abort(); const result = await work(); end('OK'); return result; }
    catch (error) { end(error instanceof ToolError ? browserCode(error.category) : error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name) ? 'TIMEOUT' : 'UPSTREAM'); throw error; }
    finally { signal?.removeEventListener('abort', abort); }
  }
}
