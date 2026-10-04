import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { OAuthCallback } from './oauth-callback.js';
test('OAuth loopback state is unpredictable, constant-time compared, single use; PKCE uses S256', () => {
  const callback = new OAuthCallback('http://127.0.0.1:3001/oauth/callback');
  const valid = new URL(callback.redirect); valid.searchParams.set('state', callback.state);
  assert.equal(callback.state.length, 43); assert.notEqual(callback.state, new OAuthCallback(callback.redirect.href).state);
  assert.equal(callback.challenge(), createHash('sha256').update(callback.verifier).digest('base64url'));
  assert.notEqual(callback.challenge(), callback.verifier);
  assert.equal(callback.accept('POST', valid), false);
  const wrong = new URL(valid); wrong.searchParams.set('state', 'x'.repeat(callback.state.length)); assert.equal(callback.accept('GET', wrong), false);
  wrong.pathname = '/wrong'; wrong.searchParams.set('state', callback.state); assert.equal(callback.accept('GET', wrong), false);
  assert.equal(callback.accept('GET', valid), true); assert.equal(callback.accept('GET', valid), false);
  const expired = new OAuthCallback(valid.href.split('?')[0]!); const expiredUrl = new URL(expired.redirect); expiredUrl.searchParams.set('state', expired.state); expired.close(); assert.equal(expired.accept('GET', expiredUrl), false);
});
test('OAuth rejects non-loopback, unsafe or credential-bearing redirect URIs', () => {
  for (const uri of ['https://example.test/oauth/callback', 'http://0.0.0.0:3001/oauth/callback', 'http://user:pass@127.0.0.1:3001/oauth/callback', 'http://127.0.0.1:3001/oauth/callback?state=x', 'http://127.0.0.1:3001/other']) assert.throws(() => new OAuthCallback(uri));
});
