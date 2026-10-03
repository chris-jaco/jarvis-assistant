import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createToolsHandler } from './tools.js';
async function fixture(development = false, enabled = false) {
  const traces: unknown[] = [];
  const runtime = createToolsHandler({ USER_TIMEZONE: 'Europe/Madrid', JARVIS_CONFIRMATION_TRACE: String(enabled) }, { development, sink: entry => traces.push(entry) });
  const server = createServer(async (req, res) => { if (!await runtime.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { traces, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: async () => { runtime.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
test('HTTP tool sessions require ownership, reject cross-origin/non-JSON/oversize requests and close cleanly', async () => {
  const f = await fixture();
  try {
    const unauth = await fetch(`${f.url}/api/tools/activity`); assert.equal(unauth.status, 401);
    const rejected = await fetch(`${f.url}/api/tools/session`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' } }); assert.equal(rejected.status, 403);
    const form = await fetch(`${f.url}/api/tools/session`, { method: 'POST' }); assert.equal(form.status, 415);
    const created = await fetch(`${f.url}/api/tools/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(created.status, 200);
    const cookie = created.headers.get('set-cookie')!.split(';')[0]!; assert.ok(created.headers.get('set-cookie')!.includes('HttpOnly')); assert.ok(created.headers.get('set-cookie')!.includes('SameSite=Strict'));
    const info = await created.json() as { tools: Array<{ id: string }> }; assert.equal(info.tools.length, 7); assert.ok(!JSON.stringify(info).includes('GOOGLE_CLIENT_SECRET'));
    const invoke = await fetch(`${f.url}/api/tools/invoke`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ invocationId: '1', toolId: 'calendar.listEvents', input: { start: '2026-10-04T00:00:00', end: '2026-10-05T00:00:00' } }) });
    assert.equal((await invoke.json() as { category: string }).category, 'UNCONFIGURED');
    const oversized = await fetch(`${f.url}/api/tools/invoke`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(20_000) }) }); assert.equal(oversized.status, 400);
    const forged = await fetch(`${f.url}/api/tools/decision`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmationId: '00000000-0000-4000-8000-000000000000', approved: true }) }); assert.equal((await forged.json() as { category: string }).category, 'EXPIRED');
    await fetch(`${f.url}/api/tools/session`, { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal((await fetch(`${f.url}/api/tools/activity`, { headers: { Cookie: cookie } })).status, 401);
  } finally { await f.close(); }
});

test('confirmation diagnostics require development mode AND explicit opt-in, including server logs', async () => {
  for (const [development, enabled] of [[false, false], [false, true], [true, false], [true, true]]) {
    const f = await fixture(development, enabled); try {
      const created = await fetch(`${f.url}/api/tools/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal((await created.json() as { confirmationTrace: boolean }).confirmationTrace, development && enabled);
      const cookie = created.headers.get('set-cookie')!.split(';')[0]!;
      await fetch(`${f.url}/api/tools/cancel`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(f.traces.length > 0, development && enabled);
      assert.ok(!JSON.stringify(f.traces).includes(cookie));
    } finally { await f.close(); }
  }
});
