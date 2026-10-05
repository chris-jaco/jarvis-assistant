import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareBrowserProfile } from '../browser/profile.js';
import { BrowserDiagnostics } from '../browser/diagnostics.js';
import { TokenFileSecurity } from './adapters/token-security.js';
import { ToolError } from './types.js';

test('browser profile uses reusable Windows ACL batch transport, audits parent before child and re-audits on retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-profile-audit-')); const calls: string[] = [];
  const security = new TokenFileSecurity('win32', async () => { assert.fail('Must not launch one-shot ACL checks'); }, async entries => {
    assert.equal(entries.length, 1); calls.push(entries[0]!.operation + ':' + entries[0]!.path);
  });
  try {
    const signal = new AbortController().signal;
    const profile = await prepareBrowserProfile(root, signal, new BrowserDiagnostics(), security);
    await prepareBrowserProfile(root, signal, new BrowserDiagnostics(), security);
    assert.deepEqual(calls, ['initializeDirectory:' + join(root, '.local'), 'initializeDirectory:' + profile, 'validate:' + join(root, '.local'), 'validate:' + profile]);
    let checks = 0;
    const deny = new TokenFileSecurity('win32', async () => assert.fail(), async () => { ++checks; throw new ToolError('UNCONFIGURED'); });
    await assert.rejects(prepareBrowserProfile(root, signal, undefined, deny), /UNCONFIGURED/); assert.equal(checks, 1);
    const controller = new AbortController();
    const abort = new TokenFileSecurity('win32', async () => assert.fail(), async () => { controller.abort(); });
    await assert.rejects(prepareBrowserProfile(root, controller.signal, undefined, abort));
    if (process.platform !== 'win32') {
      await chmod(profile, 0o755); await assert.rejects(prepareBrowserProfile(root, signal), /UNCONFIGURED/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
