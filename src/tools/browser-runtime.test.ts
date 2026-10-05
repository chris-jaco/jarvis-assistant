import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { access } from 'node:fs/promises';
import { chromium } from 'playwright';
import { RunContext } from '@openai/agents-core';
import { BrowserDiagnostics } from '../browser/diagnostics.js';
import { LocalBrowserProvider } from '../browser/local.js';
import { browserTracer, browserCode } from '../diagnostics/browser.js';
import type { BrowserDiagnostic } from '../diagnostics/browser.js';
import { BrowserAdapter } from './adapters/browser.js';
import { ToolRegistry } from './registry.js';
import { createToolsHandler } from '../server/tools.js';
import { VoiceToolBridge } from '../provider/tools.js';
import { ToolError } from './types.js';

function decoded<T>(value: unknown): T { return (typeof value === 'string' ? JSON.parse(value) : value) as T; }

test('browser diagnostics correlate nested/concurrent calls without raw invocation IDs or private errors', async () => {
  const rows: BrowserDiagnostic[] = []; const trace = new BrowserDiagnostics(true, row => rows.push(row));
  const owner = {}; const first = trace.received(owner, 'PRIVATE_TOKEN_SENTINEL', 'browser.open', 1);
  const second = trace.received({}, 'SECRET_COOKIE_SENTINEL', 'browser.status', 2);
  assert.equal(trace.received(owner, 'PRIVATE_TOKEN_SENTINEL', 'browser.open', 3).duplicate, true);
  assert.equal(trace.received(owner, 'PRIVATE_TOKEN_SENTINEL', 'browser.open', 3).call, first.call);
  await Promise.all([
    trace.inCall(owner, first, () => trace.run('navigation', async () => { await Promise.resolve(); return 'PRIVATE_PAGE_SENTINEL'; })),
    trace.inCall({}, second, async () => { await assert.rejects(trace.run('adapter', async () => { throw new Error('Authorization: Bearer SECRET_ERROR_SENTINEL'); })); })
  ]);
  assert.deepEqual(rows.filter(row => row.stage === 'navigation').map(row => row.call), [first.call, first.call]);
  assert.deepEqual(rows.filter(row => row.stage === 'adapter').map(row => row.call), [second.call, second.call]);
  assert.ok(rows.every(row => row.elapsedMs >= 0)); assert.ok(!JSON.stringify(rows).includes('SENTINEL'));
  assert.equal(browserCode('SECRET_ERROR_SENTINEL'), 'UPSTREAM');
  const silent: BrowserDiagnostic[] = []; browserTracer(false, row => silent.push(row))({ stage: 'action', code: 'OK', elapsedMs: 0 }); assert.equal(silent.length, 0);
  assert.equal(await new BrowserDiagnostics(true, () => { throw new Error(); }).run('observe', async () => 'ok'), 'ok');
  const controller = new AbortController(); await trace.run('action', async () => { controller.abort(); }, controller.signal);
  assert.equal(rows.at(-1)!.code, 'TIMEOUT');
});

