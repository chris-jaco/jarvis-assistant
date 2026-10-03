import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleAuth, saveTokens } from './adapters/google-auth.js';
import { ToolError } from './types.js';
test('OAuth tokens are saved atomically with private permissions; missing/insecure files fail safely', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-auth-')); const path = join(dir, 'tokens.json');
  try {
    const config = { clientId: 'public-client', clientSecret: 'test-secret', tokenPath: path, redirectUri: 'http://127.0.0.1:3001/oauth/callback' };
    await assert.rejects(new GoogleAuth(config).token(), (e: unknown) => e instanceof ToolError && e.category === 'UNCONFIGURED' && !e.message.includes('test-secret'));
    await saveTokens(path, { refresh_token: 'test-refresh', access_token: 'test-access', expiry_date: Date.now() + 3600_000 });
    assert.equal((await stat(path)).mode & 0o777, 0o600); assert.equal(JSON.parse(await readFile(path, 'utf8')).refresh_token, 'test-refresh');
    assert.equal(await new GoogleAuth(config).token(), 'test-access');
    await saveTokens(path, { refresh_token: 'updated-refresh', access_token: 'updated-access', expiry_date: Date.now() + 3600_000 });
    assert.equal(await new GoogleAuth(config).token(), 'updated-access');
    await chmod(path, 0o644); await assert.rejects(new GoogleAuth(config).token(), ToolError);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
