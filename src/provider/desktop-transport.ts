import type { CoreOperation, CoreOperationMap, CoreRequestOptions, CoreTransport } from './core-transport.js';
import { RealtimeTokenError } from './realtime-token.js';
import type { RealtimeTokenProvider } from './realtime-token.js';

function api() {
  if (!window.atlasDesktop) throw new Error('ATLAS_DESKTOP_BRIDGE_UNAVAILABLE');
  return window.atlasDesktop;
}

export class DesktopCoreTransport implements CoreTransport {
  async request<K extends CoreOperation>(operation: K, input: CoreOperationMap[K]['input'], options: CoreRequestOptions = {}): Promise<CoreOperationMap[K]['output']> {
    const requestId = crypto.randomUUID();
    const abort = () => api().core.cancel(requestId);
    if (options.signal?.aborted) { abort(); throw options.signal.reason; }
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      const reply = await api().core.request(requestId, operation, input, {
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.browserRequest ? { browserSequence: options.browserRequest.sequence } : {})
      });
      if (reply.browserCall && options.browserRequest) options.browserRequest.response(reply.browserCall);
      return reply.data as CoreOperationMap[K]['output'];
    } finally { options.signal?.removeEventListener('abort', abort); }
  }
}

export class DesktopRealtimeTokenProvider implements RealtimeTokenProvider {
  async token(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw signal.reason;
    try { return await api().realtime.token(); }
    catch (error) { throw new RealtimeTokenError(error instanceof Error ? error.message : 'No se pudo autenticar la sesión.'); }
  }
}
