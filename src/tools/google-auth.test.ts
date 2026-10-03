import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, readFile, chmod, rm, readdir, symlink, link, mkdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleAuth, saveTokens, readTokens } from './adapters/google-auth.js';
import { TokenFileSecurity, windowsAclCheck, windowsAclPayload } from './adapters/token-security.js';
import type { Stats } from 'node:fs';
import { ToolError } from './types.js';
const fakeTokens = { refresh_token: 'test-refresh', access_token: 'test-access', expiry_date: Date.now() + 3600_000 };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-auth-'));
  const dir = join(root, 'private-á-日'); const path = join(dir, 'tokens.json');
  return { root, dir, path, config: { clientId: 'public-client', clientSecret: 'test-secret', tokenPath: path, redirectUri: 'http://127.0.0.1:3001/oauth/callback' }, close: () => rm(root, { recursive: true, force: true }) };
}
test('OAuth token storage roundtrip and replacement use actual platform security; missing files fail safely', async () => {
  const f = await fixture();
  try {
    await assert.rejects(new GoogleAuth(f.config).token(), (e: unknown) => e instanceof ToolError && e.category === 'UNCONFIGURED' && !e.message.includes('test-secret'));
    await saveTokens(f.path, fakeTokens);
    assert.deepEqual(await readTokens(f.path), fakeTokens);
    assert.equal(await new GoogleAuth(f.config).token(), 'test-access');
    await saveTokens(f.path, { ...fakeTokens, refresh_token: 'updated-refresh', access_token: 'updated-access' });
    assert.equal(await new GoogleAuth(f.config).token(), 'updated-access');
    assert.deepEqual(await readdir(f.dir), ['tokens.json']);
    if (process.platform === 'win32') {
      await windowsAclCheck(f.dir, 'validate'); await windowsAclCheck(f.path, 'validate');
    } else {
      assert.equal((await stat(f.path)).mode & 0o777, 0o600);
      assert.equal((await stat(f.dir)).mode & 0o777, 0o700);
    }
  } finally { await f.close(); }
});
test('POSIX rejects group/world-readable tokens and unsafe directories on read and write', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await saveTokens(f.path, fakeTokens);
    await chmod(f.path, 0o644);
    await assert.rejects(readTokens(f.path), ToolError);
    await assert.rejects(saveTokens(f.path, fakeTokens), ToolError);
    await assert.rejects(new GoogleAuth(f.config).token(), ToolError);
    await chmod(f.path, 0o600); await chmod(f.dir, 0o755);
    await assert.rejects(readTokens(f.path), ToolError); await assert.rejects(saveTokens(f.path, fakeTokens), ToolError);
  } finally { await f.close(); }
});
test('POSIX rejects symlink token files and symlink credential directories without changing targets', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await saveTokens(f.path, fakeTokens);
    const alias = join(f.dir, 'alias.json'); await symlink(f.path, alias);
    await assert.rejects(readTokens(alias), ToolError); await assert.rejects(saveTokens(alias, fakeTokens), ToolError);
    const directoryAlias = join(f.root, 'alias'); await symlink(f.dir, directoryAlias);
    await assert.rejects(saveTokens(join(directoryAlias, 'new.json'), fakeTokens), ToolError);
    assert.deepEqual(await readTokens(f.path), fakeTokens);
  } finally { await f.close(); }
});
test('hard-linked token files are rejected without overwriting the other link', async () => {
  const f = await fixture();
  try {
    await saveTokens(f.path, fakeTokens); await link(f.path, join(f.dir, 'copy.json'));
    await assert.rejects(readTokens(f.path), ToolError); await assert.rejects(saveTokens(f.path, fakeTokens), ToolError);
    assert.equal(JSON.parse(await readFile(f.path, 'utf8')).refresh_token, 'test-refresh');
  } finally { await f.close(); }
});
test('Windows policy requires native ACL checks and does not interpret synthetic POSIX mode bits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-policy-'));
  try {
    const dir = join(root, 'private'); await mkdir(dir, { mode: 0o700 });
    const info = await lstat(dir);
    const calls: string[] = [];
    const security = new TokenFileSecurity('win32', async (_path, operation) => { calls.push(operation); });
    // Windows reports 0666/0777 independent of an object's DACL.
    const windowsInfo = Object.assign(Object.create(Object.getPrototypeOf(info)), info, { mode: (info.mode & ~0o777) | 0o777 }) as Stats;
    await security.validate(dir, windowsInfo, true, true); await security.validate(dir, windowsInfo, true);
    assert.deepEqual(calls, ['initializeDirectory', 'validate']);
    const denied = new TokenFileSecurity('win32', async () => { throw new ToolError('UNCONFIGURED'); });
    await assert.rejects(denied.validate(dir, windowsInfo, true), ToolError);
    const linked = Object.assign(Object.create(Object.getPrototypeOf(info)), info, { isSymbolicLink: () => true }) as Stats;
    await assert.rejects(security.validate(dir, linked, true), ToolError);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('failed Windows ACL verification happens before any token data is written and cleans temporary files', async () => {
  const f = await fixture();
  try {
    let operations = 0;
    const denyFile = new TokenFileSecurity('win32', async () => { if (++operations === 2) throw new ToolError('UNCONFIGURED'); });
    await assert.rejects(saveTokens(f.path, fakeTokens, denyFile), ToolError);
    assert.deepEqual(await readdir(f.dir), []);
  } finally { await f.close(); }
});
test('native Windows ACL validation rejects broadly accessible files and directories and directory junctions', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture();
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const command = promisify(execFile);
  const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
  try {
    await saveTokens(f.path, fakeTokens);
    // SID S-1-1-0 is Everyone; avoids localized account-name assumptions.
    await command(icacls, [f.path, '/grant', '*S-1-1-0:(R)']);
    await assert.rejects(readTokens(f.path), ToolError); await assert.rejects(saveTokens(f.path, fakeTokens), ToolError);
    await command(icacls, [f.path, '/remove:g', '*S-1-1-0']);
    await command(icacls, [f.dir, '/grant', '*S-1-1-0:(R)']);
    await assert.rejects(readTokens(f.path), ToolError); await assert.rejects(saveTokens(f.path, fakeTokens), ToolError);
    await command(icacls, [f.dir, '/remove:g', '*S-1-1-0']);
    const junction = join(f.root, 'junction'); await symlink(f.dir, junction, 'junction');
    await assert.rejects(readTokens(join(junction, 'tokens.json')), ToolError);
    await assert.rejects(saveTokens(join(junction, 'new.json'), fakeTokens), ToolError);
  } finally { await f.close(); }
});

test('POSIX ownership and nonregular file checks remain fail-closed', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await saveTokens(f.path, fakeTokens); const info = await lstat(f.path);
    const wrongOwner = Object.assign(Object.create(Object.getPrototypeOf(info)), info, { uid: process.getuid!() + 1 }) as Stats;
    await assert.rejects(new TokenFileSecurity().validate(f.path, wrongOwner), ToolError);
    const directory = await lstat(f.dir);
    await assert.rejects(new TokenFileSecurity().validate(f.dir, directory), ToolError);
  } finally { await f.close(); }
});

test('Windows security stdin preserves Unicode and literal metacharacters without shell interpolation', () => {
  const path = 'folder-á-日-😀/$literal;quote"/tokens.json';
  const payload = windowsAclPayload(path, 'validate');
  assert.ok([...payload].every(character => character.charCodeAt(0) < 128));
  assert.deepEqual(JSON.parse(payload), { path, operation: 'validate' });
});
