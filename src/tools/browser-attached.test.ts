import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { createToolsHandler } from '../server/tools.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { ContentEngine } from '../../extension/src/content-engine.js';
import { ExtensionController } from '../../extension/src/controller.js';
import type { Surface, Grant } from '../../extension/src/controller.js';
import { backendSender, popupSender } from '../../extension/src/senders.js';
import { parseRequest, replySchema, MAX_PAYLOAD } from '../browser/attached/protocol.js';
import type { Request, Reply, AuthorizedTab } from '../browser/attached/protocol.js';
import { FrameReader, frame } from '../browser/attached/framing.js';
import { AttachedChromeProvider, BrowserWorkflow } from '../browser/attached/provider.js';
import { BrowserAdapter } from './adapters/browser.js';
import type { BrowserTransport } from '../browser/attached/transport.js';
import { BrowserContinuation } from '../provider/browser-continuation.js';
import { ToolRegistry } from './registry.js';
import { ToolExecutor } from './execution.js';
const id = randomUUID; const signal = () => new AbortController().signal;
const epoch = id(); const session = id(); const task = id();
const request = (operation: Request['operation'], args: Record<string, unknown> = {}, extra: Partial<Request> = {}) => parseRequest({ protocol: 'atlas.browser', version: 1, kind: 'request', requestId: id(), backendSessionId: session, taskId: task, connectionEpoch: epoch, deadlineAt: Date.now() + 15_000, operation, args, ...extra });
function fixture(html = '<title>Authenticated workspace</title><form method="get" action="/search"><input type="search" aria-label="Search"><button>Search</button></form><button>Send message</button><video></video>') {
  const dom = new JSDOM(html, { url: 'https://workspace.example/', pretendToBeVisual: true }); const win = dom.window;
  win.HTMLElement.prototype.checkVisibility = function() { return !this.closest('[hidden]'); };
  win.HTMLElement.prototype.getBoundingClientRect = function() { const n = [...win.document.querySelectorAll('*')].indexOf(this); return { x: n * 8, y: 0, left: n * 8, right: n * 8 + 6, top: 0, bottom: 6, width: 6, height: 6, toJSON() {} }; };
  win.document.elementFromPoint = (x: number) => [...win.document.querySelectorAll('*')].find(el => { const r = el.getBoundingClientRect(); return x >= r.left && x <= r.right; }) ?? null;
  const engine = new ContentEngine(win as unknown as Window & typeof globalThis, Date.now, id);
  const access = { scopeId: id(), tabId: id(), session, epoch, origin: win.location.origin, expiresAt: Date.now() + 900_000 };
  engine.initialize(access);
  const run = (operation: Request['operation'], args: Record<string, unknown> = {}, identity = { session, epoch }) => engine.run(operation, { scopeId: access.scopeId, tabId: access.tabId, ...args }, Date.now() + 15_000, identity);
  return { dom, engine, access, run, close: () => { engine.destroy(); dom.window.close(); } };
}
test('atlas.browser/1 strict schemas reject versions, operations, extra fields and arbitrary JS/selectors', () => {
  const valid = request('status'); assert.equal(parseRequest(valid).operation, 'status');
  for (const raw of [{ ...valid, version: 2 }, { ...valid, evaluate: 'private' }, { ...valid, operation: 'evaluate' }, { ...valid, args: { selector: '*', javascript: 'private' } }, { ...valid, requestId: 'fake' }]) assert.throws(() => parseRequest(raw));
  assert.throws(() => replySchema.parse({ outcome: 'OK', data: { completed: true, cookies: 'PRIVATE_SENTINEL' } }));
});
test('Native framing handles fragmented/coalesced messages, invalid UTF8 and oversized/truncated frames', () => {
  const rows: unknown[] = []; const reader = new FrameReader(row => rows.push(row)); const data = Buffer.concat([frame({ hello: 'á' }), frame({ next: true })]);
  for (const byte of data) reader.push(Buffer.from([byte])); reader.end(); assert.deepEqual(rows, [{ hello: 'á' }, { next: true }]);
  const bad = Buffer.alloc(4); bad.writeUInt32LE(MAX_PAYLOAD + 1); assert.throws(() => new FrameReader(() => {}).push(bad));
  assert.throws(() => frame({ value: 'x'.repeat(MAX_PAYLOAD) })); const incomplete = new FrameReader(() => {}); incomplete.push(data.subarray(0, 7)); assert.throws(() => incomplete.end());
  assert.throws(() => new FrameReader(() => {}).push(Buffer.from([1,0,0,0,255])));
});
test('only packaged popup can approve; content/pages/other extensions are denied', () => {
  const own = 'a'.repeat(32); const url = `chrome-extension://${own}/popup.html`;
  assert.equal(popupSender({ id: own, url }, own, url), true);
  for (const sender of [{ id: 'b'.repeat(32), url }, { id: own, url, tab: {} }, { id: own, url: 'https://private.example/' }]) assert.equal(popupSender(sender, own, url), false);
  assert.equal(backendSender({ id: own, tab: {} }, own), false);
});
test('content observations are compact, exclude credentials/storage and reject unauthorized/consequential/stale controls', async () => {
  const f = fixture('<title>Workspace</title><form method="get" action="/search"><input type="search" aria-label="Search"></form><input type="password" hidden value="PRIVATE_PASSWORD"><input autocomplete="cc-number"><button>Send message</button>');
  try {
    let prohibitedReads = 0;
    for (const key of ['localStorage','sessionStorage']) Object.defineProperty(f.dom.window, key, { get() { ++prohibitedReads; throw new Error('PRIVATE_STORAGE'); } });
    Object.defineProperty(f.dom.window.document, 'cookie', { get() { ++prohibitedReads; throw new Error('PRIVATE_COOKIE'); } });
    const getter = Object.getOwnPropertyDescriptor(f.dom.window.HTMLInputElement.prototype, 'value')!;
    Object.defineProperty(f.dom.window.HTMLInputElement.prototype, 'value', { ...getter, get() { ++prohibitedReads; throw new Error('PRIVATE_VALUE'); } });
    const observed = await f.run('observe'); assert.equal(observed.outcome, 'OK');
    if (observed.outcome !== 'OK') throw new Error(); const data = observed.data as any;
    assert.ok(!JSON.stringify(data).includes('PRIVATE')); assert.ok(!data.elements.some((el: any) => el.type === 'password')); assert.equal(prohibitedReads, 0);
    const search = data.elements.find((el: any) => el.role === 'searchbox');
    const binding = { documentId: data.documentId, snapshotId: data.snapshotId, ref: search.ref };
    assert.deepEqual(await f.run('type', { ...binding, text: 'The Nights', mode: 'replace' }), { outcome: 'OK', data: { completed: true } }); assert.equal(prohibitedReads, 0);
    assert.equal((await f.run('click', binding)).outcome, 'ERROR');
    const next = await f.run('observe'); const n = (next as any).data; const send = n.elements.find((el: any) => el.name === 'Send message');
    assert.deepEqual(await f.run('click', { documentId: n.documentId, snapshotId: n.snapshotId, ref: send.ref }), { outcome: 'ERROR', code: 'REJECTED' });
    assert.equal((await f.run('observe', {}, { session: id(), epoch })).outcome, 'ERROR');
    f.engine.revoke(); assert.equal((await f.run('observe')).outcome, 'ERROR');
  } finally { f.close(); }
});
test('challenge, login and MFA handoffs stop automation without reading or solving anything', async () => {
  for (const [html, reason] of [['<iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>', 'CAPTCHA'], ['<input type="password">', 'AUTHENTICATION'], ['<input autocomplete="one-time-code">', 'MFA'], ['<h1>Verify you are human</h1>', 'CHALLENGE']] as const) {
    const f = fixture(html); try { const reply = await f.run('observe'); assert.equal(reply.outcome, 'REQUIRES_USER_INTERACTION'); assert.equal((reply as any).reason, reason); } finally { f.close(); }
  }
});
test('document mutation, TTL, reconnect, modal and media preserve ref safety', async () => {
  const f = fixture('<div role="dialog" aria-label="Consent"><h2>Cookies</h2><button>Reject all</button><button>Accept all</button></div><input type="search" aria-label="Behind">');
  try {
    // JSDOM has no innerText layout; provide deterministic rendered fixture text.
    Object.defineProperty(f.dom.window.document.querySelector('[role="dialog"]'), 'innerText', { value: 'Cookies\nReject all\nAccept all' });
    const observed: any = await f.run('observe'); assert.ok(!observed.data.elements.some((el: any) => el.role === 'searchbox')); assert.equal(observed.data.elements[0].action, 'consent'); assert.equal(observed.data.elements[1].action, 'blocked');
    const el = observed.data.elements[0]; const binding = { documentId: observed.data.documentId, snapshotId: observed.data.snapshotId, ref: el.ref };
    f.dom.window.document.querySelector('button')!.textContent = 'Send message'; await Promise.resolve(); assert.deepEqual(await f.run('click', binding), { outcome: 'ERROR', code: 'STALE_REF', conflict: { reason: 'ELEMENT_CHANGED', execution: 'NOT_EXECUTED' } });
    f.engine.initialize({ ...f.access, epoch: id() }); assert.equal((await f.run('click', binding)).outcome, 'ERROR');
  } finally { f.close(); }
  let now = Date.now(); const t = fixture(); const timed = new ContentEngine(t.dom.window as any, () => now, id); timed.initialize(t.access);
  try { const reply: any = await timed.run('observe', { scopeId: t.access.scopeId, tabId: t.access.tabId }, now + 1000, { session, epoch }); now += 16_000; const media = reply.data.elements.find((el: any) => el.role === 'media'); assert.deepEqual(await timed.run('media', { scopeId: t.access.scopeId, tabId: t.access.tabId, documentId: reply.data.documentId, snapshotId: reply.data.snapshotId, ref: media.ref, action: 'play' }, now + 1000, { session, epoch }), { outcome: 'ERROR', code: 'STALE_REF', conflict: { reason: 'SNAPSHOT_EXPIRED', execution: 'NOT_EXECUTED' } }); } finally { timed.destroy(); t.close(); }
});
function harness() {
  let creates = 0; let invalidates = 0; const events: any[] = []; const chosen = { id: 7, url: 'https://workspace.example/', title: 'Authenticated workspace' };
  const f = fixture(); const listeners = new Set<(connection: string, event: any) => void>(); const connection = id();
  const surface: Surface = { current: async () => chosen, create: async url => { ++creates; chosen.url = url; return chosen.id; }, activate: async () => {}, navigate: async (_id, url) => { chosen.url = url; }, history: async () => {}, invalidate: async (_tab, documentOnly) => { ++invalidates; if (documentOnly) f.engine.documentChanged(); else f.engine.revoke(); }, content: async (_id, grant, req) => { try { f.engine.initialize({ scopeId: grant.scopeId, tabId: grant.tabId, session: grant.session, epoch: req.connectionEpoch, origin: grant.origin, expiresAt: grant.expiresAt }); return f.engine.run(req.operation, req.args, req.deadlineAt, { session: req.backendSessionId, epoch: req.connectionEpoch }); } catch { return { outcome: 'REQUIRES_USER_INTERACTION', reason: 'ORIGIN_PERMISSION', handoffId: id() }; } } };
  const controller = new ExtensionController(surface, event => { events.push(event); for (const listener of listeners) listener(connection, event); }, Date.now, id);
  const channels = [connection]; let closed = false;
  const transport: BrowserTransport = { epoch, connections: () => channels, request: async (_connection, req, aborted) => aborted.aborted ? { outcome: 'ERROR', code: 'EXECUTION_UNKNOWN' } : controller.receive(req), subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, close: () => { closed = true; void controller.reset(); } };
  return { controller, surface, transport, chosen, f, events, channels, stats: () => ({ creates, invalidates, closed }), close: () => f.close() };
}
test('attached flow A–H/L: grant, authenticated tab, invisible other tabs, replay, navigation, revoke, restart and task scopes', async () => {
  const h = harness(); const provider = new AttachedChromeProvider(h.transport); await h.controller.reset({ protocol: 'atlas.browser', version: 1, kind: 'hello', connectionEpoch: epoch });
  try {
    assert.deepEqual(await provider.status(), { available: true, connected: true, visible: true, connections: h.channels });
    await provider.inSession(session, async () => {
      assert.deepEqual(await provider.listTabs(signal()), []); // No enumeration of unapproved Chrome tabs.
      await assert.rejects(provider.openTab('https://workspace.example/', signal()), BrowserWorkflow); assert.equal(h.stats().creates, 1);
      const ticket = h.controller.pending()[0]!; await h.controller.approve(ticket.id);
      const tabs = await provider.listTabs(signal()); assert.equal(tabs.length, 1); assert.equal(tabs[0]!.title, 'Authenticated workspace');
      const observation = await provider.observe(signal()); assert.ok(observation.elements.some(el => el.role === 'searchbox'));
      await provider.type(observation.elements.find(el => el.role === 'searchbox')!.ref, 'The Nights', 'replace', signal());
      await assert.rejects(provider.type(observation.elements[0]!.ref, 'again', 'replace', signal()), /CONFLICT/);
      await provider.revokeTabAccess(tabs[0]!.id, signal()); assert.deepEqual(await provider.listTabs(signal()), []);
    });
    // Replay the same opening request: no second Chrome tab.
    const access = await h.controller.receive(request('requestTabAccess', { target: { kind: 'new', url: 'https://workspace.example/' }, purpose: 'Fixture', lifetime: 'task' }));
    const open = request('openTab', { accessRequestId: (access as any).accessRequestId });
    await h.controller.receive(open); await h.controller.receive(open); assert.equal(h.stats().creates, 2);
    assert.deepEqual(await h.controller.receive({ ...open, taskId: id() }), { outcome: 'ERROR', code: 'REJECTED' });
    await h.controller.approve((access as any).accessRequestId);
    const grant = h.controller.authorized()[0]!;
    assert.equal((await h.controller.receive(request('observe', { scopeId: grant.scopeId, tabId: grant.id }, { taskId: id() }))).outcome, 'ERROR');
    const navigate = await h.controller.receive(request('navigate', { scopeId: grant.scopeId, tabId: grant.id, url: 'https://other.example/' })); assert.equal((navigate as any).reason, 'ORIGIN_PERMISSION');
    await provider.endSession(session); await h.controller.reset(); assert.equal(h.stats().creates, 2); assert.ok(h.stats().invalidates > 0);
    await provider.close(); assert.equal(h.stats().closed, true); // No Chrome close method exists on this surface.
  } finally { h.close(); }
});
test('expired scopes/deadlines, cancelled queued calls and false epochs never execute', async () => {
  let now = Date.now(); let calls = 0;
  const surface = { current: async () => ({ id: 1, url: 'https://workspace.example/', title: 'Fixture' }), content: async () => { ++calls; return { outcome: 'OK', data: { completed: true } } as Reply; }, invalidate: async () => {} } as unknown as Surface;
  const controller = new ExtensionController(surface, () => {}, () => now, id); await controller.reset({ protocol: 'atlas.browser', version: 1, kind: 'hello', connectionEpoch: epoch });
  const access = await controller.receive(request('requestTabAccess', { target: { kind: 'current' }, purpose: 'Fixture', lifetime: 'task' })); await controller.approve((access as any).accessRequestId);
  const grant = controller.authorized()[0]!;
  assert.equal((await controller.receive(request('observe', { scopeId: grant.scopeId, tabId: grant.id }, { connectionEpoch: id() }))).outcome, 'ERROR');
  const expired = request('observe', { scopeId: grant.scopeId, tabId: grant.id }, { deadlineAt: now - 1 }); assert.equal((await controller.receive(expired)).outcome, 'ERROR');
  const queued = request('observe', { scopeId: grant.scopeId, tabId: grant.id }); const waiting = controller.receive(queued); controller.cancel({ protocol: 'atlas.browser', version: 1, kind: 'cancel', requestId: queued.requestId, backendSessionId: session, connectionEpoch: epoch }); assert.equal((await waiting).outcome, 'ERROR');
  const before = calls; now += 16 * 60_000; assert.equal((await controller.receive(request('observe', { scopeId: grant.scopeId, tabId: grant.id }, { deadlineAt: now + 1000 }))).outcome, 'ERROR'); assert.equal(calls, before);
});
test('multiple Chrome connections fail closed; uncertainty stays distinct from success and no silent sandbox fallback', async () => {
  const h = harness(); h.channels.push(id()); const provider = new AttachedChromeProvider(h.transport);
  try { await assert.rejects(provider.inSession(session, () => provider.listTabs(signal())), /AMBIGUOUS/);
    h.channels.pop(); const unknown = new AttachedChromeProvider({ ...h.transport, request: async () => ({ outcome: 'ERROR', code: 'EXECUTION_UNKNOWN' }) });
    const registry = new ToolRegistry(); registry.add(new BrowserAdapter(unknown)); const executor = new ToolExecutor(registry);
    const result = await unknown.inSession(id(), () => executor.invoke('unknown', 'browser.tabs', {})); assert.equal((result as any).category, 'EXECUTION_UNKNOWN'); assert.equal(h.stats().creates, 0);
    assert.ok(!registry.descriptors().some(tool => tool.id === 'browser.close'));
  } finally { h.close(); }
});
test('listo is bound to the handoff captured at speech start; never approves consequential confirmation', async () => {
  const calls: string[] = []; const messages: string[] = [];
  const continuation = new BrowserContinuation(async handoff => { calls.push(handoff); return { outcome: 'OK', data: { completed: true } }; }, text => messages.push(text)); const first = id(); const second = id();
  const state = (handoffId: string) => ({ workflow: { outcome: 'REQUIRES_USER_INTERACTION', reason: 'CAPTCHA', handoffId }, ready: null });
  continuation.update(state(first), false); continuation.speechStarted('early', false); continuation.update(state(second), false); await continuation.transcript('early', 'listo', false); assert.equal(calls.length, 0);
  continuation.speechStarted('sensitive', true); await continuation.transcript('sensitive', 'listo', true); assert.equal(calls.length, 0);
  continuation.speechStarted('yes', false); await continuation.transcript('yes', 'sí', false); assert.equal(calls.length, 0);
  continuation.speechStarted('valid', false); await continuation.transcript('valid', 'listo', false); await continuation.transcript('valid', 'listo', false); assert.deepEqual(calls, [second]); assert.equal(messages.length, 1);
});
test('extension manifest and attached source preserve minimum permissions/no prohibited extraction channels', async () => {
  const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
  assert.deepEqual(manifest.permissions, ['activeTab','scripting','nativeMessaging']);
  for (const key of ['host_permissions','optional_host_permissions','externally_connectable','content_scripts']) assert.equal(manifest[key], undefined);
  for (const path of ['extension/src/content-engine.ts','extension/src/service-worker.ts','src/browser/attached/provider.ts','native/Atlas.BrowserHost/Program.cs']) {
    const source = await readFile(path, 'utf8'); for (const forbidden of ['document.cookie', 'localStorage', 'sessionStorage', 'chrome.cookies', 'chrome.debugger', 'webRequest', 'connectOverCDP', 'captureVisibleTab']) assert.ok(!source.includes(forbidden), `${path}: ${forbidden}`);
  }
});

