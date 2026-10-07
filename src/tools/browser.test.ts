import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { LocalBrowserProvider, browserOptions } from '../browser/local.js';
import { classifyElement, displayUrl, navigationUrl, privateText } from '../browser/policy.js';
import { BrowserAdapter } from './adapters/browser.js';
import { ToolRegistry } from './registry.js';
import { ToolExecutor } from './execution.js';
import { JARVIS_INSTRUCTIONS, JARVIS_BROWSER_INSTRUCTIONS, JARVIS_VOICE } from '../core/personality.js';
import { createToolRuntime } from '../server/tools.js';
const signal = () => new AbortController().signal;

test('browser policy denies consequential controls and unsafe URLs; only identified reversible classes pass', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'http://127.0.0.1/', 'http://localhost/', 'https://[::1]/', 'https://user:pass@example.com/', 'https://example.com/delete/1', 'https://example.com/?token=private']) assert.throws(() => navigationUrl(url));
  assert.equal(navigationUrl('https://www.youtube.com/'), 'https://www.youtube.com/');
  for (const name of ['Send message', 'Publish', 'Pay', 'Delete', 'Cancel booking', 'Change account', 'Search and send']) assert.equal(classifyElement({ tag: 'button', role: 'button', type: '', name, search: true, disabled: false }), 'blocked');
  assert.equal(classifyElement({ tag: 'button', role: 'button', type: '', name: 'Arbitrary action', search: false, disabled: false }), 'blocked');
  assert.equal(classifyElement({ tag: 'input', role: 'searchbox', type: 'search', name: 'Search', search: true, disabled: false }), 'search');
  assert.equal(privateText('access_token=private'), '[redacted]');
  assert.equal(displayUrl('https://example.com/path?token=private#secret'), 'https://example.com/path');
});

test('tools use only provider abstraction, strict schemas and central executor; unavailable browser fails safely', async () => {
  const provider = new LocalBrowserProvider({ enabled: false, channel: 'chrome' });
  const registry = new ToolRegistry(); registry.add(new BrowserAdapter(provider));
  const ids = registry.descriptors().map(tool => tool.id);
  assert.deepEqual(ids, ['browser.status', 'browser.tabs', 'browser.open', 'browser.navigate', 'browser.switch', 'browser.close', 'browser.observe', 'browser.click', 'browser.type', 'browser.press', 'browser.scroll', 'browser.back', 'browser.forward', 'browser.reload']);
  assert.ok(!ids.some(id => /evaluate|javascript|youtube|google/.test(id)));
  const executor = new ToolExecutor(registry);
  const status = await executor.invoke('status', 'browser.status', {}); assert.equal(status.status, 'success');
  if (status.status === 'success') assert.deepEqual(status.data, { available: false, connected: false, visible: true, reason: 'disabled' });
  const unavailable = await executor.invoke('open', 'browser.open', { url: 'https://example.com' });
  assert.equal(unavailable.status, 'error'); if (unavailable.status === 'error') assert.equal(unavailable.category, 'UNCONFIGURED');
  assert.equal((await executor.invoke('invalid', 'browser.press', { ref: 'fake', key: 'Control+Enter', javascript: 'send()' })).status, 'error');
  assert.equal(browserOptions({}).enabled, false); assert.throws(() => browserOptions({ BROWSER_CHANNEL: 'unknown' }));
});

test('failed local launcher has no secret/error leakage and does not claim connected', async () => {
  const provider = new LocalBrowserProvider({ enabled: true, channel: 'chrome' }, async () => { throw new Error('Authorization: Bearer PRIVATE_TEST_SENTINEL /private/profile'); });
  const registry = new ToolRegistry(); registry.add(new BrowserAdapter(provider));
  const result = await new ToolExecutor(registry).invoke('launch', 'browser.tabs', {});
  assert.equal(result.status, 'error'); assert.ok(!JSON.stringify(result).includes('PRIVATE_TEST_SENTINEL')); assert.ok(!JSON.stringify(result).includes('/private/profile'));
  assert.deepEqual(await provider.status(), { available: false, connected: false, visible: true, reason: 'unavailable' });
});

