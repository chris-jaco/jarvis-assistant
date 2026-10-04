import { ToolError } from '../types.js';
import type { GmailAccounts } from './gmail-accounts.js';
export interface GmailTransport { request(accountId: string, method: string, path: string, body: unknown, signal: AbortSignal): Promise<unknown> }
export class GoogleGmailTransport implements GmailTransport {
  constructor(private readonly accounts: GmailAccounts, private readonly requestFetch: typeof fetch = fetch) {}
  async request(accountId: string, method: string, path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    const token = await this.accounts.token(accountId); signal.throwIfAborted();
    const response = await this.requestFetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { method, signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    // Exactly one request: never retry a send whose outcome may be uncertain.
    if (!response.ok) throw new ToolError(response.status === 404 ? 'CONFLICT' : 'UPSTREAM');
    if (response.status === 204) return {};
    const reader = response.body?.getReader(); if (!reader) throw new ToolError('UPSTREAM');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.length; if (bytes > 24 * 1024 * 1024) throw new ToolError('LIMIT'); chunks.push(next.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } finally { await reader.cancel().catch(() => undefined); }
  }
}
