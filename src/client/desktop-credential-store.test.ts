import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Stats } from 'node:fs';
import { DesktopCredentialStore, DesktopCredentialStoreError } from '../desktop/credential-store.js';

const plaintext = 'private-fixture-value-123456';

function crypto(options: { available?: boolean; failDecrypt?: boolean } = {}) {
  return {
    available: () => options.available ?? true,
    encrypt(value: string) { return Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`); },
    decrypt(value: Buffer) {
      if (options.failDecrypt) throw new Error(`raw failure ${plaintext}`);
      const serialized = value.toString();
      if (!serialized.startsWith('sealed:')) throw new Error('bad ciphertext');
      return Buffer.from(serialized.slice(7), 'base64').toString();
    }
  };
}

const security = { async validate(_path: string, _info: Stats) {} };

async function fixture(options: Parameters<typeof crypto>[0] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'atlas-credentials-'));
  const store = new DesktopCredentialStore({ credentialsRoot: join(root, 'credentials'), crypto: crypto(options), security, now: () => new Date('2026-10-17T00:00:00.000Z') });
  return { root, store, close: () => rm(root, { recursive: true, force: true }) };
}

test('encrypted credentials roundtrip through status without plaintext persistence', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.store.status(), { OPENAI_API_KEY: 'MISSING', GOOGLE_CLIENT_ID: 'MISSING', GOOGLE_CLIENT_SECRET: 'MISSING' });
    await f.store.set('OPENAI_API_KEY', plaintext);
    assert.equal((await f.store.status()).OPENAI_API_KEY, 'CONFIGURED');
    const serialized = await readFile(f.store.path, 'utf8');
    assert.doesNotMatch(serialized, new RegExp(plaintext));
    assert.deepEqual(JSON.parse(serialized), {
      version: 1, provider: 'electron.safeStorage', credentials: {
        OPENAI_API_KEY: { ciphertext: Buffer.from(`sealed:${Buffer.from(plaintext).toString('base64')}`).toString('base64'), updatedAt: '2026-10-17T00:00:00.000Z' }
      }
    });
  } finally { await f.close(); }
});

test('Main-only OpenAI bootstrap access decrypts transiently and never changes persistence', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.store.withOpenAIKey(async () => undefined), /CREDENTIAL_STORE_INVALID/);
    await f.store.set('OPENAI_API_KEY', plaintext);
    const before = await readFile(f.store.path, 'utf8');
    const received = await f.store.withOpenAIKey(async value => value === plaintext ? 'used' : 'wrong');
    assert.equal(received, 'used');
    assert.equal(await readFile(f.store.path, 'utf8'), before);
  } finally { await f.close(); }
});

test('corrupt, unknown-schema and undecryptable stores are INVALID and never overwritten', async () => {
  for (const content of ['{broken', '{"version":2,"provider":"electron.safeStorage","credentials":{}}']) {
    const f = await fixture();
    try {
      await mkdir(join(f.root, 'credentials'), { mode: 0o700 });
      await writeFile(f.store.path, content, { flag: 'wx', mode: 0o600 });
      assert.deepEqual(await f.store.status(), { OPENAI_API_KEY: 'INVALID', GOOGLE_CLIENT_ID: 'INVALID', GOOGLE_CLIENT_SECRET: 'INVALID' });
      await assert.rejects(f.store.set('OPENAI_API_KEY', plaintext), /CREDENTIAL_STORE_INVALID/);
      assert.equal(await readFile(f.store.path, 'utf8'), content);
    } finally { await f.close(); }
  }
  const f = await fixture();
  try {
    await f.store.set('OPENAI_API_KEY', plaintext);
    const before = await readFile(f.store.path, 'utf8');
    const failing = new DesktopCredentialStore({ credentialsRoot: join(f.root, 'credentials'), crypto: crypto({ failDecrypt: true }), security });
    assert.equal((await failing.status()).OPENAI_API_KEY, 'INVALID');
    await assert.rejects(failing.set('GOOGLE_CLIENT_ID', 'client-value'), (error: unknown) => error instanceof DesktopCredentialStoreError && error.code === 'CREDENTIAL_STORE_INVALID' && !error.message.includes(plaintext));
    assert.equal(await readFile(f.store.path, 'utf8'), before);
  } finally { await f.close(); }
});

test('unavailable encryption fails closed without creating persistence', async () => {
  const f = await fixture({ available: false });
  try {
    assert.deepEqual(await f.store.status(), { OPENAI_API_KEY: 'INVALID', GOOGLE_CLIENT_ID: 'INVALID', GOOGLE_CLIENT_SECRET: 'INVALID' });
    await assert.rejects(f.store.set('OPENAI_API_KEY', plaintext), /CREDENTIAL_STORAGE_UNAVAILABLE/);
    await assert.rejects(f.store.delete('OPENAI_API_KEY'), /CREDENTIAL_STORAGE_UNAVAILABLE/);
    await assert.rejects(readdir(join(f.root, 'credentials')), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('rotation, independent deletion and idempotent deletion preserve other credentials', async () => {
  const f = await fixture();
  try {
    await f.store.set('OPENAI_API_KEY', plaintext);
    await f.store.set('GOOGLE_CLIENT_ID', 'google-client-one');
    await f.store.set('OPENAI_API_KEY', 'private-rotated-value-654321');
    await f.store.delete('OPENAI_API_KEY');
    await f.store.delete('OPENAI_API_KEY');
    assert.deepEqual(await f.store.status(), { OPENAI_API_KEY: 'MISSING', GOOGLE_CLIENT_ID: 'CONFIGURED', GOOGLE_CLIENT_SECRET: 'MISSING' });
  } finally { await f.close(); }
});

test('concurrent writes serialize without lost updates and leave no temporary files', async () => {
  const f = await fixture();
  try {
    await Promise.all([
      f.store.set('OPENAI_API_KEY', plaintext),
      f.store.set('GOOGLE_CLIENT_ID', 'google-client-one'),
      f.store.set('GOOGLE_CLIENT_SECRET', 'google-secret-one')
    ]);
    assert.deepEqual(await f.store.status(), { OPENAI_API_KEY: 'CONFIGURED', GOOGLE_CLIENT_ID: 'CONFIGURED', GOOGLE_CLIENT_SECRET: 'CONFIGURED' });
    assert.deepEqual(await readdir(join(f.root, 'credentials')), ['credentials.v1.json']);
  } finally { await f.close(); }
});

test('unknown identifiers and invalid values are rejected with sanitized closed errors', async () => {
  const f = await fixture();
  try {
    for (const [id, value, code] of [
      ['ARBITRARY_SECRET', plaintext, 'CREDENTIAL_IDENTIFIER_INVALID'],
      ['OPENAI_API_KEY', '', 'CREDENTIAL_VALUE_INVALID'],
      ['OPENAI_API_KEY', ` ${plaintext}`, 'CREDENTIAL_VALUE_INVALID'],
      ['OPENAI_API_KEY', `${plaintext}\n`, 'CREDENTIAL_VALUE_INVALID'],
      ['OPENAI_API_KEY', 'x'.repeat(8_193), 'CREDENTIAL_VALUE_INVALID']
    ] as const) {
      await assert.rejects(f.store.set(id as never, value), (error: unknown) => error instanceof DesktopCredentialStoreError && error.code === code && (value.length === 0 || !error.message.includes(value)));
    }
  } finally { await f.close(); }
});

test('atomic persistence validates directory, temporary and final paths without logging secrets', async () => {
  const f = await fixture(); const checked: string[] = [];
  const guarded = new DesktopCredentialStore({
    credentialsRoot: join(f.root, 'guarded'), crypto: crypto(),
    security: { async validate(path: string) { checked.push(path); } }
  });
  try {
    await guarded.set('OPENAI_API_KEY', plaintext);
    assert.ok(checked.some(path => path.endsWith('guarded')));
    assert.ok(checked.some(path => path.endsWith('.tmp')));
    assert.ok(!JSON.stringify(checked).includes(plaintext));
    assert.deepEqual(await readdir(join(f.root, 'guarded')), ['credentials.v1.json']);
  } finally { await f.close(); }
});
