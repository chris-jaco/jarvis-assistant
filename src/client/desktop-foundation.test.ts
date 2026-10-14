import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createDesktopSecret, desktopApiAuthorized, desktopServerMode, DESKTOP_AUTH_HEADER } from '../server/desktop-auth.js';
import { DesktopBackendClient } from '../desktop/backend-client.js';
import { BackendSupervisor, backendEnvironment } from '../desktop/backend-supervisor.js';
import type { BackendProcess } from '../desktop/backend-supervisor.js';
import type { BackendStartupDiagnostic } from '../desktop/backend-supervisor.js';
import { acquireSingleInstance, focusExistingWindow } from '../desktop/lifecycle.js';
import { audioPermissionAllowed, sameApplicationLocation, secureWindowOptions } from '../desktop/window-policy.js';
import { registerDesktopIpc } from '../desktop/ipc.js';
import { DesktopCoreTransport, DesktopRealtimeTokenProvider } from '../provider/desktop-transport.js';

test('desktop API authentication is explicit, rotated and has no desktop fallback', () => {
  const first = createDesktopSecret(); const second = createDesktopSecret();
  assert.match(first, /^[a-f0-9]{64}$/); assert.notEqual(first, second);
  const mode = desktopServerMode({ ATLAS_DESKTOP_MODE: 'true', ATLAS_DESKTOP_SECRET: first }, '127.0.0.1');
  assert.equal(desktopApiAuthorized('/api/tools/session', {}, mode), false);
  assert.equal(desktopApiAuthorized('/api/tools/session', { [DESKTOP_AUTH_HEADER]: second }, mode), false);
  assert.equal(desktopApiAuthorized('/api/tools/session', { [DESKTOP_AUTH_HEADER]: first }, mode), true);
  assert.equal(desktopApiAuthorized('/', {}, mode), true);
  assert.equal(desktopApiAuthorized('/api/tools/session', {}, desktopServerMode({}, '127.0.0.1')), true);
  assert.throws(() => desktopServerMode({ ATLAS_DESKTOP_MODE: 'true', ATLAS_DESKTOP_SECRET: first }, '0.0.0.0'), /127\.0\.0\.1/);
  assert.throws(() => desktopServerMode({ ATLAS_DESKTOP_MODE: 'true' }, '127.0.0.1'), /ATLAS_DESKTOP_SECRET/);
});

test('desktop backend client authenticates every request, keeps server cookie and invalidates locally', async () => {
  const secret = 'a'.repeat(64); const calls: Array<{ url: string; headers: Headers }> = [];
  const client = new DesktopBackendClient('http://127.0.0.1:43123', secret, async (input, init) => {
    const headers = new Headers(init?.headers); calls.push({ url: String(input), headers });
    if (String(input).endsWith('/health')) return Response.json({ ready: true });
    if (String(input).endsWith('/session') && init?.method === 'POST') return Response.json({ tools: [], timezone: 'UTC', now: '' }, { headers: { 'Set-Cookie': `jarvis_session=${'b'.repeat(64)}; HttpOnly` } });
    if (String(input).endsWith('/token')) return Response.json({ value: 'ek_fixture' });
    return Response.json({ activity: [], pending: null });
  });
  await client.health(); await client.request('session.create', {}); await client.request('activity.get', undefined); assert.equal(await client.realtimeToken(), 'ek_fixture');
  assert.ok(calls.every(call => call.headers.get(DESKTOP_AUTH_HEADER) === secret));
  assert.equal(calls[2]?.headers.get('Cookie'), `jarvis_session=${'b'.repeat(64)}`);
  assert.equal(calls.some(call => call.url.includes(secret)), false);
  client.dispose(); await assert.rejects(client.health(), /DESKTOP_BACKEND_CLOSED/);
});

class FakeChild extends EventEmitter implements BackendProcess {
  stdout = new PassThrough(); stderr = new PassThrough(); pid = 4242; killed = 0;
  kill(): boolean { this.killed++; this.emit('exit', null); return true; }
  override once(event: 'spawn' | 'exit' | 'error', listener: (...args: any[]) => void): this { return super.once(event, listener); }
}