test('scope lifetimes/endTask/endSession, manual handoff resume and Chrome ownership remain distinct', async () => {
  const h = harness(); await h.controller.reset({ protocol: 'atlas.browser', version: 1, kind: 'hello', connectionEpoch: epoch });
  try {
    const sessionAccess: any = await h.controller.receive(request('requestTabAccess', { target: { kind: 'current' }, purpose: 'Fixture', lifetime: 'session' })); await h.controller.approve(sessionAccess.accessRequestId);
    const grant = h.controller.authorized()[0]!;
    assert.equal((await h.controller.receive(request('observe', { scopeId: grant.scopeId, tabId: grant.id }, { taskId: id() }))).outcome, 'OK');
    await h.controller.receive(request('endTask')); assert.equal(h.controller.authorized().length, 1);
    const otherTask = id();
    h.f.dom.window.document.body.innerHTML = '<h1>Verify you are human</h1>';
    const blocked: any = await h.controller.receive(request('observe', { scopeId: grant.scopeId, tabId: grant.id }, { taskId: otherTask })); assert.equal(blocked.reason, 'CHALLENGE');
    h.f.dom.window.document.body.innerHTML = '<input type="search" aria-label="Search">';
    assert.equal((await h.controller.receive(request('observe', { scopeId: grant.scopeId, tabId: grant.id }, { taskId: otherTask }))).outcome, 'REQUIRES_USER_INTERACTION');
    assert.equal((await h.controller.receive(request('observe', { scopeId: grant.scopeId, tabId: grant.id, resumeHandoffId: id() }, { taskId: otherTask }))).outcome, 'REQUIRES_USER_INTERACTION');
    assert.equal((await h.controller.receive(request('observe', { scopeId: grant.scopeId, tabId: grant.id, resumeHandoffId: blocked.handoffId }, { taskId: otherTask }))).outcome, 'OK');
    await h.controller.receive(request('endSession', {}, { taskId: otherTask })); assert.equal(h.controller.authorized().length, 0); assert.equal(h.stats().creates, 0);
  } finally { h.close(); }
});

