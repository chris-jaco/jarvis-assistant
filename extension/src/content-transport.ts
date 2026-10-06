import { replySchema } from '../../src/browser/attached/protocol.js';
import type { Request, Reply, BrowserTimings } from '../../src/browser/attached/protocol.js';
import type { Grant } from './controller.js';

// This boundary knows whether the content command was dispatched. Never turn
// a lost response into permission denial or a safe-to-retry stale ref.
export async function contentRequest(api: Pick<typeof chrome, 'tabs' | 'scripting'>, epoch: () => string | undefined, id: number, grant: Grant, request: Request): Promise<Reply> {
  let dispatched = false; const timings: BrowserTimings = {}; let stage = performance.now();
  const elapsed = () => Math.min(30_000, Math.max(0, Math.round(performance.now() - stage)));
  try {
    if (epoch() !== request.connectionEpoch || request.deadlineAt <= Date.now()) return { outcome: 'ERROR', code: 'ACCESS_DENIED' };
    await api.tabs.update(id, { active: true });
    stage = performance.now();
    await api.scripting.executeScript({ target: { tabId: id, frameIds: [0] }, world: 'ISOLATED', files: ['content.js'] });
    timings.injectionMs = elapsed(); stage = performance.now();
    if (epoch() !== request.connectionEpoch || request.deadlineAt <= Date.now()) return { outcome: 'ERROR', code: 'ACCESS_DENIED', timings };
    const initialized = await api.tabs.sendMessage(id, { kind: 'init', access: { scopeId: grant.scopeId, tabId: grant.tabId, session: grant.session, epoch: request.connectionEpoch, origin: grant.origin, expiresAt: grant.expiresAt } }, { frameId: 0 });
    if (initialized?.completed !== true) throw new Error();
    timings.initializationMs = elapsed(); stage = performance.now();
    dispatched = true;
    const reply = replySchema.parse(await api.tabs.sendMessage(id, request, { frameId: 0 }));
    return { ...reply, timings: { ...reply.timings, ...timings, returnMs: Math.max(0, elapsed() - (reply.timings?.observationBuildMs ?? 0)) } };
  } catch {
    if (dispatched) return { outcome: 'ERROR', code: 'EXECUTION_UNKNOWN', timings };
    const tab = await api.tabs.get(id).catch(() => undefined);
    if (tab?.url) {
      try { if (new URL(tab.url).origin !== grant.origin) return { outcome: 'REQUIRES_USER_INTERACTION', handoffId: crypto.randomUUID(), reason: 'ORIGIN_PERMISSION', timings }; } catch { /* No proven origin change. */ }
    }
    // Existing origin access is not revoked merely because a document is loading.
    return { outcome: 'ERROR', code: 'CONTENT_UNAVAILABLE', timings };
  }
}
