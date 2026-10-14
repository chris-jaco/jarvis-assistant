import test from 'node:test';
import assert from 'node:assert/strict';
import { WebCoreTransport } from '../provider/core-transport.js';
import { RealtimeTokenError, WebRealtimeTokenProvider } from '../provider/realtime-token.js';

test('WebCoreTransport preserves tool session, activity, invocation and close HTTP contracts', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json(String(input).endsWith('/session') && init?.method === 'POST'
      ? { tools: [], timezone: 'Europe/Madrid', now: '2026-10-14T00:00:00.000Z' }
      : String(input).endsWith('/activity') ? { activity: [], pending: null }
      : String(input).endsWith('/invoke') ? { status: 'success', data: { ok: true } }
      : { closed: true });
  };
  const core = new WebCoreTransport(fetcher);
  await core.request('session.create', {});
  await core.request('activity.get', undefined);
  await core.request('tool.invoke', { invocationId: 'call_1', toolId: 'fixture.read', input: { value: 1 } });
  await core.request('session.close', { reason: 'USER_DISCONNECT' });

  assert.deepEqual(calls.map(call => [call.url, call.init?.method]), [
    ['/api/tools/session', 'POST'], ['/api/tools/activity', 'GET'], ['/api/tools/invoke', 'POST'], ['/api/tools/session', 'DELETE']
  ]);
  assert.equal(calls[0]?.init?.body, '{}');
  assert.equal(calls[1]?.init?.body, undefined);
  assert.equal(calls[2]?.init?.body, JSON.stringify({ invocationId: 'call_1', toolId: 'fixture.read', input: { value: 1 } }));
  assert.equal(calls[3]?.init?.body, undefined);
  assert.equal(new Headers(calls[3]?.init?.headers).get('X-Atlas-Session-Close'), 'USER_DISCONNECT');
  assert.equal(calls.every(call => call.init?.credentials === undefined), true); // Browser default remains same-origin cookies.
});

test('WebCoreTransport preserves browser correlation and never retries failed requests', async () => {
  let calls = 0; let header = ''; const responses: string[] = [];
  const core = new WebCoreTransport(async (_input, init) => {
    calls++; header = new Headers(init?.headers).get('X-Atlas-Browser-Request') ?? '';
    return new Response('{}', { status: 502, headers: { 'X-Atlas-Browser-Call': 'b7' } });
  });
  await assert.rejects(core.request('tool.invoke', { invocationId: 'call_2', toolId: 'browser.observe', input: {} }, { browserRequest: { sequence: 9, response: value => responses.push(value) } }), /No se pudo contactar/);
  assert.equal(calls, 1); assert.equal(header, '9'); assert.deepEqual(responses, []);

  const successfulResponses: string[] = [];
  const successful = new WebCoreTransport(async () => Response.json({ status: 'success', data: {} }, { headers: { 'X-Atlas-Browser-Call': 'b7' } }));
  await successful.request('tool.invoke', { invocationId: 'call_3', toolId: 'browser.observe', input: {} }, { browserRequest: { sequence: 10, response: value => successfulResponses.push(value) } });
  assert.deepEqual(successfulResponses, ['b7']);
});

test('WebCoreTransport keeps browser, confirmation and memory operations on their existing routes', async () => {
  const calls: Array<[string, string | undefined]> = [];
  const core = new WebCoreTransport(async (input, init) => {
    calls.push([String(input), init?.method]);
    return Response.json({});
  });
  const id = '00000000-0000-4000-8000-000000000001';
  await core.request('browser.admit', { admissionId: id, transcriptPending: true });
  await core.request('browser.cancel', { itemId: 'item', utterance: 'cancelar tarea browser' });
  await core.request('browser.continuation', { taskId: id, tokens: [id] });
  await core.request('browser.resume', { handoffId: id, utterance: 'listo' });
  await core.request('browser.stall', {});
  await core.request('confirmation.intent', { confirmationId: id, utterance: 'confirmo' });
  await core.request('confirmation.decision', { confirmationId: id, approved: true });
  await core.request('confirmation.cancel', { confirmationId: id });
  await core.request('confirmation.visible', { confirmationId: id, visible: true });
  await core.request('memory.context', { query: 'profile' });
  await core.request('memory.turn', { itemId: 'item', utterance: 'hello', sequence: 1, observedAt: '2026-10-14T00:00:00.000Z' });
  assert.deepEqual(calls, [
    ['/api/tools/browser-admit', 'POST'], ['/api/tools/browser-cancel', 'POST'],
    ['/api/tools/browser-continuation', 'POST'], ['/api/tools/browser-resume', 'POST'],
    ['/api/tools/browser-stall', 'POST'], ['/api/tools/intent', 'POST'],
    ['/api/tools/decision', 'POST'], ['/api/tools/cancel', 'POST'],
    ['/api/tools/confirmation-visible', 'POST'], ['/api/tools/memory-context', 'POST'],
    ['/api/tools/memory-turn', 'POST']
  ]);
});

test('WebCoreTransport forwards cancellation and enforces a bounded timeout without retry', async () => {
  for (const mode of ['cancel', 'timeout'] as const) {
    let calls = 0;
    const core = new WebCoreTransport((_input, init) => new Promise((_resolve, reject) => {
      calls++;
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const controller = new AbortController();
    const pending = core.request('activity.get', undefined, mode === 'cancel' ? { signal: controller.signal, timeoutMs: 1000 } : { timeoutMs: 5 });
    if (mode === 'cancel') controller.abort();
    await assert.rejects(pending);
    assert.equal(calls, 1);
  }
});

test('WebRealtimeTokenProvider preserves the ephemeral token flow and sanitized errors', async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const provider = new WebRealtimeTokenProvider(async (input, init) => {
    calls.push({ input: String(input), init }); return Response.json({ value: 'ek_fixture' });
  });
  assert.equal(await provider.token(), 'ek_fixture');
  assert.equal(calls[0]?.input, '/api/realtime/token'); assert.equal(calls[0]?.init?.method, 'POST');
  assert.equal(calls[0]?.init?.body, undefined);

  const rejected = new WebRealtimeTokenProvider(async () => Response.json({ error: 'Configuración no disponible.' }, { status: 503 }));
  await assert.rejects(rejected.token(), (error: unknown) => error instanceof RealtimeTokenError && error.message === 'Configuración no disponible.');
  const malformed = new WebRealtimeTokenProvider(async () => Response.json({ value: 'PRIVATE_API_KEY' }));
  await assert.rejects(malformed.token(), /No se pudo autorizar/);
});
