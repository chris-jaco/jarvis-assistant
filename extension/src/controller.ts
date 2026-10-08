import { observeTracer, type ObserveTrace } from '../../src/diagnostics/browser-observe.js';
import type { PopupDiagnostics } from '../../src/diagnostics/popup.js';
import { parseRequest, replySchema, helloSchema, cancelSchema } from '../../src/browser/attached/protocol.js';
import type { Request, Reply, AuthorizedTab } from '../../src/browser/attached/protocol.js';
import { navigationUrl, displayUrl, privateText } from '../../src/browser/policy.js';
import { siteOrigin } from './site-authorization.js';
import type { SiteAuthorization } from './site-authorization.js';
export interface Surface {
  observeAuthorization?(grant:Grant):Promise<Pick<ObserveTrace,'chromePermission'|'persistentPolicy'|'sameOrigin'>>;
  tab?(id: number): Promise<{ id: number; url?: string; title?: string; status?: string; pendingUrl?: string }>;
  current(): Promise<{ id: number; url: string; title: string }>;
  create(url: string): Promise<number>;
  activate(tab: number): Promise<void>;
  navigate(tab: number, url: string): Promise<void>;
  history(tab: number, action: 'back' | 'forward' | 'reload'): Promise<void>;
  content(tab: number, grant: Grant, request: Request): Promise<Reply>;
  invalidate(tab: number, documentOnly?: boolean): Promise<void>;
}
export interface Grant { scopeId: string; tabId: string; chromeId: number; origin: string; session: string; task: string; expiresAt: number; lifetime: 'task' | 'session'; title: string; url: string; handoff?: { id: string; reason: Extract<Reply, { outcome: 'REQUIRES_USER_INTERACTION' }>['reason'] }; suspended?: boolean; persistent?: boolean }
interface Ticket { id: string; request: Request; expiresAt: number; chromeId?: number; origin?: string; priorScope?: string; tabId?: string }
export class ExtensionController {
  epoch?: string; readonly grants = new Map<string, Grant>(); readonly tickets = new Map<string, Ticket>();
  private results = new Map<string, { signature: string; result: Promise<Reply>; session: string }>();
  private cancelled = new Set<string>(); private ended = new Set<string>(); private endedTasks = new Set<string>(); private tail: Promise<unknown> = Promise.resolve();
  private retiredScopes=new Map<string,'REVOKED'|'EXPIRED'>();
  private approving = false; private activeTasks = new Set<string>();
  constructor(private readonly surface: Surface, private readonly emit: (event: unknown) => void, private readonly now = Date.now, private readonly id = () => crypto.randomUUID(), private readonly sites?: Pick<SiteAuthorization, 'allows' | 'allowAlways'>, private readonly diagnostics?:PopupDiagnostics, private readonly pause = (ms:number):Promise<void> => new Promise(resolve => setTimeout(resolve,ms))) {}
  async reset(raw?: unknown): Promise<void> {
    this.epoch = raw === undefined ? undefined : helloSchema.parse(raw).connectionEpoch;
    this.retiredScopes.clear();
    const old = [...this.grants.values()]; this.grants.clear(); this.tickets.clear(); this.results.clear(); this.cancelled.clear(); this.ended.clear(); this.endedTasks.clear(); this.activeTasks.clear();
    await Promise.all(old.map(grant => this.surface.invalidate(grant.chromeId).catch(() => {})));
  }
  cancel(raw: unknown): void {
    const message = cancelSchema.parse(raw);
    if (message.connectionEpoch !== this.epoch) return;
    const result = this.results.get(message.requestId);
    if (!result || result.session !== message.backendSessionId) return;
    this.cancelled.add(message.requestId);
    for (const [id, ticket] of this.tickets) if (ticket.request.requestId === message.requestId) this.tickets.delete(id);
  }
  private check(request: Request): void { if (request.connectionEpoch !== this.epoch || this.ended.has(request.backendSessionId) || this.endedTasks.has(request.backendSessionId + ':' + request.taskId)) throw new Error('ACCESS_DENIED'); if (this.cancelled.has(request.requestId) || request.deadlineAt <= this.now()) throw new Error('TIMEOUT'); }
  receive(raw: unknown): Promise<Reply> {
    let request: Request; try { request = parseRequest(raw); } catch { return Promise.resolve({ outcome: 'ERROR', code: 'INVALID_INPUT' }); }
    if (request.connectionEpoch !== this.epoch || request.deadlineAt > this.now() + 30_000) return Promise.resolve({ outcome: 'ERROR', code: 'ACCESS_DENIED' });
    const signature = JSON.stringify(request); const previous = this.results.get(request.requestId);
    if (previous) return previous.signature === signature ? previous.result : Promise.resolve({ outcome: 'ERROR', code: 'REJECTED' });
    if (this.results.size >= 1000) return Promise.resolve({ outcome: 'ERROR', code: 'REJECTED' });
    const queuedAt = performance.now();
    const result = this.tail.catch(() => {}).then(async (): Promise<Reply> => {
      const queueMs = Math.min(30_000, Math.max(0, Math.round(performance.now() - queuedAt)));
      const rows:ObserveTrace[]=[];const trace=observeTracer(request.observeTrace===true&&request.operation==='observe',row=>rows.push(row));
      const decorate=(reply:Reply):Reply=>rows.length?{...reply,observeTrace:[...rows,...(reply.observeTrace??[])].slice(0,12)}:reply;
      try { this.check(request); if(request.observeTrace&&request.operation==='observe')await this.observeAuthorization(request,trace); const readyUntil=Math.min(request.deadlineAt,this.now()+2000);
        let reply = await this.execute(request,trace);
        // Only observation/readiness is repeated. execute() rechecks every scope
        // and permission before injection; actions never enter this loop.
        for(let attempt=0;request.operation==='observe' && attempt<2 && reply.outcome==='ERROR' && reply.code==='CONTENT_UNAVAILABLE' && this.now()<readyUntil;++attempt){
          const failed=reply.observeTrace?.slice().reverse().find(row=>row.failureReason&&row.failureReason!=='NONE');
          trace(failed??{stage:'CONTENT_TRANSPORT',boundary:'EXTENSION',failureReason:'DOCUMENT_INITIALIZING'});
          await this.pause(Math.min(attempt===0?500:1000,readyUntil-this.now()));
          this.check(request);
          if(this.now()>=readyUntil)break;
          reply=await this.execute(request,trace);
        } if (!['endSession', 'endTask'].includes(request.operation)) this.check(request); return replySchema.parse(decorate({ ...reply, timings: { ...reply.timings, queueMs } })); }
      catch (error) { const code = error instanceof Error ? error.message : ''; return decorate({ outcome: 'ERROR', code: ['TIMEOUT', 'ACCESS_DENIED', 'EXPIRED', 'STALE_REF', 'REJECTED'].includes(code) ? code as 'REJECTED' : 'UNSUPPORTED' }); }
    });
    this.tail = result; this.results.set(request.requestId, { signature, result, session: request.backendSessionId }); return result;
  }
  private async observeAuthorization(request:Request,trace:(raw:unknown)=>void):Promise<void> {
    const grant=this.grants.get(String(request.args.scopeId));
    const taskGrant:ObserveTrace['taskGrant']=!grant?this.retiredScopes.get(String(request.args.scopeId))??'MISSING':grant.expiresAt<=this.now()?'EXPIRED':grant.suspended||grant.handoff||grant.session!==request.backendSessionId||grant.lifetime==='task'&&grant.task!==request.taskId||grant.tabId!==request.args.tabId?'INCOMPATIBLE':'PRESENT';
    let facts:Pick<ObserveTrace,'chromePermission'|'persistentPolicy'|'sameOrigin'>={};let failureReason:ObserveTrace['failureReason']='NONE';
    if(grant&&taskGrant==='PRESENT'&&this.surface.observeAuthorization)try{facts=await this.surface.observeAuthorization(grant);}catch{failureReason='AUTH_DIAGNOSTIC_UNAVAILABLE';}
    trace({stage:'OBSERVE_AUTH',boundary:'EXTENSION',taskGrant,...facts,failureReason});
  }
  private dto(grant: Grant): AuthorizedTab { return { id: grant.tabId, scopeId: grant.scopeId, title: grant.title, url: grant.url, active: false, expiresAt: grant.expiresAt, state: grant.suspended ? 'SUSPENDED_ORIGIN' : grant.handoff ? 'MANUAL_INTERVENTION' : 'ACTIVE' }; }
  private cleanup(): void { for (const grant of [...this.grants.values()]) if (grant.expiresAt <= this.now()) void this.revoke(grant.scopeId); for (const [id, ticket] of this.tickets) if (ticket.expiresAt <= this.now() || this.ended.has(ticket.request.backendSessionId)) this.tickets.delete(id); }
  expire(): void { this.cleanup(); }
  pending(): { id: string; purpose: string; lifetime: string; origin?: string; tabSelected?: boolean }[] { this.cleanup(); return [...this.tickets.values()].map(ticket => ({ id: ticket.id, purpose: privateText(String(ticket.request.args.purpose), 160), lifetime: String(ticket.request.args.lifetime), ...(ticket.origin ? { origin: ticket.origin } : {}) })); }
  authorized(): AuthorizedTab[] { this.cleanup(); return [...this.grants.values()].map(grant => this.dto(grant)); }
  async approve(ticketId: string, expectedOrigin?: string, always = false, correlationId?:string): Promise<void> {
    if (this.approving) throw new Error('REJECTED');
    this.approving = true;
    try { await this.approveOnce(ticketId, expectedOrigin, always,correlationId); } finally { this.approving = false; }
  }
  private async approveOnce(ticketId: string, expectedOrigin?: string, always = false, correlationId?:string): Promise<void> {
    this.cleanup(); const ticket = this.tickets.get(ticketId); if (!ticket || !this.epoch || this.ended.has(ticket.request.backendSessionId) || this.endedTasks.has(ticket.request.backendSessionId + ':' + ticket.request.taskId)) throw new Error('EXPIRED');
    const epoch = this.epoch; const selected = await this.surface.current();
    const target = ticket.request.args.target as { kind: string; url?: string };
    if (ticket.chromeId !== undefined && ticket.chromeId !== selected.id || expectedOrigin && siteOrigin(selected.url) !== expectedOrigin || ticket.origin && siteOrigin(selected.url) !== ticket.origin || target.kind === 'new' && ticket.chromeId === undefined) throw new Error('ACCESS_DENIED');
    navigationUrl(selected.url);
    if (this.grants.size >= 20 || [...this.grants.values()].some(grant => grant.chromeId === selected.id && grant.scopeId !== ticket.priorScope)) throw new Error('REJECTED');
    if (this.epoch !== epoch || ticket.expiresAt <= this.now() || this.ended.has(ticket.request.backendSessionId) || this.endedTasks.has(ticket.request.backendSessionId + ':' + ticket.request.taskId)) throw new Error('EXPIRED');
    if(!always&&correlationId)this.diagnostics?.event(correlationId,'policy_saved','NOT_APPLICABLE');
    if (always) { if (!this.sites) throw new Error('ACCESS_DENIED'); const start=performance.now();await this.sites.allowAlways(siteOrigin(selected.url));if(correlationId)this.diagnostics?.event(correlationId,'policy_saved','OK',performance.now()-start); }
    const priorExpiry = ticket.priorScope ? this.grants.get(ticket.priorScope)?.expiresAt : undefined;
    if (ticket.priorScope) await this.revoke(ticket.priorScope, ticketId);
    const grantStarted=performance.now();
    const grant: Grant = { scopeId: this.id(), tabId: ticket.tabId ?? this.id(), chromeId: selected.id, origin: new URL(selected.url).origin, session: ticket.request.backendSessionId, task: ticket.request.taskId, lifetime: ticket.request.args.lifetime as 'task' | 'session', expiresAt: priorExpiry ?? this.now() + (ticket.request.args.lifetime === 'session' ? 30 : 15) * 60_000, title: privateText(selected.title), url: displayUrl(selected.url), persistent: always };
    if (!this.tickets.has(ticketId) || this.epoch !== epoch || ticket.expiresAt <= this.now() || this.ended.has(grant.session) || this.endedTasks.has(grant.session + ':' + grant.task) || always && !await this.sites?.allows(grant.origin)) throw new Error('ACCESS_DENIED');
    // Chrome activeTab comes from the real toolbar/popup gesture, not this method.
    const probe = { ...ticket.request, operation: 'observe' as const, args: { scopeId: grant.scopeId, tabId: grant.tabId }, deadlineAt: this.now() + 8000 };
    const result = await this.surface.content(selected.id, grant, probe);
    if (!this.tickets.has(ticketId) || result.outcome === 'ERROR' || this.epoch !== epoch || this.ended.has(grant.session) || this.endedTasks.has(grant.session + ':' + grant.task) || grant.expiresAt <= this.now()) { await this.surface.invalidate(selected.id); throw new Error('ACCESS_DENIED'); }
    if (result.outcome === 'REQUIRES_USER_INTERACTION') grant.handoff = { id: result.handoffId, reason: result.reason };
    this.grants.set(grant.scopeId, grant); this.tickets.delete(ticketId);
    if(correlationId)this.diagnostics?.event(correlationId,'grant_created','OK',performance.now()-grantStarted);
    this.emit({ protocol: 'atlas.browser', version: 1, kind: 'event', connectionEpoch: epoch, backendSessionId: grant.session, event: 'accessGranted', accessRequestId: ticketId, tab: this.dto(grant),...(correlationId&&this.diagnostics?.enabled?{trace:{correlationId,stage:'notification_posted',outcome:'OK'}}:{}) });
    if(correlationId)this.diagnostics?.event(correlationId,'notification_posted');
  }
  async renew(scopeId: string): Promise<void> {
    const grant = this.grants.get(scopeId); if (!grant) throw new Error('EXPIRED');
    const selected = await this.surface.current(); if (selected.id !== grant.chromeId) throw new Error('ACCESS_DENIED');
    const pending = [...this.tickets.values()].find(ticket => ticket.priorScope === scopeId);
    if (!pending) throw new Error('ACCESS_DENIED');
    pending.origin = siteOrigin(selected.url);
    await this.approve(pending.id, pending.origin);
  }
  async preparePending(): Promise<ReturnType<ExtensionController['pending']>> {
    this.cleanup(); const selected = await this.surface.current().catch(() => undefined);
    return [...this.tickets.values()].map(ticket => {
      const tabSelected = !!selected?.url && (ticket.chromeId === undefined || ticket.chromeId === selected.id);
      if (tabSelected) { ticket.chromeId = selected!.id; ticket.origin = siteOrigin(selected!.url); }
      return { id: ticket.id, purpose: privateText(String(ticket.request.args.purpose),160), lifetime: String(ticket.request.args.lifetime), origin: ticket.origin, tabSelected };
    });
  }
  deny(ticketId: string): void {
    const ticket = this.tickets.get(ticketId); if (!ticket) return; this.tickets.delete(ticketId);
    if (this.epoch) this.emit({protocol:'atlas.browser',version:1,kind:'event',connectionEpoch:this.epoch,backendSessionId:ticket.request.backendSessionId,event:'accessRevoked',accessRequestId:ticketId});
  }
  async revokeOrigin(origin: string): Promise<void> {
    for (const [id,ticket] of this.tickets) {
      const prior = ticket.priorScope && this.grants.get(ticket.priorScope);
      if (ticket.origin === origin || prior && prior.origin === origin) this.deny(id);
    }
    await Promise.all([...this.grants.values()].filter(grant => grant.origin === origin).map(grant => this.revoke(grant.scopeId)));
  }
  private ticket(request: Request, chromeId?: number, origin?: string, priorScope?: string): Reply {
    const previous = [...this.tickets.values()].find(ticket => ticket.priorScope && ticket.priorScope === priorScope);
    if (previous) return { outcome: 'ACCESS_PENDING', accessRequestId: previous.id, expiresAt: previous.expiresAt, ...(previous.origin ? { origin: previous.origin } : {}) };
    if (this.tickets.size >= 20) throw new Error('REJECTED');
    const id = this.id(); const expiresAt = this.now() + 15 * 60_000;
    this.tickets.set(id,{id,request,expiresAt,chromeId,origin,priorScope,tabId:priorScope ? this.grants.get(priorScope)?.tabId : undefined});
    return { outcome: 'ACCESS_PENDING', accessRequestId: id, expiresAt, ...(origin ? { origin } : {}) };
  }
  private async persistentGrant(request: Request, selected: {id:number;url:string;title:string}, previous?: Grant): Promise<Grant | undefined> {
    const origin = siteOrigin(selected.url);
    if (!await this.sites?.allows(origin)) return;
    this.check(request);
    if (this.grants.size >= 20 && !previous || [...this.grants.values()].some(grant => grant.chromeId === selected.id && grant !== previous)) throw new Error('REJECTED');
    if (previous) await this.revoke(previous.scopeId);
    const grant: Grant = { scopeId: this.id(), tabId: previous?.tabId ?? this.id(), chromeId: selected.id, origin, session: request.backendSessionId, task: request.taskId,
      expiresAt: previous?.expiresAt ?? this.now() + (request.args.lifetime === 'session' ? 30 : 15)*60_000, lifetime: previous?.lifetime ?? (request.args.lifetime === 'session' ? 'session' : 'task'), title: privateText(selected.title), url: displayUrl(selected.url), persistent: true };
    if (!await this.sites?.allows(origin)) throw new Error('ACCESS_DENIED');
    this.check(request); this.grants.set(grant.scopeId,grant);
    this.emit({protocol:'atlas.browser',version:1,kind:'event',connectionEpoch:this.epoch,backendSessionId:grant.session,event:'accessGranted',tab:this.dto(grant)});
    return grant;
  }
  private async transition(grant: Grant, request: Request, origin?: string, title = ''): Promise<{ grant?: Grant; reply?: Reply }> {
    await this.surface.invalidate(grant.chromeId).catch(() => {});
    if (origin) {
      const replacement = await this.persistentGrant(request,{id:grant.chromeId,url:origin,title},grant);
      if (replacement) return {grant:replacement};
    }
    grant.suspended = true;
    const accessRequest = { ...request, operation: 'requestTabAccess' as const, args: {target:{kind:'current'},purpose:'Continuar la tarea en esta pestaña',lifetime:grant.lifetime} };
    return {reply:this.ticket(accessRequest,grant.chromeId,origin,grant.scopeId)};
  }
  async revoke(scopeId: string, preserveTicketId?: string): Promise<void> {
    const grant = this.grants.get(scopeId); if (!grant) return; this.retiredScopes.set(scopeId,grant.expiresAt<=this.now()?'EXPIRED':'REVOKED');if(this.retiredScopes.size>100)this.retiredScopes.delete(this.retiredScopes.keys().next().value!); this.grants.delete(scopeId);
    for (const [id,ticket] of this.tickets) if (ticket.priorScope === scopeId && id !== preserveTicketId) this.deny(id);
    await this.surface.invalidate(grant.chromeId).catch(() => {});
    if (this.epoch) this.emit({ protocol: 'atlas.browser', version: 1, kind: 'event', connectionEpoch: this.epoch, backendSessionId: grant.session, event: 'accessRevoked', scopeId });
  }
  async documentChanged(chromeId: number): Promise<void> {
    for (const grant of this.grants.values()) if (grant.chromeId === chromeId) { await this.surface.invalidate(chromeId, true).catch(() => {}); if (this.epoch) this.emit({ protocol: 'atlas.browser', version: 1, kind: 'event', connectionEpoch: this.epoch, backendSessionId: grant.session, event: 'documentChanged', scopeId: grant.scopeId }); }
  }
  async end(session: string): Promise<void> { this.ended.add(session); for (const key of this.activeTasks) if (key.startsWith(session + ':')) this.activeTasks.delete(key); for (const grant of [...this.grants.values()]) if (grant.session === session) await this.revoke(grant.scopeId); for (const [id, ticket] of this.tickets) if (ticket.request.backendSessionId === session) this.tickets.delete(id); }
  private async execute(request: Request, trace:(raw:unknown)=>void): Promise<Reply> {
    this.cleanup(); const args = request.args;
    if (request.operation === 'status') return { outcome: 'OK', data: { available: true, connected: true, visible: true, connections: [] } };
    if (request.operation === 'endTask') { this.activeTasks.delete(request.backendSessionId + ':' + request.taskId); this.endedTasks.add(request.backendSessionId + ':' + request.taskId); for (const grant of [...this.grants.values()]) if (grant.session === request.backendSessionId && grant.task === request.taskId && grant.lifetime === 'task') await this.revoke(grant.scopeId); for (const [id, ticket] of this.tickets) if (ticket.request.backendSessionId === request.backendSessionId && ticket.request.taskId === request.taskId) this.tickets.delete(id); return { outcome: 'OK', data: { completed: true } }; }
    if (request.operation === 'endSession') { await this.end(request.backendSessionId); return { outcome: 'OK', data: { completed: true } }; }
    if (request.operation === 'listAuthorizedTabs') return { outcome: 'OK', data: [...this.grants.values()].filter(grant => grant.session === request.backendSessionId).map(grant => this.dto(grant)) };
    if (request.operation === 'requestTabAccess') {
      this.activeTasks.add(request.backendSessionId + ':' + request.taskId);
      if (this.tickets.size >= 20) throw new Error('REJECTED');
      const target = args.target as { kind: string; url?: string }; if (target.kind === 'new') navigationUrl(target.url!);
      if (target.kind === 'new' && await this.sites?.allows(siteOrigin(target.url!))) {
        this.check(request); const chromeId = await this.surface.create(navigationUrl(target.url!));
        const grant = await this.persistentGrant(request,{id:chromeId,url:target.url!,title:''});
        if (grant) return {outcome:'OK',data:this.dto(grant)};
        return this.ticket(request,chromeId,siteOrigin(target.url!));
      }
      if (target.kind === 'current') {
        const selected = await this.surface.current().catch(() => undefined);
        if (selected?.url) {
          const compatible = [...this.grants.values()].find(grant => grant.chromeId === selected.id && grant.session === request.backendSessionId && grant.task === request.taskId && grant.lifetime === 'task' && request.args.lifetime === 'task' && !grant.suspended && !grant.handoff && grant.expiresAt > this.now() && grant.origin === siteOrigin(selected.url!));
          if (compatible && (!compatible.persistent || await this.sites?.allows(compatible.origin))) {
            this.check(request);
            if (!this.grants.has(compatible.scopeId)) throw new Error('ACCESS_DENIED');
            this.emit({protocol:'atlas.browser',version:1,kind:'event',connectionEpoch:this.epoch,backendSessionId:compatible.session,event:'accessGranted',tab:this.dto(compatible)});
            return {outcome:'OK',data:this.dto(compatible)};
          }
        }
        if (selected?.url) { const existing = [...this.grants.values()].find(grant => grant.chromeId === selected.id && grant.session === request.backendSessionId && grant.lifetime === 'session');
          if (existing && !existing.persistent && !existing.suspended && existing.expiresAt > this.now() && existing.origin === siteOrigin(selected.url)) {
            existing.task = request.taskId; await this.surface.invalidate(existing.chromeId,true);
            this.emit({protocol:'atlas.browser',version:1,kind:'event',connectionEpoch:this.epoch,backendSessionId:existing.session,event:'accessGranted',tab:this.dto(existing)});
            return {outcome:'OK',data:this.dto(existing)};
          }
          const grant = await this.persistentGrant(request,selected,existing); if (grant) return {outcome:'OK',data:this.dto(grant)}; }
        return this.ticket(request,selected?.id,selected?.url ? siteOrigin(selected.url) : undefined);
      }
      return this.ticket(request,undefined,siteOrigin(target.url!));
    }
    if (!this.activeTasks.has(request.backendSessionId + ':' + request.taskId)) throw new Error('ACCESS_DENIED');
    if (request.operation === 'openTab') {
      const ticket = this.tickets.get(String(args.accessRequestId));
      if (!ticket || ticket.request.backendSessionId !== request.backendSessionId || ticket.request.taskId !== request.taskId) throw new Error('ACCESS_DENIED');
      const target = ticket.request.args.target as { kind: string; url?: string }; if (target.kind !== 'new') throw new Error('REJECTED');
      if (ticket.chromeId === undefined) { this.check(request); ticket.chromeId = await this.surface.create(navigationUrl(target.url!)); }
      return { outcome: 'ACCESS_PENDING', accessRequestId: ticket.id, expiresAt: ticket.expiresAt };
    }
    let grant = this.grants.get(String(args.scopeId));
    if (!grant || grant.session !== request.backendSessionId || (grant.lifetime === 'task' && grant.task !== request.taskId) || grant.tabId !== args.tabId && request.operation !== 'revokeTabAccess') throw new Error('ACCESS_DENIED');
    if (request.operation === 'revokeTabAccess') { await this.revoke(grant.scopeId); return { outcome: 'OK', data: { completed: true } }; }
    if (grant.expiresAt <= this.now()) throw new Error('EXPIRED');
    if (grant.suspended) { const pending = [...this.tickets.values()].find(ticket => ticket.priorScope === grant!.scopeId); return pending ? {outcome:'ACCESS_PENDING',accessRequestId:pending.id,expiresAt:pending.expiresAt,...(pending.origin ? {origin:pending.origin} : {})} : (await this.transition(grant,request)).reply!; }
    if (grant.persistent && !await this.sites?.allows(grant.origin)) { await this.revokeOrigin(grant.origin); throw new Error('ACCESS_DENIED'); }
    if (grant.handoff && !(request.operation === 'observe' && args.resumeHandoffId === grant.handoff.id)) return { outcome: 'REQUIRES_USER_INTERACTION', handoffId: grant.handoff.id, reason: grant.handoff.reason };
    if (request.operation === 'activate') { this.check(request); await this.surface.activate(grant.chromeId); return { outcome: 'OK', data: this.dto(grant) }; }
    if (request.operation === 'navigate') { const url = navigationUrl(String(args.url)); this.check(request); await this.surface.navigate(grant.chromeId, url); await this.surface.invalidate(grant.chromeId).catch(() => {}); if (siteOrigin(url) !== grant.origin) { const transition = await this.transition(grant,request,siteOrigin(url)); if (transition.reply) { this.emit({protocol:'atlas.browser',version:1,kind:'event',connectionEpoch:this.epoch,backendSessionId:grant.session,event:'accessRequired',access:transition.reply}); } } return { outcome: 'OK', data: { completed: true } }; }
    if (['back', 'forward', 'reload'].includes(request.operation)) { this.check(request); await this.surface.invalidate(grant.chromeId).catch(() => {}); await this.surface.history(grant.chromeId, request.operation as 'back'); return { outcome: 'OK', data: { completed: true } }; }
    if (this.surface.tab) {
      let tab = await this.surface.tab(grant.chromeId);
      // A pending navigation still exposes the previous committed document.
      // Loading subresources alone does NOT make the current document unusable.
      if (tab.pendingUrl) {
        trace({stage:'CONTENT_TRANSPORT',boundary:'EXTENSION',dispatch:'NOT_ATTEMPTED',failureReason:'DOCUMENT_INITIALIZING'});
        return request.operation==='observe' ? {outcome:'ERROR',code:'CONTENT_UNAVAILABLE'} : {outcome:'ERROR',code:'STALE_REF',conflict:{reason:'DOCUMENT_CHANGED',execution:'NOT_EXECUTED'}};
      }
      if (!tab.url || siteOrigin(tab.url) !== grant.origin) {
        const changed = await this.transition(grant,request,tab.url ? siteOrigin(tab.url) : undefined,tab.title ?? '');
        if (changed.reply) return changed.reply;
        grant = changed.grant!;
        if (request.operation !== 'observe') return {outcome:'ERROR',code:'STALE_REF',conflict:{reason:'DOCUMENT_CHANGED',execution:'NOT_EXECUTED'}};
      }
    }
    if (!this.grants.has(grant.scopeId)) throw new Error('ACCESS_DENIED');
    const contentRequest = request.operation === 'observe' ? {...request,args:{...args,scopeId:grant.scopeId,tabId:grant.tabId}} : request;
    const result = await this.surface.content(grant.chromeId, grant, contentRequest);
    if (!this.grants.has(grant.scopeId)) return {outcome:'ERROR',code:request.operation === 'observe' ? 'ACCESS_DENIED' : 'EXECUTION_UNKNOWN'};
    if(request.operation==='observe'){
      this.check(request);
      if(grant.expiresAt<=this.now()||grant.suspended)throw new Error('ACCESS_DENIED');
      if(grant.persistent&&!await this.sites?.allows(grant.origin)){await this.revokeOrigin(grant.origin);throw new Error('ACCESS_DENIED');}
      const current=await this.surface.tab?.(grant.chromeId);
      if(current?.pendingUrl)return {outcome:'ERROR',code:'CONTENT_UNAVAILABLE'};
      if(current?.url&&siteOrigin(current.url)!==grant.origin)return (await this.transition(grant,request,siteOrigin(current.url),current.title)).reply??{outcome:'ERROR',code:'CONTENT_UNAVAILABLE'};
    }
    if (result.outcome === 'REQUIRES_USER_INTERACTION' && result.reason === 'ORIGIN_PERMISSION') {
      const tab = await this.surface.tab?.(grant.chromeId).catch(() => undefined);
      return (await this.transition(grant,request,tab?.url ? siteOrigin(tab.url) : undefined,tab?.title)).reply ?? {outcome:'ERROR',code:'CONTENT_UNAVAILABLE'};
    }
    if (result.outcome === 'REQUIRES_USER_INTERACTION') return this.handoff(grant, result.reason);
    if (result.outcome === 'OK' && request.operation === 'observe') { grant.handoff = undefined; const data = result.data as { title: string; url: string }; grant.title = data.title; grant.url = data.url; }
    return result;
  }
  private handoff(grant: Grant, reason: Extract<Reply, { outcome: 'REQUIRES_USER_INTERACTION' }>['reason']): Reply { if (!grant.handoff || grant.handoff.reason !== reason) grant.handoff = { id: this.id(), reason }; return { outcome: 'REQUIRES_USER_INTERACTION', handoffId: grant.handoff.id, reason }; }
}
