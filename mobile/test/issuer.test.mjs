import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createIssuer } from '../tools/issuer.mjs';

test('single-use local issuer rejects browser requests, wrong pairing and concurrent redemption', async t => {
  let mints = 0;
  const pending = Promise.withResolvers();
  const began = Promise.withResolvers();
  const server = createIssuer('12345678', async () => { ++mints; began.resolve(); return pending.promise; });
  server.listen(0, '127.0.0.1');
  t.after(() => { server.close(); server.closeAllConnections(); });
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port + '/token';
  const post = headers => fetch(url, { method: 'POST', headers });
  assert.equal((await post({})).status, 403);
  const headers = { Authorization: 'Bearer 12345678' };
  assert.equal((await post({ ...headers, Origin: 'http://irrelevant.invalid' })).status, 403);
  const attempt = post(headers);
  await began.promise;
  await post(headers).then(res => assert.equal(res.status, 403), () => {});
  pending.resolve('ek_fixture');
  assert.deepEqual(await (await attempt).json(), { value: 'ek_fixture' });
  assert.equal(mints, 1);
});
