import { observeTracer, observationFacts, type ObserveTrace } from '../../src/diagnostics/browser-observe.js';
import { replySchema, observationSchema } from '../../src/browser/attached/protocol.js';
import type { Request, Reply, BrowserTimings } from '../../src/browser/attached/protocol.js';
import type { Grant } from './controller.js';

// This boundary knows whether the content command was dispatched. Never turn
// a lost response into permission denial or a safe-to-retry stale ref.
async function contentRequestCore(api: Pick<typeof chrome, 'tabs' | 'scripting'>, epoch: () => string | undefined, id: number, grant: Grant, request: Request, trace:(raw:unknown)=>void): Promise<Reply> {
  let injection:'NOT_ATTEMPTED'|'INJECTED'|'FAILED'='NOT_ATTEMPTED';let initialization:'NOT_ATTEMPTED'|'OK'|'FAILED'='NOT_ATTEMPTED';let phase:'ACTIVATION'|'INJECTION'|'INIT'|'MESSAGE'|'VALIDATION'='ACTIVATION';
  let dispatched = false; const timings: BrowserTimings = {}; let stage = performance.now();
  const elapsed = () => Math.min(30_000, Math.max(0, Math.round(performance.now() - stage)));
  try {
    if (epoch() !== request.connectionEpoch || request.deadlineAt <= Date.now()) return { outcome: 'ERROR', code: 'ACCESS_DENIED' };
    await api.tabs.update(id, { active: true });
    stage = performance.now();phase='INJECTION';
    await api.scripting.executeScript({ target: { tabId: id, frameIds: [0] }, world: 'ISOLATED', files: ['content.js'] });
    injection='INJECTED';phase='INIT';
    timings.injectionMs = elapsed(); stage = performance.now();
    if (epoch() !== request.connectionEpoch || request.deadlineAt <= Date.now()) return { outcome: 'ERROR', code: 'ACCESS_DENIED', timings };
    const initialized = await api.tabs.sendMessage(id, { kind: 'init', access: { scopeId: grant.scopeId, tabId: grant.tabId, session: grant.session, epoch: request.connectionEpoch, origin: grant.origin, expiresAt: grant.expiresAt } }, { frameId: 0 });
    if (initialized?.completed !== true) throw new Error();
    initialization='OK';phase='MESSAGE';
    timings.initializationMs = elapsed(); stage = performance.now();
    dispatched = true;
    trace({stage:'CONTENT_TRANSPORT',injection,initialization,dispatch:'SENT',reply:'NOT_RECEIVED'});
    const raw=await api.tabs.sendMessage(id, request, { frameId: 0 });phase='VALIDATION';
    trace({stage:'CONTENT_TRANSPORT',injection,initialization,dispatch:'SENT',reply:'RECEIVED'});
    if(request.observeTrace&&request.operation==='observe')trace({stage:'OBSERVE_RESULT',...observationFacts(raw?.data),snapshotValid:observationSchema.safeParse(raw?.data).success,bindingCoherent:raw?.data?.tabId===grant.tabId&&raw?.data?.scopeId===grant.scopeId,outcome:raw?.outcome});
    const reply = replySchema.parse(raw);
    return { ...reply, timings: { ...reply.timings, ...timings, returnMs: Math.max(0, elapsed() - (reply.timings?.observationBuildMs ?? 0)) } };
  } catch (error) {
    const timed=error instanceof Error&&['TimeoutError','AbortError'].includes(error.name);
    if(phase==='INJECTION')injection='FAILED';if(phase==='INIT')initialization='FAILED';
    trace({stage:'CONTENT_TRANSPORT',injection,initialization,dispatch:dispatched?'SENT':'NOT_ATTEMPTED',reply:phase==='VALIDATION'?'RECEIVED':dispatched?timed?'TIMEOUT':'ERROR':'NOT_RECEIVED',failureReason:timed?'TIMEOUT':phase==='ACTIVATION'?'TAB_UNAVAILABLE':phase==='INJECTION'?'INJECTION_FAILED':phase==='INIT'?'INIT_REJECTED':phase==='VALIDATION'?'REPLY_INVALID':'MESSAGING_FAILED'});
    if (dispatched) return { outcome: 'ERROR', code: 'EXECUTION_UNKNOWN', timings };
    const tab = await api.tabs.get(id).catch(() => undefined);
    if (tab?.url) {
      try { if (new URL(tab.url).origin !== grant.origin) return { outcome: 'REQUIRES_USER_INTERACTION', handoffId: crypto.randomUUID(), reason: 'ORIGIN_PERMISSION', timings }; } catch { /* No proven origin change. */ }
    }
    // Existing origin access is not revoked merely because a document is loading.
    return { outcome: 'ERROR', code: 'CONTENT_UNAVAILABLE', timings };
  }
}

export async function contentRequest(api: Pick<typeof chrome, 'tabs' | 'scripting'>, epoch: () => string | undefined, id: number, grant: Grant, request: Request): Promise<Reply> {
 const rows:ObserveTrace[]=[];const trace=observeTracer(request.observeTrace===true&&request.operation==='observe',row=>{if(rows.length<10)rows.push({...row,boundary:'CONTENT'});});
 const reply=await contentRequestCore(api,epoch,id,grant,request,trace);
 return rows.length?{...reply,observeTrace:rows}:reply;
}
