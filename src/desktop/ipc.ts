import type { IpcMain } from 'electron';
import { coreHttpRoutes } from '../provider/core-transport.js';
import type { CoreOperation } from '../provider/core-transport.js';
import type { DesktopBackendClient } from './backend-client.js';

const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const operations = new Set(Object.keys(coreHttpRoutes));

export function registerDesktopIpc(ipcMain: Pick<IpcMain, 'handle' | 'on' | 'removeHandler' | 'removeAllListeners'>, client: DesktopBackendClient, trustedSender: (senderId: number) => boolean): () => void {
  const pending = new Map<string, AbortController>();
  ipcMain.handle('atlas:core-request', async (event, requestId: unknown, operation: unknown, input: unknown, options: unknown) => {
    if (!trustedSender(event.sender.id)) throw new Error('DESKTOP_SENDER_REJECTED');
    if (typeof requestId !== 'string' || !requestIdPattern.test(requestId) || typeof operation !== 'string' || !operations.has(operation) || pending.has(requestId)) throw new Error('DESKTOP_REQUEST_REJECTED');
    if (JSON.stringify(input)?.length > 16_384) throw new Error('DESKTOP_REQUEST_REJECTED');
    const parsedOptions = typeof options === 'object' && options !== null ? options as { timeoutMs?: unknown; browserSequence?: unknown } : {};
    const timeoutMs = parsedOptions.timeoutMs === undefined ? undefined : Number(parsedOptions.timeoutMs);
    const browserSequence = parsedOptions.browserSequence === undefined ? undefined : Number(parsedOptions.browserSequence);
    if ((timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)) || (browserSequence !== undefined && (!Number.isInteger(browserSequence) || browserSequence < 1 || browserSequence > 1_000_000_000))) throw new Error('DESKTOP_REQUEST_REJECTED');
    const controller = new AbortController(); pending.set(requestId, controller);
    try { return await client.request(operation as CoreOperation, input as never, { ...(timeoutMs ? { timeoutMs } : {}), ...(browserSequence ? { browserSequence } : {}) }, controller.signal); }
    finally { pending.delete(requestId); }
  });
  ipcMain.on('atlas:core-cancel', (event, requestId: unknown) => { if (trustedSender(event.sender.id) && typeof requestId === 'string' && requestIdPattern.test(requestId)) pending.get(requestId)?.abort(); });
  ipcMain.handle('atlas:realtime-token', event => {
    if (!trustedSender(event.sender.id)) throw new Error('DESKTOP_SENDER_REJECTED');
    return client.realtimeToken();
  });
  return () => {
    for (const controller of pending.values()) controller.abort(); pending.clear();
    ipcMain.removeHandler('atlas:core-request'); ipcMain.removeHandler('atlas:realtime-token'); ipcMain.removeAllListeners('atlas:core-cancel');
  };
}
