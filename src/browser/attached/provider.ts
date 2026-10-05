import type { z } from 'zod';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ToolError } from '../../tools/types.js';
import { navigationUrl } from '../policy.js';
import type { BrowserProvider, BrowserTab, BrowserObservation, BrowserKey, BrowserStatus } from '../provider.js';
import { parseRequest, observationSchema, replySchema } from './protocol.js';
import type { Operation, Reply, AuthorizedTab } from './protocol.js';
import type { BrowserTransport } from './transport.js';
interface Session { id: string; task: string; connection?: string; active?: string; tabs: Map<string, AuthorizedTab>; workflow?: Exclude<Reply, { outcome: 'OK' } | { outcome: 'ERROR' }>; ready?: string; observation?: { tabId: string; scopeId: string; documentId: string; snapshotId: string; refs: Set<string>; expires: number }; closed?: boolean }
export class BrowserWorkflow extends Error { constructor(readonly reply: Exclude<Reply, { outcome: 'OK' }>) { super(reply.outcome); } }
export class AttachedChromeProvider implements BrowserProvider {
  readonly attached = true; private scope = new AsyncLocalStorage<Session>(); private sessions = new Map<string, Session>();
  constructor(private readonly transport: BrowserTransport, private readonly enabled = true, private readonly configuredConnection?: string) {
    transport.subscribe((connection, event) => {
      const session = this.sessions.get(event.backendSessionId); if (!session || session.closed || session.connection !== connection) return;
      session.observation = undefined;
      if (event.event === 'accessGranted' && event.tab) { session.tabs.set(event.tab.id, event.tab); session.active = event.tab.id; if (session.workflow?.outcome === 'ACCESS_PENDING' && (!event.accessRequestId || event.accessRequestId === session.workflow.accessRequestId)) { session.workflow = undefined; session.ready = randomUUID(); } else if (session.workflow?.outcome === 'REQUIRES_USER_INTERACTION' && session.workflow.reason === 'ORIGIN_PERMISSION') { session.workflow = undefined; session.ready = randomUUID(); } }
      else if (event.event === 'accessRevoked') { for (const [id, tab] of session.tabs) if (tab.scopeId === event.scopeId) { session.tabs.delete(id); if (session.active === id) session.active = undefined; } session.workflow = undefined; }
    });
  }
  inSession<T>(id: string, work: () => Promise<T>): Promise<T> {
    let session = this.sessions.get(id); if (!session) { if (this.sessions.size >= 10) throw new ToolError('LIMIT'); session = { id, task: randomUUID(), tabs: new Map() }; this.sessions.set(id, session); }
    if (session.closed) throw new ToolError('REJECTED'); return this.scope.run(session, work);
  }
  state(id: string) { const session = this.sessions.get(id); return session && !session.closed ? { workflow: session.workflow ?? null, ready: session.ready ?? null } : { workflow: null, ready: null }; }
  private session(): Session { const session = this.scope.getStore(); if (!session || session.closed) throw new ToolError('REJECTED'); return session; }
  private connection(session: Session): string {
    if (!this.enabled) throw new ToolError('UNCONFIGURED'); const connections = this.transport.connections();
    if (session.connection && connections.includes(session.connection)) return session.connection;
    // A new connection never inherits scopes. Multiple connections need explicit selection.
    session.tabs.clear(); session.active = undefined; session.observation = undefined;
    const selected = this.configuredConnection ? connections.find(id => id === this.configuredConnection) : connections.length === 1 ? connections[0] : undefined;
    if (!selected) throw new ToolError(connections.length > 1 ? 'AMBIGUOUS' : 'UNCONFIGURED'); session.connection = selected; return selected;
  }
  private async call(operation: Operation, args: Record<string, unknown>, signal: AbortSignal): Promise<Reply> {
    const session = this.session(); const connection = this.connection(session);
    const request = parseRequest({ protocol: 'atlas.browser', version: 1, kind: 'request', requestId: randomUUID(), backendSessionId: session.id, taskId: session.task, connectionEpoch: this.transport.epoch, deadlineAt: Date.now() + 17_000, operation, args });
    const reply = replySchema.parse(await this.transport.request(connection, request, signal));
    if (session.closed) throw new ToolError('REJECTED');
    if (reply.outcome === 'ACCESS_PENDING' || reply.outcome === 'REQUIRES_USER_INTERACTION') session.workflow = reply;
    return reply;
  }
  private unwrap<T>(reply: Reply): T {
    if (reply.outcome === 'OK') return reply.data as T;
    if (reply.outcome === 'ERROR' && ['EXECUTION_UNKNOWN','DISCONNECTED'].includes(reply.code)) throw new ToolError('EXECUTION_UNKNOWN');
    if (reply.outcome === 'ERROR') throw new ToolError(reply.code === 'STALE_REF' ? 'CONFLICT' : reply.code === 'EXPIRED' ? 'EXPIRED' : reply.code === 'INVALID_INPUT' ? 'INVALID_INPUT' : reply.code === 'TIMEOUT' ? 'TIMEOUT' : 'REJECTED');
    throw new BrowserWorkflow(reply);
  }
  private binding(): { scopeId: string; tabId: string } { const session = this.session(); const tab = session.tabs.get(session.active ?? ''); if (!tab || tab.expiresAt <= Date.now()) throw new ToolError('REJECTED'); return { scopeId: tab.scopeId, tabId: tab.id }; }
  async status(): Promise<BrowserStatus> { const connections = this.enabled ? this.transport.connections() : []; return { available: this.enabled, connected: connections.length > 0, visible: true, connections, ...(!this.enabled ? { reason: 'disabled' as const } : connections.length === 0 ? { reason: 'unavailable' as const } : {}) }; }
  async ensureBrowser(_signal: AbortSignal): Promise<BrowserStatus> { return this.status(); }
  async requestTabAccess(input: { target: { kind: 'current' } | { kind: 'new'; url: string }; purpose: string; lifetime: 'task' | 'session' }, signal: AbortSignal): Promise<Reply> { const reply = await this.call('requestTabAccess', input, signal); if (reply.outcome === 'ERROR') this.unwrap(reply); return reply; }
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
  async navigate(url: string, signal: AbortSignal): Promise<BrowserTab> { navigationUrl(url); this.session().observation = undefined; this.unwrap(await this.call('navigate', { ...this.binding(), url }, signal)); return (await this.getActiveTab(signal))!; }
  async observe(signal: AbortSignal): Promise<BrowserObservation> { return this.observeWithResume(signal); }
  private async observeWithResume(signal: AbortSignal, handoffId?: string): Promise<z.infer<typeof observationSchema>> {
    const session = this.session(); const reply = await this.call('observe', { ...this.binding(), ...(handoffId ? { resumeHandoffId: handoffId } : {}) }, signal);
    const data = observationSchema.parse(this.unwrap(reply)); session.observation = { tabId: data.tabId, scopeId: data.scopeId, documentId: data.documentId, snapshotId: data.snapshotId, refs: new Set(data.elements.map(el => el.ref)), expires: Date.now() + 15_000 }; if (handoffId) { session.workflow = undefined; session.ready = randomUUID(); } return data;
  }
  async resume(handoffId: string, signal: AbortSignal): Promise<Reply> {
    const session = this.session(); if (session.workflow?.outcome !== 'REQUIRES_USER_INTERACTION' || session.workflow.handoffId !== handoffId) throw new ToolError('REJECTED');
    try { const data = await this.observeWithResume(signal, handoffId); return { outcome: 'OK', data }; } catch (error) { if (error instanceof BrowserWorkflow) return error.reply; throw error; }
  }
  private ref(ref: string): Record<string, unknown> { const session = this.session(); const snapshot = session.observation; if (!snapshot || snapshot.expires <= Date.now() || !snapshot.refs.has(ref)) throw new ToolError('CONFLICT'); const binding = { scopeId: snapshot.scopeId, tabId: snapshot.tabId, documentId: snapshot.documentId, snapshotId: snapshot.snapshotId, ref }; session.observation = undefined; return binding; }
  async click(ref: string, signal: AbortSignal): Promise<void> { this.unwrap(await this.call('click', this.ref(ref), signal)); }
  async type(ref: string, text: string, mode: 'replace' | 'append', signal: AbortSignal): Promise<void> { this.unwrap(await this.call('type', { ...this.ref(ref), text, mode }, signal)); }
  async press(ref: string, key: BrowserKey, signal: AbortSignal): Promise<void> { this.unwrap(await this.call('press', { ...this.ref(ref), key }, signal)); }
  async media(ref: string, action: 'play' | 'pause', signal: AbortSignal): Promise<unknown> { return this.unwrap(await this.call('media', { ...this.ref(ref), action }, signal)); }
  async scroll(direction: 'up' | 'down', signal: AbortSignal): Promise<void> { this.session().observation = undefined; this.unwrap(await this.call('scroll', { ...this.binding(), direction }, signal)); }
  private async history(operation: 'back' | 'forward' | 'reload', signal: AbortSignal): Promise<BrowserTab> { this.session().observation = undefined; this.unwrap(await this.call(operation, this.binding(), signal)); return (await this.getActiveTab(signal))!; }
  back(signal: AbortSignal) { return this.history('back', signal); } forward(signal: AbortSignal) { return this.history('forward', signal); } reload(signal: AbortSignal) { return this.history('reload', signal); }
  async endTask(signal: AbortSignal): Promise<unknown> { const session = this.session(); this.unwrap(await this.call('endTask', {}, signal)); session.task = randomUUID(); session.observation = undefined; session.workflow = undefined; session.ready = undefined; await this.listTabs(signal); return { completed: true }; }
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
