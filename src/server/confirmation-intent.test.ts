import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { createToolsHandler } from './tools.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ConfirmationIntent } from '../tools/confirmation-intent.js';

async function fixture(intent: ConfirmationIntent = 'affirmative') {
  let now = Date.now(); let executions = 0; let classifications = 0;
  let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const start = new Promise<void>(resolve => { started = resolve; });
  const registry = new ToolRegistry();
  registry.register({ id: 'test.send', integration: 'test', name: 'Send', capability: 'send', description: 'Send', permission: 'SENSITIVE', schema: z.object({ body: z.string() }), summarize: () => 'Frozen action', execute: async input => { executions++; return { sent: true, input }; } });
  const runtime = createToolsHandler({}, {}, { runtime: { registry, timezone: 'Europe/Madrid' }, now: () => now, classifier: { classify: async (summary, utterance) => {
    classifications++; assert.equal(summary, 'Frozen action'); assert.equal(utterance, 'Perfecto, te confirmo el envío.'); started(); await gate; return intent;
  } } });
  const server = createServer(async (req, res) => { await runtime.handle(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tools/`;
  const session = await fetch(url + 'session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(url + route, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const pending = await (await post('invoke', { invocationId: 'one', toolId: 'test.send', input: { body: 'frozen' } })).json() as { confirmationId: string };
  return { pending, post, start, release, expire: () => { now += 60_001; }, executions: () => executions, classifications: () => classifications,
    close: async () => { release(); runtime.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('HTTP semantic intent is bound to session and frozen ID; competing tools are blocked; classification cannot execute', async () => {
  const f = await fixture(); try {
    const wrong = '00000000-0000-4000-8000-000000000000';
    assert.equal((await (await f.post('intent', { confirmationId: wrong, utterance: 'Perfecto, te confirmo el envío.' })).json() as { intent: string }).intent, 'ambiguous');
    assert.equal(f.classifications(), 0);
    assert.equal((await f.post('intent', { confirmationId: f.pending.confirmationId, utterance: 'Perfecto, te confirmo el envío.' }, { Origin: 'https://evil.test' })).status, 403);
    const classification = f.post('intent', { confirmationId: f.pending.confirmationId, utterance: 'Perfecto, te confirmo el envío.' });
    await f.start;
    assert.equal((await f.post('invoke', { invocationId: 'duplicate', toolId: 'test.send', input: { body: 'changed' } })).status, 429);
    assert.equal(f.executions(), 0); f.release();
    assert.deepEqual(await (await classification).json(), { confirmationId: f.pending.confirmationId, intent: 'affirmative' });
    assert.equal(f.executions(), 0);
    assert.equal((await (await f.post('cancel', { confirmationId: wrong })).json() as { cancelled: boolean }).cancelled, false);
    const result = await (await f.post('decision', { confirmationId: f.pending.confirmationId, approved: true })).json() as { status: string; data: { input: { body: string } } };
    assert.equal(result.status, 'success'); assert.equal(result.data.input.body, 'frozen'); assert.equal(f.executions(), 1);
    assert.equal((await (await f.post('decision', { confirmationId: f.pending.confirmationId, approved: true })).json() as { category: string }).category, 'EXPIRED'); assert.equal(f.executions(), 1);
  } finally { await f.close(); }
});
for (const mode of ['expired', 'closed']) {
  test(`classification arriving after ${mode} cannot authorize the pending action`, async () => {
    const f = await fixture(); try {
      const classification = f.post('intent', { confirmationId: f.pending.confirmationId, utterance: 'Perfecto, te confirmo el envío.' }); await f.start;
      if (mode === 'expired') f.expire(); else await f.post('session', {}, {}); // replace session closes old executor
      f.release(); assert.equal((await (await classification).json() as { intent: string }).intent, 'ambiguous'); assert.equal(f.executions(), 0);
    } finally { await f.close(); }
  });
}
