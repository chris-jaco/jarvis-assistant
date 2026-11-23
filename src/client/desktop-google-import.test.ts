import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importGoogleClient } from '../desktop/google-client-import.js';

const installed = { client_id: 'test-app.apps.googleusercontent.com', client_secret: 'fixture-secret',
  project_id: 'fixture-project', auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token', redirect_uris: ['http://localhost'] };

test('native file selection accepts only desktop OAuth export, cancellation leaves storage untouched', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-oauth-fixture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'synthetic.json');
  let writes = 0;
  const save = async (pair: unknown) => {
    assert.deepEqual(pair, { GOOGLE_CLIENT_ID: installed.client_id, GOOGLE_CLIENT_SECRET: installed.client_secret });
    writes++;
  };
  assert.equal(await importGoogleClient(async () => undefined, save), 'CANCELLED');
  for (const content of ['{', ' '.repeat(32 * 1024 + 1), ...[
    { web: installed }, { installed, extra: true }, { installed: { ...installed, client_secret: undefined } },
    { installed: { ...installed, token_uri: 'https://example.invalid' } },
    { installed: { ...installed, extra: installed.client_secret } }
  ].map(item => JSON.stringify(item))]) {
    await writeFile(path, content);
    await assert.rejects(importGoogleClient(async () => path, save), { message: 'GOOGLE_IMPORT_FAILED' });
  }
  assert.equal(writes, 0);
  await writeFile(path, JSON.stringify({ installed }));
  assert.equal(await importGoogleClient(async () => path, save), 'IMPORTED');
  assert.equal(writes, 1);
  await assert.rejects(importGoogleClient(async () => path, async () => { throw new Error(installed.client_secret); }),
    { message: 'GOOGLE_IMPORT_FAILED' });
});

test('the application and credential setup preload expose no Google secret retrieval or import operation', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of ['preload.ts', 'api.ts', 'credential-setup-preload.ts', 'credential-setup-api.ts']) {
    const source = await readFile(new URL('../desktop/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /GOOGLE_CLIENT_SECRET|GOOGLE_CLIENT_ID|withGoogleClient|setGoogleClient|importGoogleClient/);
  }
});
