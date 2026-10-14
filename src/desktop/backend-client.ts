import { DESKTOP_AUTH_HEADER } from '../server/desktop-auth.js';
import { coreHttpRoutes } from '../provider/core-transport.js';
import type { CoreOperation, CoreOperationMap } from '../provider/core-transport.js';
import type { DesktopCoreReply, DesktopRequestOptions } from './api.js';

export class DesktopBackendClient {
  private cookie = '';
  private active = true;
  constructor(private readonly baseUrl: string, private secret: string, private readonly fetcher: typeof fetch = fetch) {}

  private async call(path: string, init: RequestInit, timeoutMs = 30_000, signal?: AbortSignal): Promise<Response> {
    if (!this.active) throw new Error('DESKTOP_BACKEND_CLOSED');
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...init.headers, [DESKTOP_AUTH_HEADER]: this.secret, ...(this.cookie ? { Cookie: this.cookie } : {}) },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';', 1)[0] ?? '';
    return response;
  }

  async health(signal?: AbortSignal): Promise<void> {
    const response = await this.call('/api/desktop/health', { method: 'GET' }, 5_000, signal);
    if (!response.ok || (await response.json() as { ready?: unknown }).ready !== true) throw new Error('DESKTOP_BACKEND_NOT_READY');
  }

  async request<K extends CoreOperation>(operation: K, input: CoreOperationMap[K]['input'], options: DesktopRequestOptions = {}, signal?: AbortSignal): Promise<DesktopCoreReply<K>> {
    const route = coreHttpRoutes[operation];
    if (!route) throw new Error('DESKTOP_OPERATION_DENIED');
    const closeReason = operation === 'session.close' ? (input as CoreOperationMap['session.close']['input']).reason : undefined;
    const response = await this.call(`/api/tools/${route.path}`, {
      method: route.method,
      headers: {
        'Content-Type': 'application/json',
        ...(options.browserSequence === undefined ? {} : { 'X-Atlas-Browser-Request': String(options.browserSequence) }),
        ...(closeReason ? { 'X-Atlas-Session-Close': closeReason } : {})
      },
      ...(input === undefined || operation === 'session.close' ? {} : { body: JSON.stringify(input) })
    }, options.timeoutMs ?? 30_000, signal);
    if (!response.ok) throw new Error('No se pudo contactar con las herramientas. Reconecta si la sesión caducó.');
    if (operation === 'session.close') this.cookie = '';
    const browserCall = response.headers.get('X-Atlas-Browser-Call');
    return { data: await response.json() as CoreOperationMap[K]['output'], ...(browserCall && /^b[1-9]\d{0,8}$/.test(browserCall) ? { browserCall } : {}) };
  }

  async realtimeToken(signal?: AbortSignal): Promise<string> {
    const response = await this.call('/api/realtime/token', { method: 'POST' }, 30_000, signal);
    const data = await response.json() as { value?: unknown; error?: unknown };
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'No se pudo autenticar la sesión.');
    if (typeof data.value !== 'string' || !data.value.startsWith('ek_')) throw new Error('No se pudo autorizar esta conversación.');
    return data.value;
  }

  async shutdown(): Promise<void> {
    if (!this.active) return;
    try { await this.call('/api/desktop/shutdown', { method: 'POST' }, 1_000); } catch { /* Supervisor owns the fallback termination. */ }
    this.active = false; this.cookie = ''; this.secret = '';
  }

  dispose(): void { this.active = false; this.cookie = ''; this.secret = ''; }
}