test('real HTTP sessions separate access/manual states from consequential pending; resume uses executor and never decides', async () => {
  const h = harness(); await h.controller.reset({ protocol: 'atlas.browser', version: 1, kind: 'hello', connectionEpoch: epoch });
  const provider = new AttachedChromeProvider(h.transport); const adapter = new BrowserAdapter(provider); const registry = new ToolRegistry(); registry.add(adapter); let mutations = 0;
  registry.add({ integration: 'fixture', transport: 'local', tools: () => [{ id: 'fixture.sensitive', name: 'fixture_sensitive', description: 'Harmless test counter', integration: 'fixture', capability: 'counter', permission: 'SENSITIVE', schema: z.object({}).strict(), execute: async () => { ++mutations; return { completed: true }; } }] });
  const runtime = createToolsHandler({}, {}, { runtime: { registry, timezone: 'Europe/Madrid', browser: adapter } });
  const server = createServer(async (req, res) => { await runtime.handle(req, res); }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; let cookie = '';
  const post = (path: string, body: unknown) => fetch(base + '/api/tools/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  const invoke = async (toolId: string, input: unknown) => (await post('invoke', { invocationId: id(), toolId, input })).json() as Promise<any>;
  try {
    const created = await post('session', {}); cookie = created.headers.get('set-cookie')!.split(';')[0]!; const config = await created.json() as any; assert.ok(!config.tools.some((tool: any) => tool.id === 'browser.resume'));
    const access = await invoke('browser.requestAccess', { target: { kind: 'current' }, purpose: 'Fixture', lifetime: 'task' }); assert.equal(access.status, 'success'); assert.equal(access.data.browserState.outcome, 'ACCESS_PENDING');
    const activity = () => fetch(base + '/api/tools/activity', { headers: { Cookie: cookie } }).then(reply => reply.json()) as Promise<any>;
    assert.equal((await activity()).pending, null); await h.controller.approve(access.data.browserState.accessRequestId); assert.ok((await activity()).browser.ready);
    h.f.dom.window.document.body.innerHTML = '<input type="password">'; const observation = await invoke('browser.observe', {}); const handoff = observation.data.browserState.handoffId; assert.equal(observation.data.browserState.reason, 'AUTHENTICATION');
    const pending = await invoke('fixture.sensitive', {}); assert.equal(pending.status, 'pending'); assert.equal(mutations, 0);
    assert.equal((await post('browser-resume', { handoffId: handoff, utterance: 'listo' })).status, 400); assert.equal((await activity()).pending.confirmationId, pending.confirmationId); assert.equal(mutations, 0);
    await post('decision', { confirmationId: pending.confirmationId, approved: false }); assert.equal(mutations, 0);
    assert.equal((await post('invoke', { invocationId: id(), toolId: 'browser.resume', input: { handoffId: handoff } })).status, 400);
    h.f.dom.window.document.body.innerHTML = '<input type="search" aria-label="Search">'; const resumed = await post('browser-resume', { handoffId: handoff, utterance: 'listo' }); assert.equal((await resumed.json() as any).outcome, 'OK'); assert.equal(mutations, 0);
    const rows = (await activity()).activity; assert.ok(rows.some((row: any) => row.toolId === 'browser.resume' && row.permission === 'READ'));
    await fetch(base + '/api/tools/session', { method: 'DELETE', headers: { Cookie: cookie } }); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(h.controller.authorized().length, 0);
  } finally { runtime.close(); await new Promise<void>(resolve => server.close(() => resolve())); h.close(); }
});

test('double popup approval cannot grant the same Chrome tab twice or cross a reset', async () => {
  const h = harness(); await h.controller.reset({ protocol: 'atlas.browser', version: 1, kind: 'hello', connectionEpoch: epoch });
  try {
    const access: any = await h.controller.receive(request('requestTabAccess', { target: { kind: 'current' }, purpose: 'Fixture', lifetime: 'task' }));
    const first = h.controller.approve(access.accessRequestId);
    await assert.rejects(h.controller.approve(access.accessRequestId), /REJECTED/); await first;
    assert.equal(h.controller.authorized().length, 1); assert.equal(h.events.filter(event => event.event === 'accessGranted').length, 1);
    await h.controller.reset(); await assert.rejects(h.controller.approve(access.accessRequestId), /EXPIRED/); assert.equal(h.controller.authorized().length, 0);
  } finally { h.close(); }
});

test('attached search labels never authorize POST/custom button clicks on personal Chrome', async () => {
  for (const html of ['<form method="post"><button>Search</button></form>', '<button>Search</button>']) {
    const f = fixture(html); let clicks = 0; f.dom.window.document.querySelector('button')!.addEventListener('click', () => { ++clicks; });
    try {
      const observed: any = await f.run('observe'); const button = observed.data.elements.find((el: any) => el.role === 'button');
      const result: any = await f.run('click', { documentId: observed.data.documentId, snapshotId: observed.data.snapshotId, ref: button.ref });
      assert.equal(result.outcome, 'REQUIRES_USER_INTERACTION'); assert.equal(result.reason, 'UNSUPPORTED_CONTROL'); assert.equal(clicks, 0);
    } finally { f.close(); }
  }
});

const observedBinding = (observed: any, element = observed.data.elements[0]) => ({ documentId: observed.data.documentId, snapshotId: observed.data.snapshotId, ref: element.ref });
test('SPA background mutations keep the original search ref valid without reading private input values', async () => {
  const f = fixture('<form method="get"><input type="text" role="combobox" aria-label="Search"></form><div id="background"></div>');
  try {
    let events = 0; f.dom.window.document.querySelector('input')!.addEventListener('input', () => { ++events; });
    const observed: any = await f.run('observe');
    for (let n = 0; n < 20; n++) f.dom.window.document.querySelector('#background')!.textContent = String(n);
    await Promise.resolve();
    assert.deepEqual(await f.run('type', { ...observedBinding(observed), text: 'fixture search', mode: 'replace' }), { outcome: 'OK', data: { completed: true } });
    assert.equal(events, 1);
  } finally { f.close(); }
});
test('refs fail before execution on changes to identity, security, form context and element replacement', async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => f.dom.window.document.querySelector('input')!.setAttribute('aria-label', 'Send message'),
    f => f.dom.window.document.querySelector('input')!.setAttribute('role', 'button'),
    f => f.dom.window.document.querySelector('input')!.setAttribute('readonly', ''),
    f => f.dom.window.document.querySelector('input')!.setAttribute('autocomplete', 'cc-number'),
    f => f.dom.window.document.querySelector('input')!.setAttribute('disabled', ''),
    f => f.dom.window.document.querySelector('form')!.setAttribute('method', 'post'),
    f => f.dom.window.document.querySelector('form')!.setAttribute('action', '/different'),
    f => f.dom.window.document.querySelector('form')!.insertAdjacentHTML('beforeend', '<input type="hidden" name="different">'),
    f => { const input = f.dom.window.document.querySelector('input')!; input.replaceWith(input.cloneNode(true)); },
    f => { const input = f.dom.window.document.querySelector('input')!; const form = f.dom.window.document.createElement('form'); form.method = 'get'; f.dom.window.document.body.append(form); form.append(input); },
    f => f.dom.window.document.body.insertAdjacentHTML('beforeend', '<div role="dialog" aria-modal="true"><button>Search</button></div>')
  ];
  for (const change of changes) {
    const f = fixture(); try {
      let events = 0; f.dom.window.document.addEventListener('input', () => { ++events; });
      const observed: any = await f.run('observe'); change(f); await Promise.resolve();
      assert.deepEqual(await f.run('type', { ...observedBinding(observed), text: 'fixture', mode: 'replace' }), { outcome: 'ERROR', code: 'STALE_REF', conflict: { reason: 'ELEMENT_CHANGED', execution: 'NOT_EXECUTED' } });
      assert.equal(events, 0);
    } finally { f.close(); }
  }
});
test('type consumes its snapshot; observe → type → observe → press works despite dynamic mutations', async () => {
  const f = fixture(); let submitted = 0;
  f.dom.window.HTMLFormElement.prototype.requestSubmit = function() { ++submitted; };
  try {
    f.dom.window.document.querySelector('input')!.addEventListener('input', () => f.dom.window.document.body.insertAdjacentHTML('beforeend', '<span>background</span>'));
    const first: any = await f.run('observe'); const bind = observedBinding(first);
    assert.equal((await f.run('type', { ...bind, text: 'fixture', mode: 'replace' })).outcome, 'OK');
    assert.deepEqual(await f.run('press', { ...bind, key: 'Enter' }), { outcome: 'ERROR', code: 'STALE_REF', conflict: { reason: 'SNAPSHOT_CONSUMED', execution: 'NOT_EXECUTED' } });
    const next: any = await f.run('observe'); assert.notEqual(next.data.snapshotId, first.data.snapshotId);
    assert.equal((await f.run('press', { ...observedBinding(next), key: 'Enter' })).outcome, 'OK'); assert.equal(submitted, 1);
  } finally { f.close(); }
});
test('pushState, replaceState, history events and reload invalidate documents without revoking access', async () => {
  const f = fixture();
  try {
    for (const navigate of [() => f.dom.window.history.pushState({}, '', '/results'), () => f.dom.window.history.replaceState({}, '', '/updated'), () => f.dom.window.dispatchEvent(new f.dom.window.PopStateEvent('popstate')), () => f.engine.documentChanged()]) {
      const old: any = await f.run('observe'); navigate();
      assert.deepEqual(await f.run('click', observedBinding(old)), { outcome: 'ERROR', code: 'STALE_REF', conflict: { reason: 'DOCUMENT_CHANGED', execution: 'NOT_EXECUTED' } });
      const next: any = await f.run('observe'); assert.equal(next.outcome, 'OK'); assert.notEqual(next.data.documentId, old.data.documentId);
    }
    f.engine.revoke(); assert.deepEqual(await f.run('observe'), { outcome: 'ERROR', code: 'ACCESS_DENIED' });
  } finally { f.close(); }
});
test('same-origin documentChanged retains controller/backend grant and permits fresh observation', async () => {
  const h = harness(); const provider = new AttachedChromeProvider(h.transport); await h.controller.reset({ protocol: 'atlas.browser', version: 1, kind: 'hello', connectionEpoch: epoch });
  try { await provider.inSession(session, async () => {
    await assert.rejects(provider.requestTabAccess({ target: { kind: 'current' }, purpose: 'Fixture', lifetime: 'task' }, signal()).then(reply => { if (reply.outcome === 'ACCESS_PENDING') throw new BrowserWorkflow(reply); }), BrowserWorkflow);
    await h.controller.approve(h.controller.pending()[0]!.id); await provider.listTabs(signal());
    const old = await provider.observe(signal()); const grant = h.controller.authorized()[0]!;
    h.f.dom.window.history.pushState({}, '', '/results'); await h.controller.documentChanged(h.chosen.id);
    await assert.rejects(provider.type(old.elements[0]!.ref, 'fixture', 'replace', signal()), (error: any) => error.browserRecovery?.reason === 'DOCUMENT_CHANGED');
    assert.equal(h.controller.authorized()[0]!.scopeId, grant.scopeId); assert.equal(h.events.filter(e => e.event === 'accessRevoked').length, 0);
    const next = await provider.observe(signal()); await provider.type(next.elements[0]!.ref, 'fixture', 'replace', signal());
  }); } finally { h.close(); }
});
test('backend allows only two recoveries; observe does not reset budget and exhausted retries never dispatch', async () => {
  const h = harness(); const provider = new AttachedChromeProvider(h.transport); await h.controller.reset({ protocol: 'atlas.browser', version: 1, kind: 'hello', connectionEpoch: epoch });
  try { await provider.inSession(session, async () => {
    await provider.requestTabAccess({ target: { kind: 'current' }, purpose: 'Fixture', lifetime: 'task' }, signal()); await h.controller.approve(h.controller.pending()[0]!.id); await provider.listTabs(signal());
    let edited = 0; h.f.dom.window.document.addEventListener('input', () => { ++edited; });
    for (let attempt = 0; attempt < 3; attempt++) {
      const observed = await provider.observe(signal()); h.f.dom.window.document.querySelector('input')!.setAttribute('aria-label', 'Search ' + attempt);
      await assert.rejects(provider.type(observed.elements[0]!.ref, 'fixture', 'replace', signal()), (error: any) => error.browserRecovery?.execution === 'NOT_EXECUTED' && error.browserRecovery.recoverable === (attempt < 2) && error.browserRecovery.remainingRecoveries === 2 - attempt);
    }
    const fresh = await provider.observe(signal());
    await assert.rejects(provider.type(fresh.elements[0]!.ref, 'fixture', 'replace', signal()), (error: any) => error.browserRecovery?.recoverable === false);
    assert.equal(edited, 0);
  }); } finally { h.close(); }
});
test('different low-level successful interaction does not reset a pending recovery budget', async () => {
  const h = harness(); const provider = new AttachedChromeProvider(h.transport); await h.controller.reset({ protocol: 'atlas.browser', version: 1, kind: 'hello', connectionEpoch: epoch });
  try { await provider.inSession(session, async () => {
    await provider.requestTabAccess({ target: { kind: 'current' }, purpose: 'Fixture', lifetime: 'task' }, signal()); await h.controller.approve(h.controller.pending()[0]!.id); await provider.listTabs(signal());
    for (let step = 0; step < 3; step++) {
      const observed = await provider.observe(signal()); await provider.type(observed.elements[0]!.ref, 'fixture', 'replace', signal());
      await assert.rejects(provider.press(observed.elements[0]!.ref, 'Enter', signal()), (error: any) => error.browserRecovery?.reason === 'SNAPSHOT_CONSUMED' && error.browserRecovery.remainingRecoveries === 2 - step);
    }
  }); } finally { h.close(); }
});
test('EXECUTION_UNKNOWN/TIMEOUT after dispatch block future actions even after observe; no implicit retry', async () => {
  for (const code of ['EXECUTION_UNKNOWN','TIMEOUT'] as const) {
    const h = harness(); const base = h.transport; let dispatched = 0;
    const transport: BrowserTransport = { ...base, request: async (connection, req, signal) => { if (req.operation === 'type') { ++dispatched; await base.request(connection, req, signal); return { outcome: 'ERROR', code }; } return base.request(connection, req, signal); } };
    const provider = new AttachedChromeProvider(transport); await h.controller.reset({ protocol: 'atlas.browser', version: 1, kind: 'hello', connectionEpoch: epoch });
    try { await provider.inSession(session, async () => {
      await provider.requestTabAccess({ target: { kind: 'current' }, purpose: 'Fixture', lifetime: 'task' }, signal()); await h.controller.approve(h.controller.pending()[0]!.id); await provider.listTabs(signal());
      const first = await provider.observe(signal()); await assert.rejects(provider.type(first.elements[0]!.ref, 'fixture', 'replace', signal()), new RegExp(code));
      const next = await provider.observe(signal()); await assert.rejects(provider.type(next.elements[0]!.ref, 'fixture', 'replace', signal()), /EXECUTION_UNKNOWN/);
      await assert.rejects(provider.press(next.elements[0]!.ref, 'Enter', signal()), /EXECUTION_UNKNOWN/); assert.equal(dispatched, 1);
    }); } finally { h.close(); }
  }
});
test('post-effect content exceptions are EXECUTION_UNKNOWN without recoverable conflict metadata', async () => {
  const f = fixture(); try {
    const original = Object.getOwnPropertyDescriptor(f.dom.window.HTMLInputElement.prototype, 'value')!;
    Object.defineProperty(f.dom.window.HTMLInputElement.prototype, 'value', { ...original, set(value) { original.set!.call(this, value); throw new Error('PRIVATE_SENTINEL'); } });
    const observed: any = await f.run('observe'); const result = await f.run('type', { ...observedBinding(observed), text: 'fixture', mode: 'replace' });
    assert.deepEqual(result, { outcome: 'ERROR', code: 'EXECUTION_UNKNOWN' }); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  } finally { f.close(); }
});
test('conflict schema only permits sanitized pre-execution reasons on stale refs', () => {
  const conflict = { reason: 'ELEMENT_CHANGED', execution: 'NOT_EXECUTED' };
  assert.throws(() => replySchema.parse({ outcome: 'ERROR', code: 'EXECUTION_UNKNOWN', conflict }));
  assert.throws(() => replySchema.parse({ outcome: 'ERROR', code: 'STALE_REF', conflict: { ...conflict, privatePayload: 'PRIVATE' } }));
  assert.throws(() => replySchema.parse({ outcome: 'ERROR', code: 'STALE_REF', conflict: { reason: 'PRIVATE', execution: 'NOT_EXECUTED' } }));
});

