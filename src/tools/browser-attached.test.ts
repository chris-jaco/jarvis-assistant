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
    f.dom.window.document.querySelector('button')!.textContent = 'Send message'; await Promise.resolve(); assert.deepEqual(await f.run('click', binding), { outcome: 'ERROR', code: 'STALE_REF' });
    f.engine.initialize({ ...f.access, epoch: id() }); assert.equal((await f.run('click', binding)).outcome, 'ERROR');
  } finally { f.close(); }
  let now = Date.now(); const t = fixture(); const timed = new ContentEngine(t.dom.window as any, () => now, id); timed.initialize(t.access);
  try { const reply: any = await timed.run('observe', { scopeId: t.access.scopeId, tabId: t.access.tabId }, now + 1000, { session, epoch }); now += 16_000; const media = reply.data.elements.find((el: any) => el.role === 'media'); assert.deepEqual(await timed.run('media', { scopeId: t.access.scopeId, tabId: t.access.tabId, documentId: reply.data.documentId, snapshotId: reply.data.snapshotId, ref: media.ref, action: 'play' }, now + 1000, { session, epoch }), { outcome: 'ERROR', code: 'STALE_REF' }); } finally { timed.destroy(); t.close(); }
});
function harness() {
  let creates = 0; let invalidates = 0; const events: any[] = []; const chosen = { id: 7, url: 'https://workspace.example/', title: 'Authenticated workspace' };
  const f = fixture(); const listeners = new Set<(connection: string, event: any) => void>(); const connection = id();
  const surface: Surface = { current: async () => chosen, create: async url => { ++creates; chosen.url = url; return chosen.id; }, activate: async () => {}, navigate: async (_id, url) => { chosen.url = url; }, history: async () => {}, invalidate: async () => { ++invalidates; f.engine.revoke(); }, content: async (_id, grant, req) => { try { f.engine.initialize({ scopeId: grant.scopeId, tabId: grant.tabId, session: grant.session, epoch: req.connectionEpoch, origin: grant.origin, expiresAt: grant.expiresAt }); return f.engine.run(req.operation, req.args, req.deadlineAt, { session: req.backendSessionId, epoch: req.connectionEpoch }); } catch { return { outcome: 'REQUIRES_USER_INTERACTION', reason: 'ORIGIN_PERMISSION', handoffId: id() }; } } };
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
