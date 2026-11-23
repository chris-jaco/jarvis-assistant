import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { OAuthCallback } from './oauth-callback.js';
import { authorizeGoogle, runConsent } from './google-onboarding.js';

async function localCallback() {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return new OAuthCallback(`http://127.0.0.1:${port}/oauth/callback`);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}
const authorizationUrl = 'https://accounts.google.com/o/oauth2/v2/auth';

test('loopback consent rejects an incorrect state then persists exactly once after exchange', async () => {
  const callback = await localCallback();
  let writes = 0;
  const finish = new URL(callback.redirect);
  finish.searchParams.set('code', 'fixture');
  await runConsent(callback, {
    authorizationUrl, exchange: async code => {
      assert.equal(code, 'fixture');
      return async () => { writes++; };
    }
  }, async () => {
    assert.equal((await fetch(finish)).status, 400);
    finish.searchParams.set('state', callback.state);
    const response = await fetch(finish);
    assert.equal(response.status, 200);
  });
  assert.equal(writes, 1);
});

test('cancelling during exchange discards its eventual result', async () => {
  const callback = await localCallback();
  const cancel = new AbortController();
  const exchange = deferred<() => Promise<void>>();
  const entered = deferred<void>();
  let writes = 0;
  const attempt = runConsent(callback, {
    authorizationUrl, exchange: () => { entered.resolve(); return exchange.promise; }
  }, async () => {
    const url = new URL(callback.redirect);
    url.searchParams.set('state', callback.state);
    url.searchParams.set('code', 'fixture');
    await fetch(url).catch(() => undefined);
  }, cancel.signal);
  await entered.promise;
  cancel.abort();
  await assert.rejects(attempt, /GOOGLE_CONSENT_CANCELLED/);
  exchange.resolve(async () => { writes++; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 0);
});

test('incomplete configuration and foreign browser destinations fail before browser launch', async () => {
  const openBrowser = async () => { assert.fail('unexpected launch'); };
  await assert.rejects(authorizeGoogle({ service: 'gmail', env: {}, openBrowser }), /GOOGLE_CLIENT_INCOMPLETE/);
  await assert.rejects(runConsent(await localCallback(), {
    authorizationUrl: 'https://accounts.google.com.invalid/', exchange: async () => async () => {}
  }, openBrowser), /GOOGLE_CONSENT_DESTINATION_INVALID/);
});

test('Google health checks audience, scopes and expiration and distinguishes network failure', async () => {
  const { checkGoogleConnection } = await import('./google-onboarding.js');
  const valid = { aud: 'fixture', scope: 'https://www.googleapis.com/auth/gmail.modify', expires_in: '60' };
  const verify = (data: unknown, status = 200) => checkGoogleConnection('gmail', 'fixture', async () => 'fixture-access',
    async (url, init) => {
      assert.equal(url, 'https://oauth2.googleapis.com/tokeninfo');
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-access');
      return Response.json(data, { status });
    });
  assert.equal(await verify(valid), 'VERIFIED');
  for (const changed of [{ aud: 'other' }, { expires_in: 0 }, { scope: 'email' }]) {
    assert.equal(await verify({ ...valid, ...changed }), 'REAUTHORIZE');
  }
  assert.equal(await verify({ error: 'invalid_token' }, 400), 'REAUTHORIZE');
  assert.equal(await verify({}, 500), 'UNVERIFIED');
  assert.equal(await verify({}), 'UNVERIFIED');
  assert.equal(await checkGoogleConnection('gmail', 'fixture', async () => { throw new Error(); }), 'UNVERIFIED');
});

test('an explicitly rejected refresh grant requires new consent', async () => {
  const { GoogleReauthorizationRequired } = await import('../tools/adapters/google-auth.js');
  const { checkGoogleConnection } = await import('./google-onboarding.js');
  assert.equal(await checkGoogleConnection('calendar', 'fixture', async () => {
    throw new GoogleReauthorizationRequired();
  }), 'REAUTHORIZE');
});