test('abort after dispatch blocks another action before a delayed transport returns; observing cannot unlock it', async () => {
  const h = harness(); let release!: () => void; let entered!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; }); const received = new Promise<void>(resolve => { entered = resolve; }); let actions = 0;
  const transport: BrowserTransport = { ...h.transport, request: async (connection, req, signal) => {
    if (req.operation === 'type') { ++actions; entered(); await delayed; return { outcome: 'ERROR', code: 'EXECUTION_UNKNOWN' }; }
    return h.transport.request(connection, req, signal);
  } };
  const provider = new AttachedChromeProvider(transport); await h.controller.reset({ protocol: 'atlas.browser', version: 1, kind: 'hello', connectionEpoch: epoch });
  try { await provider.inSession(session, async () => {
    await provider.requestTabAccess({ target: { kind: 'current' }, purpose: 'Fixture', lifetime: 'task' }, signal()); await h.controller.approve(h.controller.pending()[0]!.id); await provider.listTabs(signal());
    const first = await provider.observe(signal()); const abort = new AbortController();
    const operation = provider.type(first.elements[0]!.ref, 'fixture', 'replace', abort.signal); const rejected = assert.rejects(operation, /EXECUTION_UNKNOWN/);
    await received; abort.abort();
    const next = await provider.observe(signal()); await assert.rejects(provider.type(next.elements[0]!.ref, 'fixture', 'replace', signal()), /EXECUTION_UNKNOWN/);
    assert.equal(actions, 1); release(); await rejected;
  }); } finally { release(); h.close(); }
});