test('backend runtime environments separate Electron-as-Node from UtilityProcess', () => {
  const inherited = { SAFE_VALUE: 'kept', ELECTRON_RUN_AS_NODE: 'inherited' };
  const node = backendEnvironment(inherited, 'a'.repeat(64), 'node');
  const utility = backendEnvironment(inherited, 'b'.repeat(64), 'utility');
  assert.equal(node.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(utility.ELECTRON_RUN_AS_NODE, undefined);
  assert.deepEqual({ mode: utility.ATLAS_DESKTOP_MODE, host: utility.HOST, port: utility.PORT, safe: utility.SAFE_VALUE }, { mode: 'true', host: '127.0.0.1', port: '0', safe: 'kept' });
});

test('utility readiness accepts fragmented Windows CRLF, drains stderr and emits sanitized stages', async () => {
  const child = new FakeChild(); const events: BackendStartupDiagnostic[] = []; let spawnedEnv: NodeJS.ProcessEnv | undefined;
  const supervisor = new BackendSupervisor({ executable: 'electron', serverEntry: 'server.js', cwd: '.', runtime: 'utility', shutdownTimeoutMs: 5, diagnostic: event => events.push(event),
    spawn: (_executable, _args, options) => { spawnedEnv = options.env; return child; },
    clientFactory: endpoint => new DesktopBackendClient(endpoint.baseUrl, endpoint.secret, async input => Response.json(String(input).endsWith('/health') ? { ready: true } : { closing: true }))
  });
  const starting = supervisor.start(); child.emit('spawn'); child.stdout.write('ATLAS: http://127.0.0.1:431'); child.stdout.write('25\r\nATLAS_RE'); child.stdout.write('ADY 43125\r\n');
  assert.equal((await starting).baseUrl, 'http://127.0.0.1:43125');
  assert.equal(spawnedEnv?.ELECTRON_RUN_AS_NODE, undefined); assert.equal(child.stderr.readableFlowing, true);
  assert.deepEqual(events.map(event => event.stage), ['CORE_SPAWN_REQUESTED', 'CORE_SPAWNED', 'CORE_STDOUT_OBSERVED', 'CORE_READY_RECEIVED', 'CORE_HEALTH_STARTED', 'CORE_HEALTH_OK']);
  assert.ok(events.every(event => !JSON.stringify(event).includes('a'.repeat(64)))); await supervisor.stop();
});

test('backend supervisor owns one child, waits for readiness and bounds shutdown', async () => {
  const child = new FakeChild();
  const supervisor = new BackendSupervisor({ executable: 'electron', serverEntry: 'server.js', cwd: '.', shutdownTimeoutMs: 5,
    spawn: () => child, diagnostic: () => {},
    clientFactory: endpoint => new DesktopBackendClient(endpoint.baseUrl, endpoint.secret, async input => Response.json(String(input).endsWith('/health') ? { ready: true } : { closing: true }))
  });
  const starting = supervisor.start(); child.stdout.write('ATLAS_READY 43123\n');
  const endpoint = await starting; assert.equal(endpoint.baseUrl, 'http://127.0.0.1:43123'); assert.match(endpoint.secret, /^[a-f0-9]{64}$/);
  await assert.rejects(supervisor.start(), /ALREADY_STARTED/);
  await supervisor.stop(); assert.equal(child.killed, 1);
});

test('backend supervisor fails closed on startup timeout and reports an owned crash', async () => {
  const timedOut = new FakeChild(); const timeoutEvents: BackendStartupDiagnostic[] = [];
  const timeoutSupervisor = new BackendSupervisor({ executable: 'electron', serverEntry: 'server.js', cwd: '.', startupTimeoutMs: 5, spawn: () => timedOut, diagnostic: event => timeoutEvents.push(event) });
  await assert.rejects(timeoutSupervisor.start(), /START_TIMEOUT/); assert.equal(timedOut.killed, 1);
  assert.equal(timeoutEvents.filter(event => event.stage === 'CORE_READINESS_TIMEOUT').length, 1); assert.equal(timedOut.stderr.readableFlowing, true);
  const crashed = new FakeChild(); let crash: number | null | undefined;
  const crashSupervisor = new BackendSupervisor({ executable: 'electron', serverEntry: 'server.js', cwd: '.', spawn: () => crashed, diagnostic: () => {}, onUnexpectedExit: code => { crash = code; },
    clientFactory: endpoint => new DesktopBackendClient(endpoint.baseUrl, endpoint.secret, async input => Response.json(String(input).endsWith('/health') ? { ready: true } : { closing: true })) });
  const starting = crashSupervisor.start(); crashed.stdout.write('ATLAS_READY 43124\n'); await starting; crashed.emit('exit', 7); assert.equal(crash, 7); await crashSupervisor.stop();
});

test('backend exit before readiness is explicit, cleans up once and never waits for timeout', async () => {
  const child = new FakeChild(); const events: BackendStartupDiagnostic[] = [];
  const supervisor = new BackendSupervisor({ executable: 'electron', serverEntry: 'server.js', cwd: '.', startupTimeoutMs: 100, spawn: () => child, diagnostic: event => events.push(event) });
  const starting = supervisor.start(); child.emit('spawn'); child.emit('exit', 17);
  await assert.rejects(starting, /EXITED_EARLY/);
  assert.equal(events.filter(event => event.stage === 'CORE_EXITED_EARLY').length, 1);
  assert.equal(events.some(event => event.stage === 'CORE_READINESS_TIMEOUT'), false);
  assert.equal(child.killed, 0);
});

test('failed authenticated health is classified and cleans up the owned child', async () => {
  const child = new FakeChild(); const events: BackendStartupDiagnostic[] = [];
  const supervisor = new BackendSupervisor({ executable: 'electron', serverEntry: 'server.js', cwd: '.', shutdownTimeoutMs: 5, spawn: () => child, diagnostic: event => events.push(event),
    clientFactory: endpoint => new DesktopBackendClient(endpoint.baseUrl, endpoint.secret, async () => new Response(null, { status: 401 })) });
  const starting = supervisor.start(); child.emit('spawn'); child.stdout.write('ATLAS_READY 43126\n');
  await assert.rejects(starting, /DESKTOP_HEALTH_UNAUTHORIZED/);
  assert.deepEqual(events.slice(-2).map(event => [event.stage, event.healthFailure]), [['CORE_HEALTH_STARTED', undefined], ['CORE_HEALTH_FAILED', 'UNAUTHORIZED']]);
  assert.equal(child.killed, 1);
});

test('window policy isolates renderer, blocks external navigation and grants audio only', () => {
  const options = secureWindowOptions('preload.js');
  assert.deepEqual(options.webPreferences, { preload: 'preload.js', nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false });
  assert.equal(sameApplicationLocation('http://127.0.0.1:43123/page', 'http://127.0.0.1:43123'), true);
  assert.equal(sameApplicationLocation('https://example.com/', 'http://127.0.0.1:43123'), false);
  assert.equal(audioPermissionAllowed('media', 'http://127.0.0.1:43123/', ['audio'], 'http://127.0.0.1:43123'), true);
  assert.equal(audioPermissionAllowed('media', 'http://127.0.0.1:43123/', ['video'], 'http://127.0.0.1:43123'), false);
  assert.equal(audioPermissionAllowed('camera', 'http://127.0.0.1:43123/', ['audio'], 'http://127.0.0.1:43123'), false);
});

test('single instance focuses existing window and never starts a second owner', () => {
  let quit = 0; assert.equal(acquireSingleInstance({ requestSingleInstanceLock: () => false, quit: () => { quit++; } }), false); assert.equal(quit, 1);
  const actions: string[] = []; focusExistingWindow({ isMinimized: () => true, restore: () => actions.push('restore'), show: () => actions.push('show'), focus: () => actions.push('focus') });
  assert.deepEqual(actions, ['restore', 'show', 'focus']);
});

test('desktop IPC accepts only allowlisted operations from the trusted renderer', async () => {
  const handlers = new Map<string, Function>(); const listeners = new Map<string, Function>();
  const ipc = { handle: (name: string, fn: Function) => { handlers.set(name, fn); }, on: (name: string, fn: Function) => { listeners.set(name, fn); }, removeHandler: (name: string) => { handlers.delete(name); }, removeAllListeners: (name: string) => { listeners.delete(name); } };
  const client = { request: async (operation: string) => ({ data: { operation } }), realtimeToken: async () => 'ek_fixture' } as unknown as DesktopBackendClient;
  const cleanup = registerDesktopIpc(ipc as any, client, sender => sender === 7);
  const request = handlers.get('atlas:core-request')!;
  const id = '00000000-0000-4000-8000-000000000001';
  assert.deepEqual(await request({ sender: { id: 7 } }, id, 'activity.get', undefined, {}), { data: { operation: 'activity.get' } });
  await assert.rejects(request({ sender: { id: 8 } }, id, 'activity.get', undefined, {}), /SENDER_REJECTED/);
  await assert.rejects(request({ sender: { id: 7 } }, id, 'arbitrary.http', {}, {}), /REQUEST_REJECTED/);
  cleanup(); assert.equal(handlers.size, 0); assert.equal(listeners.size, 0);
});

test('desktop transport preserves correlation, timeout metadata and cancellation without retries', async () => {
  const calls: unknown[][] = []; const cancelled: string[] = [];
  const bridge = {
    core: {
      request: async (...args: unknown[]) => { calls.push(args); return { data: { activity: [], pending: null }, browserCall: 'b8' }; },
      cancel: (id: string) => { cancelled.push(id); }
    },
    realtime: { token: async () => 'ek_desktop_fixture' },
    lifecycle: { onShutdown: () => () => {}, ready: () => {} }
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { atlasDesktop: bridge } });
  try {
    const correlations: string[] = []; const transport = new DesktopCoreTransport();
    const result = await transport.request('activity.get', undefined, { timeoutMs: 1234, browserRequest: { sequence: 7, response: value => correlations.push(value) } });
    assert.deepEqual(result, { activity: [], pending: null }); assert.deepEqual(correlations, ['b8']); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.slice(1), ['activity.get', undefined, { timeoutMs: 1234, browserSequence: 7 }]);
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await assert.rejects(transport.request('activity.get', undefined, { signal: controller.signal }), /cancelled/); assert.equal(cancelled.length, 1); assert.equal(calls.length, 1);
    assert.equal(await new DesktopRealtimeTokenProvider().token(), 'ek_desktop_fixture');
  } finally { Reflect.deleteProperty(globalThis, 'window'); }
});
