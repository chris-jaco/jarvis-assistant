export interface RealtimeTokenProvider { token(signal?: AbortSignal): Promise<string> }

export class RealtimeTokenError extends Error {}

export class WebRealtimeTokenProvider implements RealtimeTokenProvider {
  private readonly request: typeof fetch;
  constructor(request?: typeof fetch) {
    this.request = request ?? ((input, init) => fetch(input, init));
  }
  async token(signal?: AbortSignal): Promise<string> {
    const response = await this.request('/api/realtime/token', { method: 'POST', ...(signal ? { signal } : {}) });
    const data: unknown = await response.json();
    if (!response.ok) {
      const message = typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string' ? data.error : 'No se pudo autenticar la sesión.';
      throw new RealtimeTokenError(message);
    }
    if (typeof data !== 'object' || data === null || !('value' in data) || typeof data.value !== 'string' || !data.value.startsWith('ek_')) {
      throw new RealtimeTokenError('No se pudo autorizar esta conversación.');
    }
    return data.value;
  }
}
