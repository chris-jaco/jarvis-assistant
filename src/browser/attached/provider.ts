import type { PopupDiagnostics } from '../../diagnostics/popup.js';
import { ActionRecord } from '../action-outcome.js';
import type { z } from 'zod';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ToolError } from '../../tools/types.js';
import { navigationUrl } from '../policy.js';
import type { BrowserDiagnostics } from '../diagnostics.js';
import type { BrowserProvider, BrowserTab, BrowserObservation, BrowserKey, BrowserStatus } from '../provider.js';
import { parseRequest, observationSchema, replySchema } from './protocol.js';
import type { Operation, Reply, AuthorizedTab, BrowserConflictDetail, AttachedObservation, ObservationResult, InteractionResult, BrowserTimings } from './protocol.js';
import type { BrowserTransport } from './transport.js';
interface Session { accessCorrelation?:string; traceNext?:boolean; actionRecord?: ActionRecord; accessRevoked?: boolean; id: string; task: string; connection?: string; active?: string; tabs: Map<string, AuthorizedTab>; workflow?: Exclude<Reply, { outcome: 'OK' } | { outcome: 'ERROR' }>; ready?: string; observation?: { tabId: string; scopeId: string; documentId: string; snapshotId: string; refs: Set<string>; expires: number }; closed?: boolean; failures: number; uncertain?: boolean; invalidation?: BrowserConflictDetail['reason']; context: 'READY' | 'OBSERVATION_REQUIRED'; pendingStep?: string; completed?: { key: string; result: unknown; record:ActionRecord }; knownRefs: Map<string, string>; lastObservation?: AttachedObservation; timings: BrowserTimings; tail: Promise<unknown>; deadline?: number }
export class BrowserWorkflow extends Error { constructor(readonly reply: Exclude<Reply, { outcome: 'OK' }>) { super(reply.outcome); } }
export class AttachedChromeProvider implements BrowserProvider {
  readonly attached = true; private scope = new AsyncLocalStorage<Session>(); private sessions = new Map<string, Session>();
  constructor(private readonly transport: BrowserTransport, private readonly enabled = true, private readonly configuredConnection?: string, private readonly diagnostics?: BrowserDiagnostics, private readonly accessDiagnostics?:PopupDiagnostics) {
    transport.subscribe((connection, event) => {
      const session = this.sessions.get(event.backendSessionId); if (!session || session.closed || session.connection !== connection) return;
      if(event.trace){session.accessCorrelation=event.trace.correlationId;session.traceNext=true;this.accessDiagnostics?.event(event.trace.correlationId,'backend_received');}
      if (event.event === 'accessRequired' && event.access) { session.workflow = event.access; session.observation = undefined; session.context = 'OBSERVATION_REQUIRED'; }
      if (event.event === 'accessGranted' || event.scopeId === session.tabs.get(session.active ?? '')?.scopeId) { session.observation = undefined; session.context = 'OBSERVATION_REQUIRED'; session.invalidation = 'DOCUMENT_CHANGED'; }
      if (event.event === 'accessGranted' && event.tab) { session.accessRevoked = false; session.failures = 0; session.pendingStep = undefined; session.completed = undefined; session.tabs.set(event.tab.id, event.tab); session.active = event.tab.id; if (session.workflow?.outcome === 'ACCESS_PENDING' && (!event.accessRequestId || event.accessRequestId === session.workflow.accessRequestId)) { session.workflow = undefined; session.ready = randomUUID(); } else if (session.workflow?.outcome === 'REQUIRES_USER_INTERACTION' && session.workflow.reason === 'ORIGIN_PERMISSION') { session.workflow = undefined; session.ready = randomUUID(); } }
      else if (event.event === 'accessRevoked') { if (event.accessRequestId && (session.workflow?.outcome !== 'ACCESS_PENDING' || session.workflow.accessRequestId !== event.accessRequestId)) return; session.accessRevoked = true; session.ready = undefined; for (const [id, tab] of session.tabs) if (tab.scopeId === event.scopeId) { session.tabs.delete(id); if (session.active === id) session.active = undefined; } session.workflow = undefined; }
    });
  }
  inSession<T>(id: string, work: () => Promise<T>): Promise<T> {
    let session = this.sessions.get(id); if (!session) { if (this.sessions.size >= 10) throw new ToolError('LIMIT'); session = { id, task: randomUUID(), tabs: new Map(), failures: 0, context: 'OBSERVATION_REQUIRED', knownRefs: new Map(), timings: {}, tail: Promise.resolve() }; this.sessions.set(id, session); }
    if (session.closed) throw new ToolError('REJECTED'); return this.scope.run(session, work);
  }
  state(id: string) { const session = this.sessions.get(id); return session && !session.closed ? { workflow: session.workflow ?? null, ready: session.ready ?? null, accessRevoked: session.accessRevoked ?? false, actionOutcome:session.actionRecord?.result() ?? null, accessCorrelation:session.accessCorrelation ?? null } : { workflow: null, ready: null }; }
  private session(): Session { const session = this.scope.getStore(); if (!session || session.closed) throw new ToolError('REJECTED'); return session; }
  private async connection(session: Session, signal: AbortSignal): Promise<string> {
    if (!this.enabled || this.transport.configuration?.().configured === false) throw new ToolError('UNCONFIGURED');
    const connections = this.transport.waitForConnections ? await this.transport.waitForConnections(signal) : this.transport.connections();
    if (session.connection && connections.includes(session.connection)) return session.connection;
    // A new connection never inherits scopes. Multiple connections need explicit selection.
    session.tabs.clear(); session.active = undefined; session.observation = undefined;
    const selected = this.configuredConnection ? connections.find(id => id === this.configuredConnection) : connections.length === 1 ? connections[0] : undefined;
    if (!selected) throw new ToolError(connections.length > 1 ? 'AMBIGUOUS' : 'UPSTREAM'); session.connection = selected; return selected;
  }
  private async call(operation: Operation, args: Record<string, unknown>, signal: AbortSignal): Promise<Reply> {
    const session = this.session();if(session.traceNext&&session.accessCorrelation&&!['status','listAuthorizedTabs'].includes(operation)){session.traceNext=false;this.accessDiagnostics?.event(session.accessCorrelation,'next_task_tool','START');} const deadlineAt = Math.min(Date.now() + 17_000, session.deadline ?? Infinity);
    if (['click','type','press','media','scroll','navigate','back','forward','reload'].includes(operation)) this.allowAction(session);
    const connection = await this.connection(session, signal);
    if (signal.aborted || deadlineAt <= Date.now()) throw new ToolError('TIMEOUT');
    const request = parseRequest({ protocol: 'atlas.browser', version: 1, kind: 'request', requestId: randomUUID(), backendSessionId: session.id, taskId: session.task, connectionEpoch: this.transport.epoch, deadlineAt, operation, args });
    let reply: Reply; const transportStarted = performance.now(); let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const dispatchedAction = ['click','type','press','media','scroll','navigate','back','forward','reload'].includes(operation);
    const abortedAfterDispatch = () => { if (dispatchedAction) session.uncertain = true; rejectAbort(new ToolError(dispatchedAction ? 'EXECUTION_UNKNOWN' : 'TIMEOUT')); };
    signal.addEventListener('abort', abortedAfterDispatch, { once: true });
    try { const waiting = this.transport.request(connection, request, signal); if (signal.aborted) abortedAfterDispatch(); reply = replySchema.parse(await Promise.race([waiting, aborted])); }
    catch { if (dispatchedAction) session.uncertain = true; throw new ToolError(dispatchedAction ? 'EXECUTION_UNKNOWN' : signal.aborted ? 'TIMEOUT' : 'UPSTREAM'); }
    finally { signal.removeEventListener('abort', abortedAfterDispatch); }
    if (dispatchedAction && reply.outcome === 'ERROR' && ['EXECUTION_UNKNOWN','DISCONNECTED','TIMEOUT'].includes(reply.code)) session.uncertain = true;
    const measured = { ...reply.timings, transportMs: Math.min(30_000, Math.max(0, Math.round(performance.now() - transportStarted))) };
    for (const [key, duration] of Object.entries(measured)) { const field = key as keyof BrowserTimings; session.timings[field] = Math.min(30_000, (session.timings[field] ?? 0) + duration); }
    this.diagnostics?.metadata(measured, reply.outcome === 'ERROR' ? reply.conflict?.reason : undefined);
    if (session.closed) throw new ToolError('REJECTED');
    if (reply.outcome === 'ACCESS_PENDING' || reply.outcome === 'REQUIRES_USER_INTERACTION') session.workflow = reply;
    return reply;
  }
  private unwrap<T>(reply: Reply): T {
    if (reply.outcome === 'OK') return reply.data as T;
    if (reply.outcome === 'ERROR' && ['EXECUTION_UNKNOWN','DISCONNECTED'].includes(reply.code)) throw new ToolError('EXECUTION_UNKNOWN');
    if (reply.outcome === 'ERROR' && reply.code === 'CONTENT_UNAVAILABLE') throw new ToolError('UPSTREAM');
    if (reply.outcome === 'ERROR' && reply.code === 'STALE_REF' && reply.conflict) this.conflict(reply.conflict.reason);
    if (reply.outcome === 'ERROR') throw new ToolError(reply.code === 'STALE_REF' ? 'CONFLICT' : reply.code === 'EXPIRED' ? 'EXPIRED' : reply.code === 'INVALID_INPUT' ? 'INVALID_INPUT' : reply.code === 'TIMEOUT' ? 'TIMEOUT' : 'REJECTED');
    throw new BrowserWorkflow(reply);
  }
  private binding(): { scopeId: string; tabId: string } { const session = this.session(); const tab = session.tabs.get(session.active ?? ''); if (!tab || tab.expiresAt <= Date.now()) throw new ToolError('REJECTED'); return { scopeId: tab.scopeId, tabId: tab.id }; }
  async status(): Promise<BrowserStatus> { const connections = this.enabled ? this.transport.connections() : []; return { available: this.enabled, connected: connections.length > 0, visible: true, connections, ...(!this.enabled ? { reason: 'disabled' as const } : connections.length === 0 ? { reason: 'unavailable' as const } : {}) }; }
  async ensureBrowser(_signal: AbortSignal): Promise<BrowserStatus> { return this.status(); }
  async requestTabAccess(input: { target: { kind: 'current' } | { kind: 'new'; url: string }; purpose: string; lifetime: 'task' | 'session' }, signal: AbortSignal): Promise<Reply> { this.session().accessRevoked = false; const reply = await this.call('requestTabAccess', input, signal); if (reply.outcome === 'ERROR') this.unwrap(reply); return reply; }
  async listAuthorizedTabs(signal: AbortSignal): Promise<BrowserTab[]> { return this.listTabs(signal); }
  async listTabs(signal: AbortSignal): Promise<BrowserTab[]> {
    const tabs = this.unwrap<AuthorizedTab[]>(await this.call('listAuthorizedTabs', {}, signal)); const session = this.session(); session.tabs = new Map(tabs.map(tab => [tab.id, tab])); if (!session.tabs.has(session.active ?? '')) session.active = tabs[0]?.id;
    return tabs.map(tab => ({ id: tab.id, title: tab.title, url: tab.url, active: tab.id === session.active }));
  }
  async getActiveTab(signal: AbortSignal): Promise<BrowserTab | null> { return (await this.listTabs(signal)).find(tab => tab.active) ?? null; }
  async switchTab(id: string, signal: AbortSignal): Promise<BrowserTab> { const session = this.session(); const tab = session.tabs.get(id); if (!tab) throw new ToolError('REJECTED'); this.unwrap(await this.call('activate', { scopeId: tab.scopeId, tabId: id }, signal)); session.active = id; session.observation = undefined; return { id, title: tab.title, url: tab.url, active: true }; }
  async closeTab(_id: string, _signal: AbortSignal): Promise<void> { throw new ToolError('REJECTED'); } // Personal tabs may contain unsaved work; manual only.
  async openTab(url: string, signal: AbortSignal): Promise<BrowserTab> {
    navigationUrl(url); const reply = await this.requestTabAccess({ target: { kind: 'new', url }, purpose: 'Abrir y usar esta pestaña para la tarea solicitada', lifetime: 'task' }, signal);
    if (reply.outcome !== 'ACCESS_PENDING') return this.unwrap(reply);
    return this.unwrap(await this.call('openTab', { accessRequestId: reply.accessRequestId }, signal));
  }
  async navigate(url: string, signal: AbortSignal): Promise<BrowserTab> { navigationUrl(url); this.session().observation = undefined; this.unwrap(await this.call('navigate', { ...this.binding(), url }, signal)); const tab = this.session().tabs.get(this.session().active ?? '')!; return { id: tab.id, title: tab.title, url: tab.url, active: true }; }
  async observe(signal: AbortSignal): Promise<BrowserObservation> { const session = this.session(); const work = session.tail.catch(() => {}).then(() => this.observeWithResume(signal)); session.tail = work; return work; }
  private async observeWithResume(signal: AbortSignal, handoffId?: string): Promise<z.infer<typeof observationSchema>> {
    const session = this.session(); session.observation = undefined; session.context = 'OBSERVATION_REQUIRED';
    const reply = await this.call('observe', { ...this.binding(), ...(handoffId ? { resumeHandoffId: handoffId } : {}) }, signal);
    const data = observationSchema.parse(this.unwrap(reply));
    if (signal.aborted) throw new ToolError('TIMEOUT');
    if (data.expiresAt - Date.now() <= 250) { session.observation = undefined; session.context = 'OBSERVATION_REQUIRED'; throw new ToolError('CONFLICT', { reason: 'SNAPSHOT_EXPIRED', execution: 'NOT_EXECUTED', recoverable: session.failures < 3, remainingRecoveries: Math.max(0, Math.min(2, 3 - session.failures)) }); }
    session.lastObservation = data; session.context = 'READY'; const tab = session.tabs.get(data.tabId); if (tab) { tab.title = data.title; tab.url = data.url; }
    for (const element of data.elements) session.knownRefs.set(element.ref, JSON.stringify([data.scopeId, element.role, element.name, element.type, element.action]));
    while (session.knownRefs.size > 160) session.knownRefs.delete(session.knownRefs.keys().next().value!);
    session.observation = { tabId: data.tabId, scopeId: data.scopeId, documentId: data.documentId, snapshotId: data.snapshotId, refs: new Set(data.elements.map(el => el.ref)), expires: data.expiresAt }; if (handoffId) { session.workflow = undefined; session.ready = randomUUID(); } session.actionRecord?.observe({status:'OK',data});return data;
  }
  async resume(handoffId: string, signal: AbortSignal): Promise<Reply> {
    const session = this.session(); if (session.workflow?.outcome !== 'REQUIRES_USER_INTERACTION' || session.workflow.handoffId !== handoffId) throw new ToolError('REJECTED');
    try { const data = await this.observeWithResume(signal, handoffId); return { outcome: 'OK', data }; } catch (error) { if (error instanceof BrowserWorkflow) return error.reply; throw error; }
  }
  private allowAction(session: Session): void {
    if (session.uncertain) throw new ToolError('EXECUTION_UNKNOWN');
    if (session.failures > 2) throw new ToolError('CONFLICT', { reason: session.invalidation ?? 'ELEMENT_CHANGED', execution: 'NOT_EXECUTED', recoverable: false, remainingRecoveries: 0 });
  }
  private conflict(reason: BrowserConflictDetail['reason']): never {
    const session = this.session(); session.observation = undefined; session.context = 'OBSERVATION_REQUIRED'; session.invalidation = reason;
    ++session.failures;
    throw new ToolError('CONFLICT', { reason, execution: 'NOT_EXECUTED', recoverable: session.failures <= 2, remainingRecoveries: Math.max(0, 3 - session.failures) });
  }
  private ref(ref: string): Record<string, unknown> {
    const session = this.session(); this.binding(); this.allowAction(session); const snapshot = session.observation;
    if (!snapshot) this.conflict(session.invalidation ?? 'SNAPSHOT_CONSUMED');
    if (snapshot.expires - Date.now() <= 250) this.conflict('SNAPSHOT_EXPIRED');
    if (!snapshot.refs.has(ref)) this.conflict('SNAPSHOT_CONSUMED');
    const binding = { scopeId: snapshot.scopeId, tabId: snapshot.tabId, documentId: snapshot.documentId, snapshotId: snapshot.snapshotId, ref };
    session.observation = undefined; session.context = 'OBSERVATION_REQUIRED'; session.invalidation = 'SNAPSHOT_CONSUMED'; return binding;
  }
  measurements(): BrowserTimings { return { ...this.session().timings }; }
  resetMeasurements(): void { this.session().timings = {}; }
  private async refresh(signal: AbortSignal, deadlineAt: number): Promise<ObservationResult> {
    if (deadlineAt <= Date.now()) return { status: 'FAILED', reason: 'TIMEOUT' };
    const remaining = deadlineAt - Date.now();
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
    try { return { status: 'OK', data: await this.observeWithResume(bounded) }; }
    catch (error) {
      this.session().observation = undefined; this.session().context = 'OBSERVATION_REQUIRED';
      const reason = error instanceof BrowserWorkflow ? error.reply.outcome === 'ERROR' ? error.reply.code : error.reply.outcome === 'REQUIRES_USER_INTERACTION' ? error.reply.reason : 'OBSERVATION_REQUIRED'
        : error instanceof ToolError ? error.browserRecovery?.reason ?? error.category : 'UPSTREAM';
      this.session().actionRecord?.observe({status:'FAILED',reason:'UPSTREAM'});
      return { status: 'FAILED', reason: reason === 'CONFLICT' || reason === 'UNCONFIGURED' || reason === 'LIMIT' || reason === 'AMBIGUOUS' ? 'OBSERVATION_REQUIRED' : reason };
    }
  }
  async interact(operation: string, input: unknown, execute: () => Promise<unknown>, signal: AbortSignal): Promise<InteractionResult> {
    const session = this.session(); const deadlineAt = Date.now() + 17_000;
    const work = session.tail.catch(() => {}).then(async () => {
      if (signal.aborted || deadlineAt <= Date.now()) throw new ToolError('TIMEOUT');
      session.deadline = deadlineAt;
      const args = input as Record<string, unknown>; const { ref, ...parameters } = args;
      const target = typeof ref === 'string' ? session.knownRefs.get(ref) ?? 'unknown-ref' : session.active;
      // Private step identity never appears in telemetry. Refs are not remapped.
      const key = JSON.stringify([operation, target, parameters]);
      this.binding();
      if (session.uncertain) throw new ToolError('EXECUTION_UNKNOWN');
      if (session.pendingStep && session.pendingStep !== key) throw new ToolError('REJECTED', undefined, { status: 'FAILED', reason: 'STEP_PENDING' });
      if (session.completed?.key === key) {
        session.actionRecord=session.completed.record;
        // Consecutive duplicate of a completed action: return completion, never
        // execute it again even if its post-action READ failed.
        const observation = session.context === 'READY' && session.lastObservation && session.lastObservation.expiresAt - Date.now() > 250
          ? { status: 'OK' as const, data: session.lastObservation } : await this.refresh(signal, deadlineAt);
        return { action: { status: 'COMPLETED' as const }, result: session.completed.result, observation, actionOutcome: session.actionRecord!.result(), requiresFreshObservation: observation.status !== 'OK' };
      }
      session.pendingStep = key;
      const record = new ActionRecord(operation === 'media' ? {kind:parameters.action as 'play'|'pause',tabId:session.lastObservation?.tabId,scopeId:session.lastObservation?.scopeId,documentId:session.lastObservation?.documentId} : operation === 'navigate' ? {kind:'navigation',target:String(parameters.url)} : undefined);
      session.actionRecord=record;
      let result: unknown;
      try { result = await execute(); }
      catch (error) {
        if (error instanceof ToolError && (error.category === 'EXECUTION_UNKNOWN'||session.uncertain)) record.unknown();
        if (error instanceof ToolError && error.browserRecovery) {
          const observation = error.browserRecovery.recoverable ? await this.refresh(signal, deadlineAt) : { status: 'FAILED' as const, reason: error.browserRecovery.reason };
          throw new ToolError(error.category, error.browserRecovery, observation, this.measurements());
        }
        if (!(error instanceof ToolError && error.category === 'EXECUTION_UNKNOWN')) session.pendingStep = undefined;
        throw error;
      }
      // Commit completion before READ. Nothing after this point can change it
      // into a failed/uncertain action, or cause execute() to run a second time.
      record.executed();
      session.completed = { key, result,record }; session.pendingStep = undefined; session.failures = 0;
      session.observation = undefined; session.context = 'OBSERVATION_REQUIRED'; session.invalidation = 'SNAPSHOT_CONSUMED';
      const observation = await this.refresh(signal, deadlineAt);
      return { action: { status: 'COMPLETED' as const }, result, observation, actionOutcome:record.result(), requiresFreshObservation: observation.status !== 'OK' };
    });
    const finished = work.finally(() => { session.deadline = undefined; });
    session.tail = finished; return finished;
  }
  async verify(signal:AbortSignal):Promise<unknown>{const session=this.session();const work=session.tail.catch(()=>{}).then(async()=>{if(!session.actionRecord?.claimRead())throw new ToolError('LIMIT');const observation=await this.refresh(signal,Date.now()+8000);return {actionOutcome:session.actionRecord.result(),observation};});session.tail=work;return work;}
  async click(ref: string, signal: AbortSignal): Promise<void> { this.unwrap(await this.call('click', this.ref(ref), signal)); }
  async type(ref: string, text: string, mode: 'replace' | 'append', signal: AbortSignal): Promise<void> { this.unwrap(await this.call('type', { ...this.ref(ref), text, mode }, signal)); }
  async press(ref: string, key: BrowserKey, signal: AbortSignal): Promise<void> { this.unwrap(await this.call('press', { ...this.ref(ref), key }, signal)); }
  async media(ref: string, action: 'play' | 'pause', signal: AbortSignal): Promise<unknown> { return this.unwrap(await this.call('media', { ...this.ref(ref), action }, signal)); }
  async scroll(direction: 'up' | 'down', signal: AbortSignal): Promise<void> { this.session().observation = undefined; this.unwrap(await this.call('scroll', { ...this.binding(), direction }, signal)); }
  private async history(operation: 'back' | 'forward' | 'reload', signal: AbortSignal): Promise<BrowserTab> { this.session().observation = undefined; this.unwrap(await this.call(operation, this.binding(), signal)); const tab = this.session().tabs.get(this.session().active ?? '')!; return { id: tab.id, title: tab.title, url: tab.url, active: true }; }
  back(signal: AbortSignal) { return this.history('back', signal); } forward(signal: AbortSignal) { return this.history('forward', signal); } reload(signal: AbortSignal) { return this.history('reload', signal); }
  async endTask(signal: AbortSignal): Promise<unknown> { const session = this.session(); this.unwrap(await this.call('endTask', {}, signal)); session.accessRevoked = false; session.task = randomUUID(); session.pendingStep = undefined; session.completed = undefined; session.failures = 0; session.observation = undefined; session.workflow = undefined; session.ready = undefined; await this.listTabs(signal); return { completed: true }; }
  async revokeTabAccess(tabId: string, signal: AbortSignal): Promise<unknown> { const session = this.session(); const tab = session.tabs.get(tabId); if (!tab) throw new ToolError('REJECTED'); this.unwrap(await this.call('revokeTabAccess', { scopeId: tab.scopeId }, signal)); session.tabs.delete(tabId); session.observation = undefined; return { revoked: true }; }
  async endSession(id: string): Promise<void> {
    const session = this.sessions.get(id); if (!session) return;
    const connection = session.connection; session.closed = true; session.observation = undefined; this.sessions.delete(id);
    if (connection && this.transport.connections().includes(connection)) {
      const request = parseRequest({ protocol: 'atlas.browser', version: 1, kind: 'request', requestId: randomUUID(), backendSessionId: id, taskId: session.task, connectionEpoch: this.transport.epoch, deadlineAt: Date.now() + 2000, operation: 'endSession', args: {} });
      await this.transport.request(connection, request, AbortSignal.timeout(2000));
    }
  }
  disconnect(): Promise<void> { return this.close(); }
  async close(): Promise<void> { for (const id of [...this.sessions.keys()]) await this.endSession(id).catch(() => {}); this.transport.close(); }
}
