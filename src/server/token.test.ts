import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClientSecret, TokenError } from './token.js';
import { REALTIME_MODEL } from '../core/personality.js';

test('missing API key fails before making a network request', async () => {
  await assert.rejects(createClientSecret('', async () => { throw new Error('must not call'); }), (error: unknown) => error instanceof TokenError && error.status === 503);
});
test('uses current client_secrets endpoint and returns only the ephemeral token', async () => {
  const result = await createClientSecret('server-secret', async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/realtime/client_secrets');
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer server-secret');
    const body = JSON.parse(String(options?.body));
    assert.equal(body.session.type, 'realtime');
    assert.equal(body.session.model, REALTIME_MODEL);
    assert.equal(body.session.audio.input.turn_detection.interrupt_response, true);
    assert.equal(body.session.audio.input.turn_detection.create_response, true);
    return Response.json({ value: 'ek_test', session: { private: 'not-forwarded' } });
  });
  assert.deepEqual(result, { value: 'ek_test' });
});
test('upstream error details and network exceptions are never exposed', async () => {
  for (const request of [
    async () => new Response('server-secret', { status: 401 }),
    async () => { throw new Error('server-secret'); }
  ]) {
    await assert.rejects(createClientSecret('server-secret', request), (error: unknown) => error instanceof TokenError && error.status === 502 && !error.message.includes('server-secret'));
  }
});
test('invalid upstream responses cannot pass as a token', async () => {
  for (const response of [Response.json({ value: 'sk-secret' }), Response.json({}), new Response('invalid')]) {
    await assert.rejects(createClientSecret('server-secret', async () => response), TokenError);
  }
});
