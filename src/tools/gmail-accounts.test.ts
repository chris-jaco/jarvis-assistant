import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, lstat, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GmailAccountStore, gmailAccountId, GMAIL_SCOPES } from './adapters/gmail-accounts.js';
import { readTokens, saveTokens } from './adapters/google-auth.js';
import { ToolError } from './types.js';
test('multiple OAuth accounts have stable isolated private files; reconnect/removal cannot overwrite Calendar or other account', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-gmail-'));
  try {
    const calendarPath = join(root, 'calendar', 'google-tokens.json'); await saveTokens(calendarPath, { refresh_token: 'fake-calendar' });
    const store = new GmailAccountStore({ GMAIL_ACCOUNTS_PATH: join(root, 'accounts'), GOOGLE_TOKEN_PATH: calendarPath });
    const a = await store.save('subject-a', 'one@example.test', { refresh_token: 'fake-first' }, 'One');
    const b = await store.save('subject-b', 'two@example.test', { refresh_token: 'fake-second' }, 'Two');
    assert.notEqual(a.id, b.id); assert.equal(a.id, gmailAccountId('subject-a')); assert.equal((await store.list()).length, 2);
    await assert.rejects(store.get(), error => error instanceof ToolError && error.category === 'AMBIGUOUS');
    assert.ok(!JSON.stringify(await store.list()).includes('refresh_token'));
    await store.save('subject-a', 'renamed@example.test', { refresh_token: 'fake-renewed' }, 'Updated');
    assert.equal((await readTokens(join(root, 'accounts', `${a.id}.json`))).refresh_token, 'fake-renewed');
    assert.equal((await readTokens(join(root, 'accounts', `${b.id}.json`))).refresh_token, 'fake-second');
    assert.equal((await readTokens(calendarPath)).refresh_token, 'fake-calendar');
    if (process.platform !== 'win32') { assert.equal((await lstat(join(root, 'accounts', `${a.id}.json`))).mode & 0o777, 0o600); assert.equal((await lstat(join(root, 'accounts'))).mode & 0o777, 0o700); }
    await store.remove(a.id); assert.equal((await store.get()).id, b.id); await assert.rejects(store.get(a.id));
    assert.equal((await readTokens(calendarPath)).refresh_token, 'fake-calendar');
    assert.ok(!GMAIL_SCOPES.includes('https://mail.google.com/')); assert.ok(!GMAIL_SCOPES.includes('https://www.googleapis.com/auth/gmail.settings.basic'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('missing accounts are optional; mismatched token identity and traversal IDs fail safely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-gmail-'));
  try {
    const store = new GmailAccountStore({ GMAIL_ACCOUNTS_PATH: join(root, 'accounts') }); assert.deepEqual(await store.list(), []); await assert.rejects(store.get());
    const a = await store.save('a', 'one@example.test', { refresh_token: 'fake' });
    const path = join(root, 'accounts', `${a.id}.json`); const tokens = await readTokens(path) as Record<string, unknown>;
    await saveTokens(path, { ...tokens, jarvisAccount: { id: a.id, subject: 'another-subject', email: 'one@example.test' } } as Parameters<typeof saveTokens>[1]);
    await assert.rejects(store.get(a.id)); await assert.rejects(store.get('../../calendar')); await assert.rejects(store.remove('../../calendar'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('POSIX insecure account files and symlink directory ancestors are rejected, preserving other targets', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-gmail-'));
  try {
    const store = new GmailAccountStore({ GMAIL_ACCOUNTS_PATH: join(root, 'accounts') }); const a = await store.save('a', 'one@example.test', { refresh_token: 'fake' });
    const path = join(root, 'accounts', `${a.id}.json`); await chmod(path, 0o644); await assert.rejects(store.get(a.id)); await chmod(path, 0o600);
    await symlink(root, join(root, 'link'), 'dir');
    const unsafe = new GmailAccountStore({ GMAIL_ACCOUNTS_PATH: join(root, 'link', 'accounts') });
    await assert.rejects(unsafe.list()); await assert.rejects(unsafe.save('b', 'two@example.test', { refresh_token: 'fake' })); assert.equal((await store.list()).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