test('revoked access is not a recoverable stale snapshot', async () => {
  const h = harness(); const provider = new AttachedChromeProvider(h.transport); await h.controller.reset({ protocol: 'atlas.browser', version: 1, kind: 'hello', connectionEpoch: epoch });
  try { await provider.inSession(session, async () => {
    await provider.requestTabAccess({ target: { kind: 'current' }, purpose: 'Fixture', lifetime: 'task' }, signal()); await h.controller.approve(h.controller.pending()[0]!.id); await provider.listTabs(signal());
    const observed = await provider.observe(signal()); await h.controller.revoke(h.controller.authorized()[0]!.scopeId);
    await assert.rejects(provider.type(observed.elements[0]!.ref, 'fixture', 'replace', signal()), (error: any) => error.category === 'REJECTED' && !error.browserRecovery);
  }); } finally { h.close(); }
});
test('navigation of another scope does not consume the active tab snapshot', async () => {
  const h = harness(); let emit!: (connection: string, event: any) => void; let actions = 0;
  const transport: BrowserTransport = { ...h.transport, subscribe: listener => { emit = listener; return h.transport.subscribe(listener); }, request: (connection, req, signal) => {
    if (req.operation === 'type') { ++actions; return Promise.resolve({ outcome: 'OK', data: { completed: true } }); }
    return h.transport.request(connection, req, signal);
  } };
  const provider = new AttachedChromeProvider(transport); await h.controller.reset({ protocol: 'atlas.browser', version: 1, kind: 'hello', connectionEpoch: epoch });
  try { await provider.inSession(session, async () => {
    await provider.requestTabAccess({ target: { kind: 'current' }, purpose: 'Fixture', lifetime: 'task' }, signal()); await h.controller.approve(h.controller.pending()[0]!.id); await provider.listTabs(signal());
    const observed = await provider.observe(signal());
    emit(h.channels[0]!, { protocol: 'atlas.browser', version: 1, connectionEpoch: epoch, backendSessionId: session, event: 'documentChanged', scopeId: id() });
    await provider.type(observed.elements[0]!.ref, 'fixture', 'replace', signal()); assert.equal(actions, 1);
  }); } finally { h.close(); }
});