test('HTTP/Realtime browser path matches isolated provider: streaming navigation, replay protection, status and reused context', async t => {
  let executable = process.env.TEST_BROWSER_EXECUTABLE;
  if (!executable) { try { await access(chromium.executablePath()); } catch { try { await access('/usr/bin/chromium'); executable = '/usr/bin/chromium'; } catch { t.skip('Install Chromium for runtime integration'); return; } } }
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined; let launches = 0;
  let releaseRequest!: () => void; const streaming = new Promise<void>(resolve => { releaseRequest = resolve; });
  const serverRows: BrowserDiagnostic[] = []; const clientRows: BrowserDiagnostic[] = [];
  const diagnostics = new BrowserDiagnostics(true, row => serverRows.push(row));
  const provider = new LocalBrowserProvider({ enabled: true, channel: 'chromium' }, async () => {
    ++launches; browser = await chromium.launch({ headless: true, executablePath: executable, args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });
    const context = await browser.newContext({ serviceWorkers: 'block' }); await context.newPage();
    context.on('page', page => { void page.route('https://fixture.example/**', async route => {
      if (route.request().url().endsWith('/live')) { await streaming; await route.abort().catch(() => {}); return; }
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>PRIVATE_PAGE_SENTINEL</title><script>fetch("/live")</script><input type="search" aria-label="Search">' });
    }); });
    return context;
  }, diagnostics);
  const adapter = new BrowserAdapter(provider, diagnostics); const registry = new ToolRegistry(); registry.add(adapter);
  const runtime = createToolsHandler({}, {}, { runtime: { registry, timezone: 'Europe/Madrid', browser: adapter } });
  const server = createServer(async (req, res) => { if (!await runtime.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const nativeFetch = globalThis.fetch; let cookie = ''; let bridge: VoiceToolBridge | undefined;
  globalThis.fetch = async (url, options) => {
    const headers = new Headers(options?.headers); if (cookie) headers.set('Cookie', cookie);
    const response = await nativeFetch(new URL(String(url), base), { ...options, headers });
    const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0]!;
    return response;
  };
  try {
    bridge = new VoiceToolBridge(() => {}, () => {}, undefined, row => clientRows.push(row));
    const config = await bridge.initialize(); const open = config.tools.find(tool => tool.name === 'browser_open')!;
    const result = await open.invoke(new RunContext(), JSON.stringify({ inputJson: JSON.stringify({ url: 'https://fixture.example/' }) }));
    assert.equal(decoded<{ status: string }>(result).status, 'success'); assert.equal(launches, 1);
    const page = browser!.contexts()[0]!.pages()[1]!;
    await assert.rejects(page.waitForLoadState('networkidle', { timeout: 250 }), /Timeout/);
    const resultRow = clientRows.find(row => row.stage === 'realtime_result')!;
    assert.ok(resultRow.call); assert.equal(resultRow.code, 'OK');
    const call = serverRows.filter(row => row.call === resultRow.call);
    for (const stage of ['http_received', 'adapter', 'provider_initialization', 'browser_launch', 'context_ready', 'startup_page', 'tab_creation', 'navigation', 'tab_metadata', 'provider_result', 'executor_result', 'http_result']) assert.ok(call.some(row => row.stage === stage), stage);
    assert.ok(call.every(row => row.tool === 'browser.open' && row.clientRequest === resultRow.clientRequest));
    assert.ok(!JSON.stringify([...serverRows, ...clientRows]).includes('PRIVATE_PAGE_SENTINEL'));
    assert.ok(!JSON.stringify(serverRows).includes('fixture.example')); assert.ok(!JSON.stringify(serverRows).includes(cookie));
    const firstTab = (await provider.getActiveTab(new AbortController().signal))!.id;
    const status = config.tools.find(tool => tool.name === 'browser_status')!;
    assert.equal(decoded<{ data: { connected: boolean } }>(await status.invoke(new RunContext(), '{"inputJson":"{}"}')).data.connected, true);
    const duplicateBody = { invocationId: 'PRIVATE_INVOCATION_SENTINEL', toolId: 'browser.open', input: { url: 'https://fixture.example/' } };
    const invoke = () => globalThis.fetch('/api/tools/invoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(duplicateBody) });
    const first = await invoke(); const repeated = await invoke(); assert.equal(first.headers.get('X-Atlas-Browser-Call'), repeated.headers.get('X-Atlas-Browser-Call'));
    assert.ok(serverRows.some(row => row.duplicate === true)); assert.ok(!JSON.stringify(serverRows).includes('PRIVATE_INVOCATION_SENTINEL'));
    assert.equal(browser!.contexts()[0]!.pages().length, 3); assert.equal(launches, 1);
    bridge.close(); await globalThis.fetch('/api/tools/session', { method: 'DELETE' });
    bridge = new VoiceToolBridge(() => {}, () => {}, undefined, row => clientRows.push(row));
    const reconnected = await bridge.initialize();
    const tabs = decoded<{ data: Array<{ id: string }> }>(await reconnected.tools.find(tool => tool.name === 'browser_tabs')!.invoke(new RunContext(), '{"inputJson":"{}"}'));
    assert.ok(tabs.data.some(tab => tab.id === firstTab)); assert.equal(launches, 1);
  } finally {
    releaseRequest(); bridge?.close(); globalThis.fetch = nativeFetch; runtime.close();
    await provider.close(); await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('real HTTP session replacement aborts the active browser call; simultaneous status is rejected rather than queued', async () => {
  const rows: BrowserDiagnostic[] = []; const diagnostics = new BrowserDiagnostics(true, row => rows.push(row));
  let began!: () => void; let release!: () => void; let executions = 0;
  const started = new Promise<void>(resolve => { began = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const provider = {
    status: async () => ({ available: true, connected: false, visible: true }), close: async () => {},
    openTab: async (_url: string, signal: AbortSignal) => { ++executions; began(); await gate; if (signal.aborted) throw new ToolError('TIMEOUT'); return { id: 'unused' }; }
  } as unknown as import('../browser/provider.js').BrowserProvider;
  const adapter = new BrowserAdapter(provider, diagnostics); const registry = new ToolRegistry(); registry.add(adapter);
  const runtime = createToolsHandler({}, {}, { runtime: { registry, timezone: 'Europe/Madrid', browser: adapter } });
  const server = createServer(async (req, res) => { if (!await runtime.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { 'Content-Type': 'application/json' }; let cookie = '';
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { ...headers, Cookie: cookie }, body: JSON.stringify(body) });
  try {
    const session = await post('/api/tools/session', {}); cookie = session.headers.get('set-cookie')!.split(';')[0]!;
    const opening = post('/api/tools/invoke', { invocationId: 'PRIVATE_OPEN_SENTINEL', toolId: 'browser.open', input: { url: 'https://fixture.example/' } });
    await started;
    assert.equal((await post('/api/tools/invoke', { invocationId: 'PRIVATE_STATUS_SENTINEL', toolId: 'browser.status', input: {} })).status, 429);
    const activity = await fetch(base + '/api/tools/activity', { headers: { Cookie: cookie } }); assert.equal(activity.status, 200);
    assert.ok(rows.some(row => row.stage === 'http_busy'));
    const replacement = await post('/api/tools/session', {}); assert.equal(replacement.status, 200);
    const response = await opening; const result = await response.json() as { status: string; category: string };
    assert.deepEqual([result.status, result.category], ['error', 'TIMEOUT']);
    assert.equal(executions, 1);
    const call = response.headers.get('X-Atlas-Browser-Call')!;
    const sequence = rows.filter(row => row.call === call).map(row => row.stage);
    assert.ok(sequence.indexOf('session_replaced') < sequence.indexOf('execution_abort'));
    assert.ok(rows.some(row => row.call === call && row.stage === 'executor_result' && row.code === 'TIMEOUT'));
    assert.ok(!JSON.stringify(rows).includes('SENTINEL')); assert.ok(!JSON.stringify(rows).includes('fixture.example'));
  } finally {
    release(); runtime.close(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
