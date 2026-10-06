import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { parseRequest } from '../browser/attached/protocol.js';

test('compiled MV3 content script in real Chromium: scope, privacy, append, stale refs, manual CAPTCHA and revocation', async t => {
  let executable = process.env.TEST_BROWSER_EXECUTABLE;
  if (!executable) { try { await access(chromium.executablePath()); } catch { try { await access('/usr/bin/chromium'); executable = '/usr/bin/chromium'; } catch { t.skip('Install Chromium for compiled content integration'); return; } } }
  const browser = await chromium.launch({ headless: true, executablePath: executable, args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });
  try {
    const page = await browser.newPage();
    await page.route('https://fixture.example/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Fixture authenticated workspace</title><form method="get" action="/search"><input type="search" name="q" aria-label="Search"><button>Search</button></form><input hidden type="password" value="PRIVATE_PASSWORD"><button>Delete account</button><video></video>' }));
    await page.goto('https://fixture.example/');
    const extensionId = 'a'.repeat(32);
    await page.evaluate(extensionId => {
      const target = window as any;
      // Fixture transport only. Real activeTab authorization is acceptance-tested in Windows.
      target.chrome = { runtime: { id: extensionId, onMessage: { addListener(listener: unknown) { target.fixtureListener = listener; } } } };
      target.fixtureReads = 0;
      Object.defineProperty(document, 'cookie', { get() { ++target.fixtureReads; throw new Error('PRIVATE_COOKIE'); } });
      for (const key of ['localStorage','sessionStorage']) Object.defineProperty(window, key, { get() { ++target.fixtureReads; throw new Error('PRIVATE_STORAGE'); } });
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
      target.fixtureReadSearch = () => descriptor.get!.call(document.querySelector('input[type=search]')); // Test-only inspection of our fake search field.
      Object.defineProperty(HTMLInputElement.prototype, 'value', { ...descriptor, get() { ++target.fixtureReads; throw new Error('PRIVATE_VALUE'); } });
    }, extensionId);
    await page.addScriptTag({ path: 'dist/extension/content.js' });
    const scopeId = randomUUID(); const tabId = randomUUID(); const session = randomUUID(); const epoch = randomUUID(); const task = randomUUID();
    const send = (raw: unknown, sender = { id: extensionId }) => page.evaluate(({ raw, sender }) => new Promise<any>(resolve => { const accepted = (window as any).fixtureListener(raw, sender, resolve); if (accepted === false) resolve(undefined); }), { raw, sender });
    await send({ kind: 'init', access: { scopeId, tabId, session, epoch, origin: 'https://fixture.example', expiresAt: Date.now() + 900_000 } });
    const command = (operation: 'observe'|'type'|'click'|'media', args: Record<string, unknown> = {}) => send(parseRequest({ protocol: 'atlas.browser', version: 1, kind: 'request', requestId: randomUUID(), backendSessionId: session, taskId: task, connectionEpoch: epoch, deadlineAt: Date.now() + 10000, operation, args: { scopeId, tabId, ...args } }));
    let observed = await command('observe'); assert.equal(observed.outcome, 'OK'); assert.ok(!JSON.stringify(observed).includes('PRIVATE')); const binding = (data: any, ref: string) => ({ documentId: data.documentId, snapshotId: data.snapshotId, ref });
    let search = observed.data.elements.find((el: any) => el.role === 'searchbox'); assert.equal((await command('type', { ...binding(observed.data, search.ref), text: 'The Nights', mode: 'replace' })).outcome, 'OK');
    observed = await command('observe'); search = observed.data.elements.find((el: any) => el.role === 'searchbox'); assert.equal((await command('type', { ...binding(observed.data, search.ref), text: ' Avicii', mode: 'append' })).outcome, 'OK');
    // The test inspects its own fake input using the saved native getter; production never calls it.
    assert.equal(await page.evaluate(() => (window as any).fixtureReadSearch()), 'The Nights Avicii');
    assert.equal(await page.evaluate(() => (window as any).fixtureReads), 0);
    assert.equal((await command('click', binding(observed.data, search.ref))).code, 'STALE_REF');
    observed = await command('observe'); const dangerous = observed.data.elements.find((el: any) => el.name === 'Delete account'); assert.equal((await command('click', binding(observed.data, dangerous.ref))).code, 'REJECTED');
    await page.evaluate(() => { document.body.innerHTML = '<h1>Verify you are human</h1>'; }); assert.equal((await command('observe')).reason, 'CHALLENGE');
    await send({ kind: 'revoke' }); assert.equal((await command('observe')).code, 'ACCESS_DENIED');
    assert.equal(await send({ kind: 'revoke' }, { id: 'b'.repeat(32) }), undefined);
  } finally { await browser.close(); }
});

