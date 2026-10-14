import type { ContinuationReceipt } from '../browser/task-lifecycle.js';
import type { SessionCloseReason } from '../diagnostics/browser-task.js';
import type { ToolActivity } from '../tools/telemetry.js';
import type { ToolResult } from '../tools/types.js';

export interface PendingConfirmation {
  confirmationId: string;
  summary: string;
  expiresAt: number;
  confirmationKind?: 'CONTENT' | 'WRITE';
  review?: { kind: 'EDITABLE_CONTENT'; content: string; label: string; maxLength: number };
}

export interface CoreToolDescriptor {
  permission?: 'READ' | 'WRITE' | 'SENSITIVE';
  id: string;
  description: string;
  inputSchema: unknown;
}

export interface CoreSessionConfiguration {
  tools: CoreToolDescriptor[];
  timezone: string;
  now: string;
  confirmationTrace?: boolean;
  browserTrace?: boolean;
  accessTrace?: boolean;
  browserPresentation?: boolean;
  browserTaskLifecycle?: boolean;
}

export interface CoreOperationMap {
  'session.create': { input: Record<string, never>; output: CoreSessionConfiguration };
  'session.close': { input: { reason: SessionCloseReason }; output: { closed: boolean } };
  'activity.get': { input: undefined; output: { activity: ToolActivity[]; pending: PendingConfirmation | null; browser?: unknown } };
  'tool.invoke': { input: { invocationId: string; toolId: string; input: unknown }; output: ToolResult };
  'browser.admit': {
    input: {
      admissionId: string;
      userTurn?: { itemId: string; utterance: string };
      transcriptPending?: true;
      late?: true;
    };
    output: { admitted: boolean };
  };
  'browser.cancel': { input: { itemId: string; utterance: string }; output: { cancelled: boolean } };
  'browser.continuation': { input: ContinuationReceipt; output: { acknowledged: boolean } };
  'browser.resume': { input: { handoffId: string; utterance: string }; output: unknown };
  'browser.stall': { input: Record<string, never>; output: { stalled: boolean } };
  'confirmation.intent': { input: { confirmationId: string; utterance: string }; output: { confirmationId?: unknown; intent?: unknown } };
  'confirmation.decision': { input: { confirmationId: string; approved: boolean; editedContent?: string }; output: ToolResult };
  'confirmation.cancel': { input: { confirmationId?: string }; output: { cancelled?: unknown } };
  'confirmation.visible': { input: { confirmationId: string; visible: boolean }; output: { acknowledged?: unknown; kind?: unknown } };
  'memory.context': { input: { query: string }; output: { context?: unknown } };
  'memory.turn': { input: { itemId: string; utterance: string; sequence: number; observedAt: string }; output: { context?: unknown } };
}

export type CoreOperation = keyof CoreOperationMap;
export interface CoreRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  browserRequest?: { sequence: number; response(call: string): void };
}
export interface CoreTransport {
  request<K extends CoreOperation>(operation: K, input: CoreOperationMap[K]['input'], options?: CoreRequestOptions): Promise<CoreOperationMap[K]['output']>;
}

export const coreHttpRoutes: Readonly<Record<CoreOperation, { path: string; method: 'GET' | 'POST' | 'DELETE' }>> = {
  'session.create': { path: 'session', method: 'POST' },
  'session.close': { path: 'session', method: 'DELETE' },
  'activity.get': { path: 'activity', method: 'GET' },
  'tool.invoke': { path: 'invoke', method: 'POST' },
  'browser.admit': { path: 'browser-admit', method: 'POST' },
  'browser.cancel': { path: 'browser-cancel', method: 'POST' },
  'browser.continuation': { path: 'browser-continuation', method: 'POST' },
  'browser.resume': { path: 'browser-resume', method: 'POST' },
  'browser.stall': { path: 'browser-stall', method: 'POST' },
  'confirmation.intent': { path: 'intent', method: 'POST' },
  'confirmation.decision': { path: 'decision', method: 'POST' },
  'confirmation.cancel': { path: 'cancel', method: 'POST' },
  'confirmation.visible': { path: 'confirmation-visible', method: 'POST' },
  'memory.context': { path: 'memory-context', method: 'POST' },
  'memory.turn': { path: 'memory-turn', method: 'POST' }
};

function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export class WebCoreTransport implements CoreTransport {
  private readonly fetcher: typeof fetch;
  constructor(fetcher?: typeof fetch) {
    this.fetcher = fetcher ?? ((input, init) => fetch(input, init));
  }

  async request<K extends CoreOperation>(operation: K, input: CoreOperationMap[K]['input'], options: CoreRequestOptions = {}): Promise<CoreOperationMap[K]['output']> {
    const route = coreHttpRoutes[operation];
    const browserRequest = options.browserRequest;
    const closeReason = operation === 'session.close' ? (input as CoreOperationMap['session.close']['input']).reason : undefined;
    const response = await this.fetcher(`/api/tools/${route.path}`, {
      method: route.method,
      headers: {
        'Content-Type': 'application/json',
        ...(browserRequest ? { 'X-Atlas-Browser-Request': String(browserRequest.sequence) } : {}),
        ...(closeReason ? { 'X-Atlas-Session-Close': closeReason } : {})
      },
      ...(input === undefined || operation === 'session.close' ? {} : { body: JSON.stringify(input) }),
      signal: requestSignal(options.timeoutMs ?? 30_000, options.signal)
    });
    if (!response.ok) throw new Error('No se pudo contactar con las herramientas. Reconecta si la sesión caducó.');
    const call = response.headers.get('X-Atlas-Browser-Call');
    if (browserRequest && call && /^b[1-9]\d{0,8}$/.test(call)) browserRequest.response(call);
    return response.json() as Promise<CoreOperationMap[K]['output']>;
  }
}
