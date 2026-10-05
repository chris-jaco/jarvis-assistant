import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
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
