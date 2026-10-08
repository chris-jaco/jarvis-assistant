import { ConsequentialFoundation } from '../consequential/foundation.js';
import { draftContextSchema } from '../consequential/semantic.js';
import type { DraftContext } from '../consequential/semantic.js';
import { setTimeout as delay } from 'node:timers/promises';
import { observeTracer, observationFacts } from '../../diagnostics/browser-observe.js';
import type { BrowserExecutionState } from '../execution-state.js';
import { BrowserTaskDiagnostics } from '../../diagnostics/browser-task.js';
import { classifyTaskIntent, type TaskIntent } from '../task-intent.js';
import { canEndTask, endTaskSchema } from '../task-lifecycle.js';
import type { ContinuationReceipt, EndTaskRequest } from '../task-lifecycle.js';
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
const contextReadReasons: readonly string[] = ['UPSTREAM','TIMEOUT','OBSERVATION_REQUIRED','SNAPSHOT_EXPIRED','DOCUMENT_CHANGED','ELEMENT_CHANGED','SNAPSHOT_CONSUMED'];
interface ContextRecovery { status: 'READY' | 'REQUIRED' | 'RECOVERING' | 'INCONCLUSIVE'; attempts: number; ready: string | null }
interface Session { requestedIdentifiers?:string[]; drafts?:ConsequentialFoundation; observeRequestId?:string; intent?:TaskIntent; readAdmission?:string; inventory?:{admission:string;expires:number}; admission?:string; progress:Map<string,ActionRecord>; acknowledged:Set<string>; rejectionToken?:string; cancelled?:boolean; terminal?:boolean; contextRecovery?: ContextRecovery; accessCorrelation?:string; traceNext?:boolean; actionRecord?: ActionRecord; accessRevoked?: boolean; id: string; task: string; connection?: string; active?: string; tabs: Map<string, AuthorizedTab>; workflow?: Exclude<Reply, { outcome: 'OK' } | { outcome: 'ERROR' }>; ready?: string; observation?: { tabId: string; scopeId: string; documentId: string; snapshotId: string; refs: Set<string>; expires: number }; closed?: boolean; failures: number; uncertain?: boolean; invalidation?: BrowserConflictDetail['reason']; context: 'READY' | 'OBSERVATION_REQUIRED'; pendingStep?: string; pendingRecovery?: {signature:string;scopeId:string}; completed?: { key: string; result: unknown; record:ActionRecord }; knownRefs: Map<string, string>; lastObservation?: AttachedObservation; timings: BrowserTimings; tail: Promise<unknown>; deadline?: number }
export class BrowserWorkflow extends Error { constructor(readonly reply: Exclude<Reply, { outcome: 'OK' }>) { super(reply.outcome); } }
export class AttachedChromeProvider implements BrowserProvider {
  readonly attached = true; private scope = new AsyncLocalStorage<Session>(); private sessions = new Map<string, Session>();
  constructor(private readonly transport: BrowserTransport, private readonly enabled = true, private readonly configuredConnection?: string, private readonly diagnostics?: BrowserDiagnostics, private readonly accessDiagnostics?:PopupDiagnostics,private readonly taskDiagnostics=new BrowserTaskDiagnostics(),private readonly readPause=(ms:number,signal:AbortSignal)=>delay(ms,undefined,{signal})) {
    transport.subscribe((connection, event) => {
      const session = this.sessions.get(event.backendSessionId); if (!session || session.closed || session.connection !== connection) return;
      if(event.trace){session.accessCorrelation=event.trace.correlationId;session.traceNext=true;this.accessDiagnostics?.event(event.trace.correlationId,'backend_received');}
      session.inventory=undefined;session.drafts?.invalidateDrafts();
      if (event.event === 'accessRequired' && event.access) { session.workflow = event.access; session.observation = undefined; session.context = 'OBSERVATION_REQUIRED'; }
      if (event.event === 'accessGranted' || event.scopeId === session.tabs.get(session.active ?? '')?.scopeId) { session.observation = undefined; session.context = 'OBSERVATION_REQUIRED'; session.invalidation = 'DOCUMENT_CHANGED'; }
      if (event.event === 'accessGranted' && event.tab) { const reused=session.tabs.get(event.tab.id)?.scopeId===event.tab.scopeId; session.accessRevoked = false; if(!reused){session.failures = 0; session.pendingStep = undefined; session.pendingRecovery = undefined; session.completed = undefined; session.contextRecovery = undefined;} session.tabs.set(event.tab.id, event.tab); session.active = event.tab.id; if (session.workflow?.outcome === 'ACCESS_PENDING' && (!event.accessRequestId || event.accessRequestId === session.workflow.accessRequestId)) { session.workflow = undefined; session.ready = randomUUID(); } else if (session.workflow?.outcome === 'REQUIRES_USER_INTERACTION' && session.workflow.reason === 'ORIGIN_PERMISSION') { session.workflow = undefined; session.ready = randomUUID(); } }
      else if (event.event === 'accessRevoked') { if (event.accessRequestId && (session.workflow?.outcome !== 'ACCESS_PENDING' || session.workflow.accessRequestId !== event.accessRequestId)) return; session.accessRevoked = true; session.ready = undefined; for (const [id, tab] of session.tabs) if (tab.scopeId === event.scopeId) { session.tabs.delete(id); if (session.active === id) session.active = undefined; } session.workflow = undefined; }
    });
  }
  inSession<T>(id: string, work: () => Promise<T>): Promise<T> {
    let session = this.sessions.get(id); if (!session) { if (this.sessions.size >= 10) throw new ToolError('LIMIT'); session = { id, task: randomUUID(), progress:new Map(),acknowledged:new Set(),tabs: new Map(), failures: 0, context: 'OBSERVATION_REQUIRED', knownRefs: new Map(), timings: {}, tail: Promise.resolve() }; this.sessions.set(id, session); }
    if (session.closed) throw new ToolError('REJECTED'); return this.scope.run(session, work);
  }
  state(id: string) { const session = this.sessions.get(id); return session && !session.closed ? { taskId:session.task,continuation:this.receipt(session), workflow: session.workflow ?? null, ready: session.ready ?? null, accessRevoked: session.accessRevoked ?? false, actionOutcome:session.actionRecord?.result() ?? null, accessCorrelation:session.accessCorrelation ?? null, contextRecovery:session.contextRecovery ?? null } : { workflow: null, ready: null }; }
  private receipt(session:Session):ContinuationReceipt {return {taskId:session.task,tokens:[session.ready,session.contextRecovery?.status==='READY'?session.contextRecovery.ready:undefined,session.rejectionToken].filter((token):token is string=>!!token&&!session.acknowledged.has(token))};}
  acknowledge(receipt:ContinuationReceipt):void {const session=this.session();if(receipt.taskId!==session.task)return;const available=this.receipt(session).tokens;for(const token of receipt.tokens)if(available.includes(token))session.acknowledged.add(token);}
  async admitGoal(admission:string, utterance?:string,traceState:BrowserExecutionState='RUNNING'):Promise<boolean> {
    const session=this.session();await session.tail.catch(()=>{});
    if(session.admission===admission||session.workflow)return false;
    // A trusted new user turn starts a new progress ledger, not a new Chrome
    // permission. Never import an earlier objective's action as completion proof.
    session.drafts?.invalidateDrafts();session.requestedIdentifiers=[...new Set(utterance?.match(/[^\s<>@]+@[^\s<>@]+\.[a-zA-Z]{2,}|\+[1-9][0-9 ()-]{5,24}/g)??[])].slice(0,10);session.admission=admission;session.intent=classifyTaskIntent(utterance);session.readAdmission=undefined;session.inventory=undefined;session.progress.clear();session.terminal=false;session.cancelled=false;
    // New admission gets fresh operational context, never old completion proof.
    // Keep the uncertainty latch and Chrome consent/scopes intact.
    session.contextRecovery=undefined;session.observation=undefined;session.lastObservation=undefined;session.context='OBSERVATION_REQUIRED';session.completed=undefined;session.pendingStep=undefined;session.pendingRecovery=undefined;session.failures=0;session.rejectionToken=undefined;session.ready=undefined;
    this.traceTask({stage:'ADMISSION',taskId:session.task,admissionId:admission,intent:session.intent.intent,source:utterance?'TRANSCRIPT':'FALLBACK',taskState:traceState});
    return true;
  }
  private traceObserve(raw:unknown):void {if(!this.diagnostics?.enabled)return;const s=this.scope.getStore();if(!s||s.closed)return;observeTracer(this.diagnostics?.enabled===true)({boundary:'BACKEND',...(s.observeRequestId?{requestId:s.observeRequestId}:{}),...((raw&&typeof raw==='object')?raw:{}),taskId:s.task,...(s.admission?{admissionId:s.admission}:{})});}
  private traceTask(raw:unknown):void {this.taskDiagnostics.enabled=this.diagnostics?.enabled===true;this.taskDiagnostics.event(raw);}
  cancelFromUser():void {this.session().cancelled=true;}
  terminalFailure():void {this.session().terminal=true;}
  private session(): Session { const session = this.scope.getStore(); if (!session || session.closed) throw new ToolError('REJECTED'); return session; }
  private async connection(session: Session, signal: AbortSignal): Promise<string> {
    if (!this.enabled || this.transport.configuration?.().configured === false) throw new ToolError('UNCONFIGURED');
    const connections = this.transport.waitForConnections ? await this.transport.waitForConnections(signal) : this.transport.connections();
    if (session.connection && connections.includes(session.connection)) return session.connection;
    // A new connection never inherits scopes. Multiple connections need explicit selection.
    session.drafts?.invalidateDrafts();session.tabs.clear(); session.active = undefined; session.observation = undefined;
    const selected = this.configuredConnection ? connections.find(id => id === this.configuredConnection) : connections.length === 1 ? connections[0] : undefined;
    if (!selected) throw new ToolError(connections.length > 1 ? 'AMBIGUOUS' : 'UPSTREAM'); session.connection = selected; return selected;
  }
  private async call(operation: Operation, args: Record<string, unknown>, signal: AbortSignal): Promise<Reply> {
    const session = this.session();if(session.traceNext&&session.accessCorrelation&&!['status','listAuthorizedTabs'].includes(operation)){session.traceNext=false;this.accessDiagnostics?.event(session.accessCorrelation,'next_task_tool','START');} const deadlineAt = Math.min(Date.now() + 17_000, session.deadline ?? Infinity);
    if (['click','type','press','media','scroll','navigate','back','forward','reload'].includes(operation)) this.allowAction(session);
    const connection = await this.connection(session, signal);
    if (signal.aborted || deadlineAt <= Date.now()) throw new ToolError('TIMEOUT');
    const request = parseRequest({ protocol: 'atlas.browser', version: 1, kind: 'request', requestId: randomUUID(), backendSessionId: session.id, taskId: session.task, connectionEpoch: this.transport.epoch, deadlineAt, operation, args, ...(this.diagnostics?.enabled?{observeTrace:true}:{}) });
    if(operation==='observe'&&this.diagnostics?.enabled)session.observeRequestId=request.requestId;
    let reply: Reply; const transportStarted = performance.now(); let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const dispatchedAction = ['click','type','press','media','scroll','navigate','back','forward','reload'].includes(operation);
    const abortedAfterDispatch = () => { if (dispatchedAction) session.uncertain = true; rejectAbort(new ToolError(dispatchedAction ? 'EXECUTION_UNKNOWN' : 'TIMEOUT')); };
    signal.addEventListener('abort', abortedAfterDispatch, { once: true });
    try { const waiting = this.transport.request(connection, request, signal); if (signal.aborted) abortedAfterDispatch(); reply = replySchema.parse(await Promise.race([waiting, aborted])); }
    catch { if(operation==='observe')this.traceObserve({stage:'OBSERVE_RESULT',outcome:'ERROR',contextState:session.context,failureReason:signal.aborted?'TIMEOUT':'UPSTREAM'}); if (dispatchedAction) session.uncertain = true; throw new ToolError(dispatchedAction ? 'EXECUTION_UNKNOWN' : signal.aborted ? 'TIMEOUT' : 'UPSTREAM'); }
    finally { signal.removeEventListener('abort', abortedAfterDispatch); }
    for(const row of reply.observeTrace??[])this.traceObserve({...row,requestId:request.requestId});
    // Diagnostics terminate here, never becoming model/workflow input.
    if(reply.observeTrace){const {observeTrace:_trace,...semantic}=reply;reply=semantic as Reply;}
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
    session.inventory={admission:session.admission??'',expires:Math.min(Date.now()+15000,...tabs.map(tab=>tab.expiresAt))};
    return tabs.map(tab => ({ id: tab.id, title: tab.title, url: tab.url, active: tab.id === session.active }));
  }
  async getActiveTab(signal: AbortSignal): Promise<BrowserTab | null> { return (await this.listTabs(signal)).find(tab => tab.active) ?? null; }
  async switchTab(id: string, signal: AbortSignal): Promise<BrowserTab> { const session = this.session(); const tab = session.tabs.get(id); if (!tab) throw new ToolError('REJECTED'); this.unwrap(await this.call('activate', { scopeId: tab.scopeId, tabId: id }, signal)); session.active = id; session.observation = undefined; return { id, title: tab.title, url: tab.url, active: true }; }
  async closeTab(_id: string, _signal: AbortSignal): Promise<void> { throw new ToolError('REJECTED'); } // Personal tabs may contain unsaved work; manual only.
  async openTab(url: string, signal: AbortSignal): Promise<BrowserTab> {
    navigationUrl(url); const reply = await this.requestTabAccess({ target: { kind: 'new', url }, purpose: 'Abrir y usar esta pestaña para la tarea solicitada', lifetime: 'task' }, signal);
    const opened=reply.outcome==='ACCESS_PENDING'?await this.call('openTab',{accessRequestId:reply.accessRequestId},signal):reply;
    // These replies acknowledge tab creation; authorization remains separate.
    // Track the existing operation's structural progress without adding actions.
    if(opened.outcome==='OK'||opened.outcome==='ACCESS_PENDING'){
      const record=new ActionRecord({kind:'navigation',target:url});record.executed();
      const session=this.session();session.actionRecord=record;session.progress.set(record.actionId,record);
    }
    return this.unwrap(opened);
  }
  async navigate(url: string, signal: AbortSignal): Promise<BrowserTab> { navigationUrl(url); this.session().observation = undefined; this.unwrap(await this.call('navigate', { ...this.binding(), url }, signal)); const tab = this.session().tabs.get(this.session().active ?? '')!; return { id: tab.id, title: tab.title, url: tab.url, active: true }; }
  async observe(signal: AbortSignal): Promise<BrowserObservation> { const session = this.session(); const work = session.tail.catch(() => {}).then(() => this.observeWithResume(signal)); session.tail = work; return work; }
  private async observeWithResume(signal: AbortSignal, handoffId?: string): Promise<z.infer<typeof observationSchema>> {
    const session = this.session(); if(this.diagnostics?.enabled)session.observeRequestId=undefined; const recoveryBefore=session.contextRecovery?.status??'NONE'; session.observation = undefined; session.context = 'OBSERVATION_REQUIRED';
    if(this.diagnostics?.enabled){const tab=session.tabs.get(session.active??'');this.traceObserve({stage:'OBSERVE_AUTH',taskGrant:session.accessRevoked?'REVOKED':!tab?'MISSING':tab.expiresAt<=Date.now()?'EXPIRED':'PRESENT'});let available=true;try{this.binding();}catch{available=false;}if(!available)this.traceObserve({stage:'OBSERVE_RESULT',outcome:'ERROR',contextState:session.context,failureReason:'BINDING_UNAVAILABLE'});}
    const reply = await this.call('observe', { ...this.binding(), ...(handoffId ? { resumeHandoffId: handoffId } : {}) }, signal);
    if(this.diagnostics?.enabled)this.traceObserve({stage:'OBSERVE_RESULT',outcome:reply.outcome,...(reply.outcome==='OK'?observationFacts(reply.data):{}),snapshotValid:reply.outcome==='OK'&&observationSchema.safeParse(reply.data).success,contextState:session.context,failureReason:reply.outcome==='ERROR'?reply.code:reply.outcome==='OK'?observationSchema.safeParse(reply.data).success?'NONE':'SNAPSHOT_INVALID':reply.outcome==='REQUIRES_USER_INTERACTION'?reply.reason:'OBSERVATION_REQUIRED'});
    const data = observationSchema.parse(this.unwrap(reply));
    if (signal.aborted) {this.traceObserve({stage:'OBSERVE_RESULT',outcome:'ERROR',contextState:session.context,failureReason:'TIMEOUT'});throw new ToolError('TIMEOUT');}
    if (data.expiresAt - Date.now() <= 250) { this.traceObserve({stage:'OBSERVE_RESULT',outcome:'OK',snapshotValid:true,...observationFacts(data),contextState:'OBSERVATION_REQUIRED',failureReason:'SNAPSHOT_EXPIRED'}); session.observation = undefined; session.context = 'OBSERVATION_REQUIRED'; throw new ToolError('CONFLICT', { reason: 'SNAPSHOT_EXPIRED', execution: 'NOT_EXECUTED', recoverable: session.failures < 3, remainingRecoveries: Math.max(0, Math.min(2, 3 - session.failures)) }); }
    session.lastObservation = data; session.context = 'READY';session.terminal=false; const tab = session.tabs.get(data.tabId); if (tab) { tab.title = data.title; tab.url = data.url; }
    for (const element of data.elements) session.knownRefs.set(element.ref, JSON.stringify([data.scopeId, element.role, element.name, element.type, element.action]));
    while (session.knownRefs.size > 160) session.knownRefs.delete(session.knownRefs.keys().next().value!);
    session.readAdmission=session.admission;
    session.observation = { tabId: data.tabId, scopeId: data.scopeId, documentId: data.documentId, snapshotId: data.snapshotId, refs: new Set(data.elements.map(el => el.ref)), expires: data.expiresAt }; if (handoffId) { session.workflow = undefined; session.ready = randomUUID(); } session.actionRecord?.observe({status:'OK',data});
    if (session.contextRecovery && ['REQUIRED','RECOVERING','INCONCLUSIVE'].includes(session.contextRecovery.status)) session.contextRecovery = { ...session.contextRecovery, status:'READY', ready:randomUUID() };
    this.traceObserve({stage:'OBSERVE_RESULT',outcome:'OK',snapshotValid:true,...observationFacts(data),bindingCoherent:data.tabId===session.active&&data.scopeId===session.tabs.get(session.active??'')?.scopeId,contextState:session.context,failureReason:'NONE'});
    this.traceObserve({stage:'WORKFLOW_TRANSITION',from:recoveryBefore,to:session.contextRecovery?.status??'NONE',failureReason:'FRESH_CONTEXT',attempts:session.contextRecovery?.attempts??0});
    if(session.drafts){try{session.drafts.reconcileDrafts(this.draftContext(data));}catch{session.drafts.invalidateDrafts();}}
    return data;
  }
  private draftContext(data:AttachedObservation):DraftContext {
    const session=this.session(),tab=session.tabs.get(session.active??'');
    // Successful extension observe attests all three existing permission layers.
    // Bind that evidence to this exact backend admission and operational scope.
    if(session.uncertain||session.cancelled||session.workflow||session.accessRevoked||!session.admission||!session.connection||!this.transport.connections().includes(session.connection)||!tab||tab.id!==data.tabId||tab.scopeId!==data.scopeId||!data.conversationContext||new URL(data.url).origin!==data.conversationContext.origin)throw new ToolError('REJECTED');
    return draftContextSchema.parse({backendSessionId:session.id,taskId:session.task,admissionId:session.admission,connectionEpoch:this.transport.epoch,origin:data.conversationContext.origin,scopeId:data.scopeId,tabId:data.tabId,documentId:data.documentId,snapshotId:data.snapshotId,snapshotExpiresAt:data.expiresAt,grantExpiresAt:tab.expiresAt,chromePermission:true,siteAuthorized:true,grantValid:true,requestedIdentifiers:session.requestedIdentifiers??[],semantic:data.conversationContext});
  }
  async prepareDraft(input:unknown,signal:AbortSignal):Promise<unknown> {
    const session=this.session();
    const epoch=this.transport.epoch;const data=await this.observeWithResume(signal);
    if(epoch!==this.transport.epoch)throw new ToolError('REJECTED');
    if(!data.conversationContext)return {status:'INSUFFICIENT_EVIDENCE',candidateCount:0,draftOnly:true};
    const context=this.draftContext(data);signal.throwIfAborted();
    session.drafts??=ConsequentialFoundation.drafts(session.id);
    return session.drafts.prepareDraft(input,context,signal);
  }
  async reviewDraft(intentId:string,signal:AbortSignal):Promise<unknown> {
    const session=this.session();if(!session.drafts)throw new ToolError('EXPIRED');
    try{const epoch=this.transport.epoch;const data=await this.observeWithResume(signal);signal.throwIfAborted();if(epoch!==this.transport.epoch)throw new ToolError('REJECTED');return session.drafts.reviewDraft(intentId,this.draftContext(data));}
    catch(error){session.drafts.invalidateDrafts();throw error;}
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
    if (deadlineAt <= Date.now()) { if(this.canRecoverContext()) this.session().contextRecovery = {status:'RECOVERING',attempts:this.session().contextRecovery?.attempts ?? 0,ready:null}; return { status: 'FAILED', reason: 'TIMEOUT' }; }
    const remaining = deadlineAt - Date.now();
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
    try { return { status: 'OK', data: await this.observeWithResume(bounded) }; }
    catch (error) {
      this.session().observation = undefined; this.session().context = 'OBSERVATION_REQUIRED';
      const reason = error instanceof BrowserWorkflow ? error.reply.outcome === 'ERROR' ? error.reply.code : error.reply.outcome === 'REQUIRES_USER_INTERACTION' ? error.reply.reason : 'OBSERVATION_REQUIRED'
        : error instanceof ToolError ? error.browserRecovery?.reason ?? error.category : 'UPSTREAM';
      this.session().actionRecord?.observe({status:'FAILED',reason:'UPSTREAM'});
      const before=this.session().contextRecovery?.status??'NONE';
      if (this.canRecoverContext()) {
        const recovery = this.session().contextRecovery ?? {status:'REQUIRED' as const,attempts:0,ready:null};
        if (!contextReadReasons.includes(reason)) recovery.status='INCONCLUSIVE';
        else if (recovery.status === 'READY') recovery.status = 'REQUIRED';
        this.session().contextRecovery = recovery;
      }
      this.traceObserve({stage:'OBSERVE_RESULT',outcome:'ERROR',contextState:this.session().context,failureReason:reason});
      this.traceObserve({stage:'WORKFLOW_TRANSITION',from:before,to:this.session().contextRecovery?.status??'NONE',failureReason:reason,attempts:this.session().contextRecovery?.attempts??0});
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
      const signature=JSON.stringify([operation,parameters]);
      if (session.pendingStep && session.pendingStep !== key) {
        // Same frozen operation/parameters, explicitly supplied CURRENT ref only.
        // Never map an old ref or allow another action to reset this step budget.
        const fresh=session.pendingRecovery?.signature===signature && typeof ref==='string' && session.observation?.scopeId===session.pendingRecovery.scopeId && session.observation.refs.has(ref);
        if (!fresh) throw new ToolError('REJECTED', undefined, { status: 'FAILED', reason: 'STEP_PENDING' });
      }
      if (session.completed?.key === key) {
        session.actionRecord=session.completed.record;
        // Consecutive duplicate of a completed action: return completion, never
        // execute it again even if its post-action READ failed.
        const observation = session.context === 'READY' && session.lastObservation && session.lastObservation.expiresAt - Date.now() > 250
          ? { status: 'OK' as const, data: session.lastObservation } : await this.recoverReads(signal, deadlineAt, {status:'FAILED',reason:'UPSTREAM'});
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
          session.pendingRecovery=undefined;
          const observation = error.browserRecovery.recoverable ? await this.refresh(signal, deadlineAt) : { status: 'FAILED' as const, reason: error.browserRecovery.reason };
          // Permit only the same step/scope with a ref from the current fresh READ.
          // Unknown execution and exhausted budgets can never gain this permit.
          if (error.category !== 'EXECUTION_UNKNOWN' && error.browserRecovery.execution === 'NOT_EXECUTED' && error.browserRecovery.recoverable && !session.uncertain && observation.status==='OK') session.pendingRecovery={signature,scopeId:observation.data.scopeId};
          throw new ToolError(error.category, error.browserRecovery, observation, this.measurements());
        }
        if (!(error instanceof ToolError && error.category === 'EXECUTION_UNKNOWN')) session.pendingStep = undefined; session.pendingRecovery = undefined;
        throw error;
      }
      // Commit completion before READ. Nothing after this point can change it
      // into a failed/uncertain action, or cause execute() to run a second time.
      record.executed();session.terminal=false;
      if (operation!=='switch') {session.progress.set(record.actionId,record);while(session.progress.size>100)session.progress.delete(session.progress.keys().next().value!);}
      session.contextRecovery = {status:'READY',attempts:0,ready:null};
      session.completed = { key, result,record }; session.pendingStep = undefined; session.pendingRecovery = undefined; session.failures = 0;
      session.observation = undefined; session.context = 'OBSERVATION_REQUIRED'; session.invalidation = 'SNAPSHOT_CONSUMED';
      const observation = await this.recoverReads(signal, deadlineAt, await this.refresh(signal, deadlineAt));
      return { action: { status: 'COMPLETED' as const }, result, observation, actionOutcome:record.result(), requiresFreshObservation: observation.status !== 'OK' };
    });
    const finished = work.finally(() => { session.deadline = undefined; });
    session.tail = finished; return finished;
  }
  // Context recovery is independent of optional effect verification. Only READ
  // callbacks live here; execute() is never retained or called by recovery.
  private canRecoverContext(): boolean {
    const session = this.session(); const tab = session.tabs.get(session.active ?? '');
    return session.actionRecord?.result().execution === 'EXECUTED' && !session.uncertain && !session.accessRevoked && !session.closed && !session.workflow && !!tab && tab.expiresAt > Date.now();
  }
  private async recoverReads(signal: AbortSignal, deadlineAt: number, initial: ObservationResult): Promise<ObservationResult> {
    const session = this.session();
    if (initial.status === 'OK') {
      if (session.observation && session.observation.expires-Date.now()>250 && session.context==='READY') session.contextRecovery={status:'READY',attempts:session.contextRecovery?.attempts??0,ready:session.contextRecovery?.ready??null};
      return initial;
    }
    if (!this.canRecoverContext()) return initial;
    if (!contextReadReasons.includes(initial.reason)) return initial;
    session.contextRecovery ??= {status:'REQUIRED', attempts:0, ready:null};
    // A cancelled caller cannot authorize another READ. A later fresh request
    // may spend the remaining budget; we never lengthen its execution deadline.
    this.traceObserve({stage:'WORKFLOW_TRANSITION',from:session.contextRecovery.status,to:'RECOVERING',failureReason:initial.reason,attempts:session.contextRecovery.attempts});
    session.contextRecovery.status = 'RECOVERING';
    let observation: ObservationResult = initial;
    while (session.contextRecovery.attempts < 2 && !signal.aborted && Date.now() < deadlineAt && this.canRecoverContext()) {
      // Let the new document/content boundary settle between failed READs.
      // Only READs are retained here. No action callback is available to retry.
      const pauseMs = Math.min(session.contextRecovery.attempts === 0 ? 500 : 1000, Math.max(0,deadlineAt-Date.now()));
      try { await this.readPause(pauseMs,signal); } catch { return {status:'FAILED',reason:'TIMEOUT'}; }
      if (signal.aborted || Date.now()>=deadlineAt || !this.canRecoverContext()) return observation;
      ++session.contextRecovery.attempts;
      observation = await this.refresh(signal, deadlineAt);
      if (observation.status === 'OK') return observation;
      if (!contextReadReasons.includes(observation.reason)) break;
    }
    if (this.canRecoverContext() && session.contextRecovery.attempts >= 2) {this.traceObserve({stage:'WORKFLOW_TRANSITION',from:session.contextRecovery.status,to:'INCONCLUSIVE',failureReason:'READ_BUDGET_EXHAUSTED',attempts:session.contextRecovery.attempts});session.contextRecovery.status = 'INCONCLUSIVE';}
    return observation;
  }
  async recoverContext(signal: AbortSignal): Promise<{observation:ObservationResult; actionOutcome:ReturnType<ActionRecord['result']> | null; contextRecovery:ContextRecovery | null}> {
    const session = this.session();
    const work = session.tail.catch(()=>{}).then(async()=>{
      const fresh=session.context==='READY'&&session.observation&&session.lastObservation&&session.observation.expires-Date.now()>250;
      const observation = await this.recoverReads(signal, Date.now()+8000, fresh ? {status:'OK',data:session.lastObservation!} : {status:'FAILED',reason:'UPSTREAM'});
      return {observation,actionOutcome:session.actionRecord?.result() ?? null,contextRecovery:session.contextRecovery ?? null};
    }); session.tail=work; return work;
  }
  async verify(signal:AbortSignal):Promise<unknown> {
    const session=this.session(); const work=session.tail.catch(()=>{}).then(async()=>{
      const record=session.actionRecord;
      const decision=record?.verificationRead() ?? 'NOT_APPLICABLE';
      if (decision !== 'READ') return {step:decision,actionOutcome:record?.result() ?? null};
      const deadlineAt=Date.now()+8000;
      const observation=await this.recoverReads(signal,deadlineAt,await this.refresh(signal,deadlineAt));
      return {step:observation.status==='OK' && record!.result().outcome==='ACTION_VERIFIED'?'VERIFIED':'INCONCLUSIVE',actionOutcome:record!.result(),observation};
    });session.tail=work;return work;
  }
  async click(ref: string, signal: AbortSignal): Promise<void> { this.unwrap(await this.call('click', this.ref(ref), signal)); }
  async type(ref: string, text: string, mode: 'replace' | 'append', signal: AbortSignal): Promise<void> { this.unwrap(await this.call('type', { ...this.ref(ref), text, mode }, signal)); }
  async press(ref: string, key: BrowserKey, signal: AbortSignal): Promise<void> { this.unwrap(await this.call('press', { ...this.ref(ref), key }, signal)); }
  async media(ref: string, action: 'play' | 'pause', signal: AbortSignal): Promise<unknown> { return this.unwrap(await this.call('media', { ...this.ref(ref), action }, signal)); }
  async scroll(direction: 'up' | 'down', signal: AbortSignal): Promise<void> { this.session().observation = undefined; this.unwrap(await this.call('scroll', { ...this.binding(), direction }, signal)); }
  private async history(operation: 'back' | 'forward' | 'reload', signal: AbortSignal): Promise<BrowserTab> { this.session().observation = undefined; this.unwrap(await this.call(operation, this.binding(), signal)); const tab = this.session().tabs.get(this.session().active ?? '')!; return { id: tab.id, title: tab.title, url: tab.url, active: true }; }
  back(signal: AbortSignal) { return this.history('back', signal); } forward(signal: AbortSignal) { return this.history('forward', signal); } reload(signal: AbortSignal) { return this.history('reload', signal); }
  async endTask(signal: AbortSignal, raw:EndTaskRequest = {}, confirmation=false): Promise<unknown> {
    const session=this.session(),request=endTaskSchema.parse(raw);
    const record=[...session.progress.values()].at(-1);
    const evidence=request.evidence?.actionId ? session.progress.get(request.evidence.actionId) : record&&session.progress.get(record.actionId);
    const tab=session.tabs.get(session.active??'');
    const guardStarted=performance.now();
    const facts={
      intent:session.intent?.intent??'ACTION_REQUIRED' as const,
      readObtained:!!session.admission&&(session.intent?.intent==='READ_ONLY'&&session.intent.context==='TABS'?session.inventory?.admission===session.admission:session.readAdmission===session.admission),
      progress:!!evidence && evidence===record && evidence.result().execution==='EXECUTED',
      pending:confirmation||!!session.workflow||!!session.pendingStep||this.receipt(session).tokens.length>0||!!session.contextRecovery&&['REQUIRED','RECOVERING'].includes(session.contextRecovery.status),
      unknown:!!session.uncertain||record?.result().execution==='UNKNOWN',
      fresh:session.intent?.intent==='READ_ONLY'&&session.intent.context==='TABS'?!!session.inventory&&session.inventory.expires-Date.now()>250&&!session.accessRevoked:session.context==='READY'&&!!session.observation&&session.observation.expires-Date.now()>250&&!!tab&&tab.expiresAt>Date.now(),
      verificationRequired:!!record?.verifiable,verified:record?.result().outcome==='ACTION_VERIFIED',verificationExhausted:!!record?.verificationExhausted,
      cancelled:!!session.cancelled,terminal:!!session.terminal||!!session.accessRevoked||session.workflow?.outcome==='REQUIRES_USER_INTERACTION',
      recoveryExhausted:session.contextRecovery?.status==='INCONCLUSIVE'&&session.contextRecovery.attempts>=2
    };
    const accepted=canEndTask(request,facts);
    this.traceTask({stage:'END_TASK_GUARD',phase:'GUARD',taskId:session.task,admissionId:session.admission,call:this.diagnostics?.callId(),requestedReason:request.reason,outcome:accepted?'ACCEPTED':'REJECTED',...(accepted?{}:{reason:'OBJECTIVE_PENDING'}),guardMs:Math.min(30000,performance.now()-guardStarted),guard:facts});
    if(!accepted){session.rejectionToken??=randomUUID();return {outcome:'END_TASK_REJECTED',reason:'OBJECTIVE_PENDING'};}
    const transportStarted=performance.now();
    try{this.unwrap(await this.call('endTask', {}, signal));}
    catch(error){this.traceTask({stage:'END_TASK',phase:'TRANSPORT',taskId:session.task,admissionId:session.admission,call:this.diagnostics?.callId(),requestedReason:request.reason,outcome:'ERROR',transportMs:Math.min(30000,performance.now()-transportStarted)});throw error;}
    this.traceTask({stage:'END_TASK',phase:'TRANSPORT',taskId:session.task,admissionId:session.admission,call:this.diagnostics?.callId(),requestedReason:request.reason,outcome:'ACCEPTED',transportMs:Math.min(30000,performance.now()-transportStarted)});
    session.drafts?.invalidateDrafts();session.admission=undefined;session.intent=undefined;session.readAdmission=undefined;session.inventory=undefined;session.accessRevoked=false;session.task=randomUUID();session.progress.clear();session.acknowledged.clear();session.rejectionToken=undefined;session.cancelled=false;session.terminal=false;
    session.pendingStep=undefined;session.pendingRecovery=undefined;session.completed=undefined;session.failures=0;session.observation=undefined;session.workflow=undefined;session.ready=undefined;session.contextRecovery=undefined;
    // No fallible post-close READ may undo accepted task termination.
    session.tabs.clear();session.active=undefined;
    return {outcome:'END_TASK_ACCEPTED',reason:request.reason};
  }
  async revokeTabAccess(tabId: string, signal: AbortSignal): Promise<unknown> { const session = this.session(); const tab = session.tabs.get(tabId); if (!tab) throw new ToolError('REJECTED'); this.unwrap(await this.call('revokeTabAccess', { scopeId: tab.scopeId }, signal)); session.drafts?.invalidateDrafts();session.tabs.delete(tabId); session.observation = undefined; return { revoked: true }; }
  async endSession(id: string): Promise<void> {
    const session = this.sessions.get(id); if (!session) return;
    const connection = session.connection;session.drafts?.invalidateDrafts(); session.closed = true; session.observation = undefined; this.sessions.delete(id);
    if (connection && this.transport.connections().includes(connection)) {
      const request = parseRequest({ protocol: 'atlas.browser', version: 1, kind: 'request', requestId: randomUUID(), backendSessionId: id, taskId: session.task, connectionEpoch: this.transport.epoch, deadlineAt: Date.now() + 2000, operation: 'endSession', args: {} });
      await this.transport.request(connection, request, AbortSignal.timeout(2000));
    }
  }
  disconnect(): Promise<void> { return this.close(); }
  async close(): Promise<void> { for (const id of [...this.sessions.keys()]) await this.endSession(id).catch(() => {}); this.transport.close(); }
}