test('real Chromium SPA refs survive background DOM churn, consume after editing and invalidate on History API/full navigation', async t => {
  let executable = process.env.TEST_BROWSER_EXECUTABLE;
  if (!executable) { try { await access(chromium.executablePath()); } catch { try { await access('/usr/bin/chromium'); executable = '/usr/bin/chromium'; } catch { t.skip('Install Chromium for compiled content integration'); return; } } }
  const browser = await chromium.launch({ headless: true, executablePath: executable, args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });
  try {
    const page = await browser.newPage(); const extensionId = 'a'.repeat(32);
    await page.route('https://fixture.example/**', route => route.fulfill({ contentType: 'text/html', body: '<form method="get" action="/results"><input type="text" role="combobox" aria-label="Search" name="q"></form><div id="background"></div>' }));
    await page.addInitScript(extensionId => {
      const target = window as any;
      target.chrome = { runtime: { id: extensionId, onMessage: { addListener(listener: unknown) { target.fixtureListener = listener; } } } };
    }, extensionId);
    const cdp = await page.context().newCDPSession(page); let contextId: number;
    const contentSource = await readFile('dist/extension/content.js', 'utf8');
    const scopeId = randomUUID(); const tabId = randomUUID(); const session = randomUUID(); const epoch = randomUUID(); const task = randomUUID();
    const evaluateIsolated = async (expression: string) => {
      const result = await cdp.send('Runtime.evaluate', { expression, contextId, awaitPromise: true, returnByValue: true });
      assert.equal(result.exceptionDetails, undefined); return result.result.value;
    };
    const send = (raw: unknown) => evaluateIsolated(`new Promise(resolve => globalThis.fixtureListener(${JSON.stringify(raw)}, { id: ${JSON.stringify(extensionId)} }, resolve))`);
    const install = async () => {
      const tree = await cdp.send('Page.getFrameTree');
      const world = await cdp.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'Atlas fixture ISOLATED' }); contextId = world.executionContextId;
      await evaluateIsolated(`globalThis.chrome = { runtime: { id: ${JSON.stringify(extensionId)}, onMessage: { addListener(listener) { globalThis.fixtureListener = listener; } } } };`);
      await evaluateIsolated(contentSource);
      await send({ kind: 'init', access: { scopeId, tabId, session, epoch, origin: 'https://fixture.example', expiresAt: Date.now() + 900_000 } });
    };
    const command = (operation: 'observe'|'type'|'press', args: Record<string, unknown> = {}) => send(parseRequest({ protocol: 'atlas.browser', version: 1, kind: 'request', requestId: randomUUID(), backendSessionId: session, taskId: task, connectionEpoch: epoch, deadlineAt: Date.now() + 10_000, operation, args: { scopeId, tabId, ...args } }));
    const bind = (observed: any) => ({ documentId: observed.data.documentId, snapshotId: observed.data.snapshotId, ref: observed.data.elements[0].ref });
    await page.goto('https://fixture.example/'); await install();
    await page.evaluate(() => {
      (window as any).fixtureSubmits = 0;
      document.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); ++(window as any).fixtureSubmits; history.pushState({}, '', '/results'); });
      document.querySelector('input')!.addEventListener('input', () => { document.querySelector('#background')!.textContent = 'changed by input'; });
    });
    let observed = await command('observe'); assert.equal(observed.data.elements[0].action, 'search');
    await page.evaluate(() => { for (let n = 0; n < 30; n++) document.querySelector('#background')!.textContent = String(n); });
    assert.equal((await command('type', { ...bind(observed), text: 'fixture search', mode: 'replace' })).outcome, 'OK');
    assert.equal((await command('press', { ...bind(observed), key: 'Enter' })).conflict.reason, 'SNAPSHOT_CONSUMED');
    observed = await command('observe');
    assert.equal((await command('press', { ...bind(observed), key: 'Enter' })).outcome, 'OK');
    assert.equal(await page.evaluate(() => (window as any).fixtureSubmits), 1);
    let next = await command('observe'); assert.notEqual(next.data.documentId, observed.data.documentId);
    // Same-URL pushState also changes the navigation entry. URL comparison alone
    // cannot detect this; the real isolated-world Navigation API must invalidate.
    observed = next; await page.evaluate(() => history.pushState({}, '', location.href));
    assert.equal((await command('type', { ...bind(observed), text: 'never typed', mode: 'replace' })).conflict.reason, 'DOCUMENT_CHANGED');
    next = await command('observe'); assert.equal(next.outcome, 'OK'); assert.equal(next.data.scopeId, scopeId);
    const oldBinding = bind(next);
    await page.reload(); await install();
    assert.equal((await command('type', { ...oldBinding, text: 'never typed', mode: 'replace' })).conflict.reason, 'DOCUMENT_CHANGED');
    observed = await command('observe'); assert.equal(observed.data.scopeId, scopeId);
    await page.goto('https://fixture.example/same-origin-document'); await install();
    assert.equal((await command('type', { ...bind(observed), text: 'never typed', mode: 'replace' })).conflict.reason, 'DOCUMENT_CHANGED');
    assert.equal((await command('observe')).outcome, 'OK');
  } finally { await browser.close(); }
});
