import { parseRequest, replySchema, helloSchema, cancelSchema } from '../../src/browser/attached/protocol.js';
import type { Request, Reply, AuthorizedTab } from '../../src/browser/attached/protocol.js';
import { navigationUrl, displayUrl, privateText } from '../../src/browser/policy.js';
export interface Surface {
  current(): Promise<{ id: number; url: string; title: string }>;
  create(url: string): Promise<number>;
  activate(tab: number): Promise<void>;
  navigate(tab: number, url: string): Promise<void>;
  history(tab: number, action: 'back' | 'forward' | 'reload'): Promise<void>;
  content(tab: number, grant: Grant, request: Request): Promise<Reply>;
  invalidate(tab: number): Promise<void>;
}
export interface Grant { scopeId: string; tabId: string; chromeId: number; origin: string; session: string; task: string; expiresAt: number; lifetime: 'task' | 'session'; title: string; url: string; handoff?: { id: string; reason: Extract<Reply, { outcome: 'REQUIRES_USER_INTERACTION' }>['reason'] }; suspended?: boolean }
interface Ticket { id: string; request: Request; expiresAt: number; chromeId?: number }
export class ExtensionController {
  epoch?: string; readonly grants = new Map<string, Grant>(); readonly tickets = new Map<string, Ticket>();
  private results = new Map<string, { signature: string; result: Promise<Reply>; session: string }>();
  private cancelled = new Set<string>(); private ended = new Set<string>(); private endedTasks = new Set<string>(); private tail: Promise<unknown> = Promise.resolve();
  private approving = false;
  constructor(private readonly surface: Surface, private readonly emit: (event: unknown) => void, private readonly now = Date.now, private readonly id = () => crypto.randomUUID()) {}
  async reset(raw?: unknown): Promise<void> {
    this.epoch = raw === undefined ? undefined : helloSchema.parse(raw).connectionEpoch;
    const old = [...this.grants.values()]; this.grants.clear(); this.tickets.clear(); this.results.clear(); this.cancelled.clear(); this.ended.clear(); this.endedTasks.clear();
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
    const result = this.tail.catch(() => {}).then(async (): Promise<Reply> => {
      try { this.check(request); const reply = await this.execute(request); if (!['endSession', 'endTask'].includes(request.operation)) this.check(request); return replySchema.parse(reply); }
      catch (error) { const code = error instanceof Error ? error.message : ''; return { outcome: 'ERROR', code: ['TIMEOUT', 'ACCESS_DENIED', 'EXPIRED', 'STALE_REF', 'REJECTED'].includes(code) ? code as 'REJECTED' : 'UNSUPPORTED' }; }
    });
    this.tail = result; this.results.set(request.requestId, { signature, result, session: request.backendSessionId }); return result;
  }
  private dto(grant: Grant): AuthorizedTab { return { id: grant.tabId, scopeId: grant.scopeId, title: grant.title, url: grant.url, active: false, expiresAt: grant.expiresAt, state: grant.suspended ? 'SUSPENDED_ORIGIN' : grant.handoff ? 'MANUAL_INTERVENTION' : 'ACTIVE' }; }
  private cleanup(): void { for (const grant of [...this.grants.values()]) if (grant.expiresAt <= this.now()) void this.revoke(grant.scopeId); for (const [id, ticket] of this.tickets) if (ticket.expiresAt <= this.now() || this.ended.has(ticket.request.backendSessionId)) this.tickets.delete(id); }
  expire(): void { this.cleanup(); }
  pending(): { id: string; purpose: string; lifetime: string }[] { this.cleanup(); return [...this.tickets.values()].map(ticket => ({ id: ticket.id, purpose: privateText(String(ticket.request.args.purpose), 160), lifetime: String(ticket.request.args.lifetime) })); }
  authorized(): AuthorizedTab[] { this.cleanup(); return [...this.grants.values()].map(grant => this.dto(grant)); }
  async approve(ticketId: string): Promise<void> {
    if (this.approving) throw new Error('REJECTED');
    this.approving = true;
    try { await this.approveOnce(ticketId); } finally { this.approving = false; }
  }
  private async approveOnce(ticketId: string): Promise<void> {
    this.cleanup(); const ticket = this.tickets.get(ticketId); if (!ticket || !this.epoch || this.ended.has(ticket.request.backendSessionId) || this.endedTasks.has(ticket.request.backendSessionId + ':' + ticket.request.taskId)) throw new Error('EXPIRED');
    const epoch = this.epoch; const selected = await this.surface.current();
    const target = ticket.request.args.target as { kind: string; url?: string };
    if (target.kind === 'new' && (ticket.chromeId !== selected.id || new URL(selected.url).origin !== new URL(target.url!).origin)) throw new Error('ACCESS_DENIED');
    navigationUrl(selected.url);
    if (this.grants.size >= 20 || [...this.grants.values()].some(grant => grant.chromeId === selected.id)) throw new Error('REJECTED');
    if (this.epoch !== epoch || ticket.expiresAt <= this.now() || this.ended.has(ticket.request.backendSessionId) || this.endedTasks.has(ticket.request.backendSessionId + ':' + ticket.request.taskId)) throw new Error('EXPIRED');
    const grant: Grant = { scopeId: this.id(), tabId: this.id(), chromeId: selected.id, origin: new URL(selected.url).origin, session: ticket.request.backendSessionId, task: ticket.request.taskId, lifetime: ticket.request.args.lifetime as 'task' | 'session', expiresAt: this.now() + (ticket.request.args.lifetime === 'session' ? 30 : 15) * 60_000, title: privateText(selected.title), url: displayUrl(selected.url) };
    // Chrome activeTab comes from the real toolbar/popup gesture, not this method.
    const probe = { ...ticket.request, operation: 'observe' as const, args: { scopeId: grant.scopeId, tabId: grant.tabId }, deadlineAt: this.now() + 8000 };
    const result = await this.surface.content(selected.id, grant, probe);
    if (result.outcome === 'ERROR' || this.epoch !== epoch || this.ended.has(grant.session) || this.endedTasks.has(grant.session + ':' + grant.task) || grant.expiresAt <= this.now()) { await this.surface.invalidate(selected.id); throw new Error('ACCESS_DENIED'); }
    if (result.outcome === 'REQUIRES_USER_INTERACTION') grant.handoff = { id: result.handoffId, reason: result.reason };
    this.grants.set(grant.scopeId, grant); this.tickets.delete(ticketId);
    this.emit({ protocol: 'atlas.browser', version: 1, kind: 'event', connectionEpoch: epoch, backendSessionId: grant.session, event: 'accessGranted', accessRequestId: ticketId, tab: this.dto(grant) });
  }
  async renew(scopeId: string): Promise<void> {
    this.cleanup(); const grant = this.grants.get(scopeId); if (!grant || !this.epoch) throw new Error('EXPIRED');
    const selected = await this.surface.current(); if (selected.id !== grant.chromeId) throw new Error('ACCESS_DENIED');
    navigationUrl(selected.url); await this.surface.invalidate(grant.chromeId);
    grant.origin = new URL(selected.url).origin; grant.title = privateText(selected.title); grant.url = displayUrl(selected.url); grant.suspended = false; if (grant.handoff?.reason === 'ORIGIN_PERMISSION') grant.handoff = undefined;
    this.emit({ protocol: 'atlas.browser', version: 1, kind: 'event', connectionEpoch: this.epoch, backendSessionId: grant.session, event: 'accessGranted', tab: this.dto(grant) });
  }
  async revoke(scopeId: string): Promise<void> {
    const grant = this.grants.get(scopeId); if (!grant) return; this.grants.delete(scopeId);
    await this.surface.invalidate(grant.chromeId).catch(() => {});
    if (this.epoch) this.emit({ protocol: 'atlas.browser', version: 1, kind: 'event', connectionEpoch: this.epoch, backendSessionId: grant.session, event: 'accessRevoked', scopeId });
  }
  async documentChanged(chromeId: number): Promise<void> {
    for (const grant of this.grants.values()) if (grant.chromeId === chromeId) { await this.surface.invalidate(chromeId).catch(() => {}); if (this.epoch) this.emit({ protocol: 'atlas.browser', version: 1, kind: 'event', connectionEpoch: this.epoch, backendSessionId: grant.session, event: 'documentChanged', scopeId: grant.scopeId }); }
  }
  async end(session: string): Promise<void> { this.ended.add(session); for (const grant of [...this.grants.values()]) if (grant.session === session) await this.revoke(grant.scopeId); for (const [id, ticket] of this.tickets) if (ticket.request.backendSessionId === session) this.tickets.delete(id); }
  private async execute(request: Request): Promise<Reply> {
    this.cleanup(); const args = request.args;
    if (request.operation === 'status') return { outcome: 'OK', data: { available: true, connected: true, visible: true, connections: [] } };
    if (request.operation === 'endTask') { this.endedTasks.add(request.backendSessionId + ':' + request.taskId); for (const grant of [...this.grants.values()]) if (grant.session === request.backendSessionId && grant.task === request.taskId && grant.lifetime === 'task') await this.revoke(grant.scopeId); for (const [id, ticket] of this.tickets) if (ticket.request.backendSessionId === request.backendSessionId && ticket.request.taskId === request.taskId) this.tickets.delete(id); return { outcome: 'OK', data: { completed: true } }; }
    if (request.operation === 'endSession') { await this.end(request.backendSessionId); return { outcome: 'OK', data: { completed: true } }; }
    if (request.operation === 'listAuthorizedTabs') return { outcome: 'OK', data: [...this.grants.values()].filter(grant => grant.session === request.backendSessionId).map(grant => this.dto(grant)) };
    if (request.operation === 'requestTabAccess') {
      if (this.tickets.size >= 20) throw new Error('REJECTED');
      const target = args.target as { kind: string; url?: string }; if (target.kind === 'new') navigationUrl(target.url!);
      const id = this.id(); const expiresAt = this.now() + 15 * 60_000; this.tickets.set(id, { id, request, expiresAt });
      return { outcome: 'ACCESS_PENDING', accessRequestId: id, expiresAt };
    }
    if (request.operation === 'openTab') {
      const ticket = this.tickets.get(String(args.accessRequestId));
      if (!ticket || ticket.request.backendSessionId !== request.backendSessionId || ticket.request.taskId !== request.taskId) throw new Error('ACCESS_DENIED');
      const target = ticket.request.args.target as { kind: string; url?: string }; if (target.kind !== 'new') throw new Error('REJECTED');
      if (ticket.chromeId === undefined) { this.check(request); ticket.chromeId = await this.surface.create(navigationUrl(target.url!)); }
      return { outcome: 'ACCESS_PENDING', accessRequestId: ticket.id, expiresAt: ticket.expiresAt };
    }
    const grant = this.grants.get(String(args.scopeId));
    if (!grant || grant.session !== request.backendSessionId || (grant.lifetime === 'task' && grant.task !== request.taskId) || grant.tabId !== args.tabId && request.operation !== 'revokeTabAccess') throw new Error('ACCESS_DENIED');
    if (request.operation === 'revokeTabAccess') { await this.revoke(grant.scopeId); return { outcome: 'OK', data: { completed: true } }; }
    if (grant.expiresAt <= this.now()) throw new Error('EXPIRED');
    if (grant.suspended) return this.handoff(grant, 'ORIGIN_PERMISSION');
    if (grant.handoff && !(request.operation === 'observe' && args.resumeHandoffId === grant.handoff.id)) return { outcome: 'REQUIRES_USER_INTERACTION', handoffId: grant.handoff.id, reason: grant.handoff.reason };
    if (request.operation === 'activate') { this.check(request); await this.surface.activate(grant.chromeId); return { outcome: 'OK', data: this.dto(grant) }; }
    if (request.operation === 'navigate') { const url = navigationUrl(String(args.url)); this.check(request); await this.surface.navigate(grant.chromeId, url); await this.surface.invalidate(grant.chromeId).catch(() => {}); if (new URL(url).origin !== grant.origin) { grant.suspended = true; return this.handoff(grant, 'ORIGIN_PERMISSION'); } return { outcome: 'OK', data: { completed: true } }; }
    if (['back', 'forward', 'reload'].includes(request.operation)) { this.check(request); await this.surface.invalidate(grant.chromeId).catch(() => {}); await this.surface.history(grant.chromeId, request.operation as 'back'); return { outcome: 'OK', data: { completed: true } }; }
    const result = await this.surface.content(grant.chromeId, grant, request);
    if (result.outcome === 'REQUIRES_USER_INTERACTION') return this.handoff(grant, result.reason);
    if (result.outcome === 'OK' && request.operation === 'observe') { grant.handoff = undefined; const data = result.data as { title: string; url: string }; grant.title = data.title; grant.url = data.url; }
    return result;
  }
  private handoff(grant: Grant, reason: Extract<Reply, { outcome: 'REQUIRES_USER_INTERACTION' }>['reason']): Reply { if (!grant.handoff || grant.handoff.reason !== reason) grant.handoff = { id: this.id(), reason }; return { outcome: 'REQUIRES_USER_INTERACTION', handoffId: grant.handoff.id, reason }; }
}