async function grantedRuntime(transportOverride?: (base: BrowserTransport) => BrowserTransport) {
  const h = harness(); const provider = new AttachedChromeProvider(transportOverride?.(h.transport) ?? h.transport);
  await h.controller.reset({ protocol: 'atlas.browser', version: 1, kind: 'hello', connectionEpoch: epoch });
  const registry = new ToolRegistry(); registry.add(new BrowserAdapter(provider)); const executor = new ToolExecutor(registry);
  await provider.inSession(session, async () => {
    await provider.requestTabAccess({ target: { kind: 'current' }, purpose: 'Fixture', lifetime: 'task' }, signal());
    await h.controller.approve(h.controller.pending()[0]!.id); await provider.listTabs(signal());
  });
  const invoke = (operation: string, input: unknown = {}) => provider.inSession(session, () => executor.invoke(id(), 'browser.' + operation, input)) as Promise<any>;
  return { h, provider, executor, invoke };
}
test('production executor orchestrates type COMPLETED → one READ → press with new ref, never using consumed refs', async () => {
  const operations: string[] = []; const f = await grantedRuntime(base => ({ ...base, request: (connection, req, signal) => { operations.push(req.operation); return base.request(connection, req, signal); } }));
  let submits = 0; f.h.f.dom.window.HTMLFormElement.prototype.requestSubmit = function() { ++submits; };
  try {
    const first = await f.invoke('observe'); const input = first.data.elements[0]; operations.length = 0;
    const typed = await f.invoke('type', { ref: input.ref, text: 'fixture query', mode: 'replace' });
    assert.equal(typed.status, 'success'); assert.equal(typed.data.action.status, 'COMPLETED'); assert.equal(typed.data.observation.status, 'OK');
    assert.deepEqual(operations, ['type','observe']); assert.notEqual(typed.data.observation.data.elements[0].ref, input.ref);
    operations.length = 0;
    const stale = await f.invoke('press', { ref: input.ref, key: 'Enter' });
    assert.equal(stale.category, 'CONFLICT'); assert.equal(stale.browserRecovery.reason, 'SNAPSHOT_CONSUMED'); assert.equal(stale.browserObservation.status, 'OK');
    assert.deepEqual(operations, ['observe']); assert.equal(submits, 0);
    operations.length = 0;
    const pressed = await f.invoke('press', { ref: stale.browserObservation.data.elements[0].ref, key: 'Enter' });
    assert.equal(pressed.data.action.status, 'COMPLETED'); assert.equal(pressed.data.observation.status, 'OK');
    assert.deepEqual(operations, ['press','observe']); assert.equal(submits, 1);
  } finally { f.h.close(); }
});
test('action completion survives failed post-observe and duplicate type requests never execute again', async () => {
  let failure = false; let edits = 0; let reads = 0;
  const f = await grantedRuntime(base => ({ ...base, request: async (connection, req, signal) => {
    if (req.operation === 'observe') { ++reads; if (failure) return { outcome: 'ERROR', code: 'CONTENT_UNAVAILABLE' }; }
    const reply = await base.request(connection, req, signal);
    if (req.operation === 'type') { ++edits; failure = true; }
    return reply;
  } }));
  try {
    const observed = await f.invoke('observe'); const input = { ref: observed.data.elements[0].ref, text: 'fixture', mode: 'replace' };
    reads = 0; const typed = await f.invoke('type', input);
    assert.equal(typed.status, 'success'); assert.equal(typed.data.action.status, 'COMPLETED'); assert.deepEqual(typed.data.observation, { status: 'FAILED', reason: 'UPSTREAM' });
    assert.equal(typed.data.requiresFreshObservation, true); assert.equal(edits, 1); assert.equal(reads, 1);
    const repeated = await f.invoke('type', input); assert.equal(repeated.data.action.status, 'COMPLETED'); assert.equal(edits, 1);
    failure = false;
    const rejected = await f.invoke('press', { ref: input.ref, key: 'Enter' }); assert.equal(rejected.category, 'CONFLICT'); assert.equal(rejected.browserObservation.status, 'OK');
    assert.equal(edits, 1);
  } finally { f.h.close(); }
});
test('post-action READ EXECUTION_UNKNOWN does not change COMPLETED or lock unrelated safe action; unknown action never retries', async () => {
  let failRead = false; let failAction = false; let edits = 0;
  const f = await grantedRuntime(base => ({ ...base, request: async (connection, req, signal) => {
    if (req.operation === 'observe' && failRead) return { outcome: 'ERROR', code: 'EXECUTION_UNKNOWN' };
    if (req.operation === 'type') { ++edits; if (failAction) { await base.request(connection, req, signal); return { outcome: 'ERROR', code: 'EXECUTION_UNKNOWN' }; } }
    return base.request(connection, req, signal);
  } }));
  try {
    const observed = await f.invoke('observe'); failRead = true;
    const first = await f.invoke('type', { ref: observed.data.elements[0].ref, text: 'fixture', mode: 'replace' });
    assert.equal(first.data.action.status, 'COMPLETED'); assert.equal(first.data.observation.status, 'FAILED');
    failRead = false; const next = await f.invoke('observe'); failAction = true;
    const second = await f.invoke('type', { ref: next.data.elements[0].ref, text: 'different explicit step', mode: 'replace' }); assert.equal(second.category, 'EXECUTION_UNKNOWN');
    const fresh = await f.invoke('observe');
    const blocked = await f.invoke('type', { ref: fresh.data.elements[0].ref, text: 'different explicit step', mode: 'replace' }); assert.equal(blocked.category, 'EXECUTION_UNKNOWN'); assert.equal(edits, 2);
  } finally { f.h.close(); }
});
test('snapshot TTL starts after construction and never spends build time', async () => {
  const f = fixture(); let now = Date.now(); const engine = new ContentEngine(f.dom.window as any, () => now, id); engine.initialize(f.access);
  const original = f.dom.window.HTMLElement.prototype.checkVisibility;
  f.dom.window.HTMLElement.prototype.checkVisibility = function() { now += 1000; return original.call(this); };
  try {
    const before = now; const reply: any = await engine.run('observe', { scopeId: f.access.scopeId, tabId: f.access.tabId }, now + 60_000, { session, epoch });
    assert.equal(reply.outcome, 'OK'); assert.ok(now > before); assert.equal(reply.data.expiresAt, now + 15_000); assert.equal(reply.timings.observationBuildMs, now - before);
  } finally { engine.destroy(); f.close(); }
});
test('backend rejects received expired/near-expired snapshots without extending their TTL', async () => {
  let expiring = false;
  const f = await grantedRuntime(base => ({ ...base, request: async (connection, req, signal) => {
    const reply = await base.request(connection, req, signal);
    if (req.operation === 'observe' && reply.outcome === 'OK' && 'snapshotId' in reply.data && expiring) return { ...reply, data: { ...reply.data, expiresAt: Date.now() + 100 } };
    return reply;
  } }));
  try {
    expiring = true; const result = await f.invoke('observe'); assert.equal(result.category, 'CONFLICT'); assert.equal(result.browserRecovery.reason, 'SNAPSHOT_EXPIRED');
    expiring = false; const fresh = await f.invoke('observe'); assert.equal(fresh.status, 'success'); assert.ok(fresh.data.expiresAt > Date.now() + 250);
  } finally { f.h.close(); }
});
test('expired snapshot triggers a new READ and never silently remaps or executes the old action', async () => {
  let first = true; let expiry = 0; let edits = 0; const operations: string[] = [];
  const f = await grantedRuntime(base => ({ ...base, request: async (connection, req, signal) => {
    operations.push(req.operation); if (req.operation === 'type') ++edits;
    const reply = await base.request(connection, req, signal);
    if (req.operation === 'observe' && reply.outcome === 'OK' && 'snapshotId' in reply.data && first) { first = false; expiry = Date.now() + 500; return { ...reply, data: { ...reply.data, expiresAt: expiry } }; }
    return reply;
  } }));
  try {
    const observed = await f.invoke('observe'); assert.equal(observed.data.expiresAt, expiry);
    await new Promise(resolve => setTimeout(resolve, 300)); operations.length = 0;
    const input = { ref: observed.data.elements[0].ref, text: 'fixture', mode: 'replace' };
    const stale = await f.invoke('type', input); assert.equal(stale.browserRecovery.reason, 'SNAPSHOT_EXPIRED'); assert.equal(stale.browserObservation.status, 'OK'); assert.deepEqual(operations, ['observe']); assert.equal(edits, 0);
    const completed = await f.invoke('type', { ...input, ref: stale.browserObservation.data.elements[0].ref }); assert.equal(completed.data.action.status, 'COMPLETED'); assert.equal(edits, 1);
  } finally { f.h.close(); }
});
test('pending step budget cannot be reset by switching action; at most two pre-execution recoveries', async () => {
  const f = await grantedRuntime(); let edits = 0; f.h.f.dom.window.document.addEventListener('input', () => { ++edits; });
  try {
    const observed = await f.invoke('observe'); const typed = await f.invoke('type', { ref: observed.data.elements[0].ref, text: 'fixture', mode: 'replace' });
    let failed = await f.invoke('press', { ref: observed.data.elements[0].ref, key: 'Enter' }); assert.equal(failed.browserRecovery.remainingRecoveries, 2);
    const different = await f.invoke('type', { ref: typed.data.observation.data.elements[0].ref, text: 'other query', mode: 'replace' }); assert.equal(different.category, 'REJECTED'); assert.equal(different.browserObservation.reason, 'STEP_PENDING'); assert.equal(edits, 1);
    for (let remaining = 1; remaining >= 0; remaining--) {
      const ref = failed.browserObservation.data.elements[0].ref;
      const input = f.h.f.dom.window.document.querySelector('input')!; input.replaceWith(input.cloneNode(true));
      failed = await f.invoke('press', { ref, key: 'Enter' }); assert.equal(failed.browserRecovery.remainingRecoveries, remaining);
    }
    assert.equal(failed.browserRecovery.recoverable, false); assert.equal(failed.browserObservation.status, 'FAILED'); assert.equal(edits, 1);
  } finally { f.h.close(); }
});