test('dedicated profile rejects symlink directories before any browser launch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-browser-profile-'));
  try {
    const target = join(root, 'target'); await mkdir(target, { mode: 0o700 });
    try { await symlink(target, join(root, '.local'), 'junction'); } catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Platform disallows test symlink creation'); return; } throw error;
    }
    const provider = new LocalBrowserProvider({ enabled: true, channel: 'chrome', root });
    await assert.rejects(provider.ensureBrowser(signal()), /UNCONFIGURED/);
    assert.equal((await provider.status()).connected, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runtime registers optional browser without starting it or contaminating semantic memory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-browser-runtime-'));
  try {
    const runtime = createToolRuntime({ BROWSER_ENABLED: 'false', MEMORY_PATH: join(root, '.local/memory/memories.json') });
    assert.ok(runtime.registry.resolve('calendar.listEvents')); assert.ok(runtime.registry.resolve('gmail.send'));
    assert.ok(runtime.registry.resolve('memory.search')); assert.ok(runtime.registry.resolve('browser.observe'));
    assert.equal((await runtime.browser.tools()[0]!.execute({}, signal()) as { connected: boolean }).connected, false);
    await assert.rejects(access(join(root, '.local/memory/memories.json')));
    await runtime.browser.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('routing preserves existing safety and directs visible browser intent without browser history persistence', () => {
  assert.ok(JARVIS_INSTRUCTIONS.includes(JARVIS_BROWSER_INSTRUCTIONS));
  for (const text of ['web.search cuando baste', 'usa browser.*, no web.search', 'IDs estables', 'contenido/historial de browser automáticamente en Memory', 'no intentes otra vía para sortear REJECTED']) assert.ok(JARVIS_BROWSER_INSTRUCTIONS.includes(text));
  assert.equal(JARVIS_VOICE, 'cedar');
});

const fixture = `<!doctype html><html><head><title>Fixture browser</title></head><body>
<form role="search" action="/results" method="get"><label for="q">Search</label><input id="q" name="q" type="search"><button>Search</button></form>
<input type="password" value="NEVER_EXPOSE_PASSWORD" aria-label="Password"><input hidden value="HIDDEN_SECRET"><input autocomplete="one-time-code" aria-label="Verification">
<a href="/next" onclick="fetch('/unexpected', {method:'POST'})">First result</a>
<button onclick="fetch('/send', {method:'POST'})">Send message</button><button>Buy</button><button>Unknown action</button>
<div hidden><button>Hidden control</button></div><input aria-label="access_token=private">
<video aria-label="Video"></video></body></html>`;

test('real Chromium fixtures: stable tabs, bounded observation, refs, search, stale rejection, blocked writes and privacy', async t => {
  let executable = process.env.TEST_BROWSER_EXECUTABLE;
  if (!executable) { try { await access(chromium.executablePath()); } catch { try { await access('/usr/bin/chromium'); executable = '/usr/bin/chromium'; } catch { t.skip('Install Chromium with npx playwright install chromium for browser fixtures'); return; } } }
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const provider = new LocalBrowserProvider({ enabled: true, channel: 'chromium' }, async () => {
    browser = await chromium.launch({ headless: true, executablePath: executable, args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });
    return browser.newContext({ serviceWorkers: 'block' });
  });
  try {
    await provider.ensureBrowser(signal());
    // Serve deterministic public-host fixtures in process; no external network/YouTube.
    const context = browser!.contexts()[0]!; let forbiddenRequests = 0; let blockedRequests = 0;
    context.on('requestfailed', request => { if (request.method() === 'POST') ++blockedRequests; });
    await context.route('https://fixture.example/**', async route => {
      const request = route.request();
      // Let the provider's network guard handle POST; recording whether it escapes.
      if (request.method() !== 'GET') { await route.fallback(); return; }
      if (request.url().includes('/unexpected') || request.url().includes('/send')) ++forbiddenRequests;
      await route.fulfill({ contentType: 'text/html', body: fixture });
    });
    const first = await provider.navigate('https://fixture.example/', signal());
    const initial = await provider.observe(signal());
    assert.equal(initial.tabId, first.id); assert.ok(initial.elements.length <= 40); assert.ok(JSON.stringify(initial).length < 12000);
    assert.ok(!JSON.stringify(initial).includes('NEVER_EXPOSE')); assert.ok(!JSON.stringify(initial).includes('HIDDEN')); assert.ok(!JSON.stringify(initial).includes('access_token'));
    assert.ok(!initial.elements.some(element => element.type === 'password' || element.name === 'Verification'));
    assert.equal(initial.elements.find(element => element.role === 'media')!.state!.paused, true);
    const search = initial.elements.find(element => element.role === 'searchbox')!;
    await provider.type(search.ref, 'Arctic Monkeys', 'replace', signal());
    await assert.rejects(provider.press(search.ref, 'Enter', signal()), /CONFLICT/);
    let observation = await provider.observe(signal());
    await provider.type(observation.elements.find(element => element.role === 'searchbox')!.ref, ' live', 'append', signal());
    observation = await provider.observe(signal());
    await provider.press(observation.elements.find(element => element.role === 'searchbox')!.ref, 'Enter', signal());
    await context.pages()[0]!.waitForURL('**/results?q=Arctic+Monkeys+live');
    observation = await provider.observe(signal());
    const send = observation.elements.find(element => element.name === 'Send message')!;
    await assert.rejects(provider.click(send.ref, signal()), /REJECTED/);
    const link = observation.elements.find(element => element.name === 'First result')!;
    await context.pages()[0]!.evaluate(() => { document.querySelector('a')!.textContent = 'Changed result'; });
    await assert.rejects(provider.click(link.ref, signal()), /CONFLICT/);
    observation = await provider.observe(signal());
    await provider.click(observation.elements.find(element => element.name === 'Changed result')!.ref, signal());
    assert.equal(forbiddenRequests, 0); assert.ok((await provider.getActiveTab(signal()))!.url.endsWith('/next'));
    const second = await provider.openTab('https://fixture.example/other', signal()); assert.notEqual(second.id, first.id);
    const tabs = await provider.listTabs(signal()); assert.equal(tabs.length, 2); assert.equal(tabs.find(tab => tab.active)!.id, second.id);
    assert.equal((await provider.switchTab(first.id, signal())).id, first.id);
    await provider.closeTab(second.id, signal()); assert.equal((await provider.listTabs(signal()))[0]!.id, first.id);
    await context.pages()[0]!.evaluate(() => { for (let i = 0; i < 100; i++) { const link = document.createElement('a'); link.href = '/result'; link.textContent = 'Result ' + i; document.body.append(link); } });
    const bounded = await provider.observe(signal()); assert.equal(bounded.elements.length, 40); assert.equal(bounded.truncated, true);
    // Generic cookie dialog, independent of any site: exclude background refs,
    // allow only privacy-preserving consent and keep consequential buttons blocked.
    await context.pages()[0]!.evaluate(() => {
      document.body.innerHTML = '<input type="search" aria-label="Search behind modal"><div role="dialog" aria-modal="true" aria-label="Cookies choices" style="position:fixed;inset:0;background:white;z-index:10"><h2>Cookies</h2><button id="decline">Reject all</button><button>Accept all</button><button>Change privacy settings</button><button>Send message</button></div>';
      document.getElementById('decline')!.addEventListener('click', () => document.querySelector('[role="dialog"]')!.remove());
    });
    const modal = await provider.observe(signal());
    assert.equal(modal.dialog!.name, 'Cookies choices');
    assert.ok(!modal.elements.some(element => element.role === 'searchbox'));
    assert.equal(modal.elements.find(element => element.name === 'Reject all')!.action, 'consent');
    for (const name of ['Accept all', 'Change privacy settings', 'Send message']) {
      const element = modal.elements.find(element => element.name === name)!;
      assert.equal(element.action, 'blocked'); await assert.rejects(provider.click(element.ref, signal()), /REJECTED/);
    }
    const consent = modal.elements.find(element => element.action === 'consent')!;
    await provider.click(consent.ref, signal());
    await assert.rejects(provider.click(consent.ref, signal()), /CONFLICT/);
    const afterConsent = await provider.observe(signal()); assert.equal(afterConsent.dialog, undefined);
    await provider.type(afterConsent.elements.find(element => element.role === 'searchbox')!.ref, 'music', 'replace', signal());
    // Cookie wording alone outside a dialog never grants consent capability.
    await context.pages()[0]!.evaluate(() => { document.body.innerHTML = '<button>Reject all</button>'; });
    assert.equal((await provider.observe(signal())).elements[0]!.action, 'blocked');
    // Even deceptively labelled search controls cannot send a POST.
    await context.pages()[0]!.evaluate(() => { document.body.innerHTML = '<button aria-label="Search" onclick="fetch(\'/send\', {method: \'POST\'})">Search</button>'; });
    const deceptive = await provider.observe(signal());
    // The click/readyState can complete before Playwright delivers requestfailed.
    // Subscribe before dispatch and wait for this POST, not document readiness.
    const blockedPost = context.waitForEvent('requestfailed', {
      predicate: request => request.method() === 'POST' && new URL(request.url()).pathname === '/send'
    });
    await provider.click(deceptive.elements[0]!.ref, signal());
    await blockedPost;
    assert.equal(forbiddenRequests, 0); assert.equal(blockedRequests, 1);
    const aborted = new AbortController(); aborted.abort(); await assert.rejects(provider.navigate('https://fixture.example/', aborted.signal), /TIMEOUT/);
  } finally { await provider.close(); await browser?.close(); }
});