test('post-action READ aborted or stalled preserves COMPLETED and does not replay the action', async () => {
  let hold = false; let entered!: () => void; let reads = 0; let edits = 0;
  const received = new Promise<void>(resolve => { entered = resolve; });
  const f = await grantedRuntime(base => ({ ...base, request: async (connection, req, signal) => {
    if (req.operation === 'observe' && hold) { ++reads; entered(); return new Promise(() => {}); }
    const result = await base.request(connection, req, signal); if (req.operation === 'type') ++edits; return result;
  } }));
  const aborted = new AbortController();
  try {
    const observed = await f.invoke('observe'); hold = true;
    const operation = f.provider.inSession(session, () => f.provider.interact('type', { ref: observed.data.elements[0].ref, text: 'fixture', mode: 'replace' }, async () => {
      await f.provider.type(observed.data.elements[0].ref, 'fixture', 'replace', aborted.signal); return { typed: true };
    }, aborted.signal));
    await received; aborted.abort();
    const result = await operation; assert.equal(result.action.status, 'COMPLETED'); assert.deepEqual(result.observation, { status: 'FAILED', reason: 'TIMEOUT' }); assert.equal(reads, 1); assert.equal(edits, 1);
    hold = false; const fresh = await f.invoke('observe'); assert.equal(fresh.status, 'success');
  } finally { f.h.close(); }
});
test('tool telemetry keeps sanitized conflict reasons and stage durations without page/text payloads', async () => {
  const f = await grantedRuntime(base => ({ ...base, request: async (connection, req, signal) => {
    const reply = await base.request(connection, req, signal); return { ...reply, timings: { ...reply.timings, injectionMs: 3, initializationMs: 2, returnMs: 1 } };
  } }));
  try {
    const first = await f.invoke('observe'); const typed = await f.invoke('type', { ref: first.data.elements[0].ref, text: 'PRIVATE_WRITTEN_SENTINEL', mode: 'replace' }); assert.equal(typed.data.action.status, 'COMPLETED');
    await f.invoke('press', { ref: first.data.elements[0].ref, key: 'Enter' });
    const rows = f.executor.telemetry.snapshot(); const conflict = rows.find(row => row.toolId === 'browser.press')!;
    assert.equal(conflict.reason, 'SNAPSHOT_CONSUMED');
    assert.ok(typeof conflict.timings?.queueMs === 'number'); assert.ok(typeof conflict.timings?.transportMs === 'number');
    assert.equal(conflict.timings?.injectionMs, 3); assert.equal(conflict.timings?.initializationMs, 2); assert.equal(conflict.timings?.returnMs, 1);
    assert.ok(!JSON.stringify(rows).includes('PRIVATE')); assert.ok(!JSON.stringify(rows).includes('fixture.example'));
  } finally { f.h.close(); }
});
