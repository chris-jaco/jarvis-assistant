import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CredentialSetupPreference, requestCredentialReconfiguration, shouldShowCredentialSetup } from '../desktop/credential-lifecycle.js';

test('setup gate skips a normal restart and fails closed for missing, invalid or requested setup', () => {
  assert.equal(shouldShowCredentialSetup('CONFIGURED', false), false);
  assert.equal(shouldShowCredentialSetup('CONFIGURED', true), true);
  assert.equal(shouldShowCredentialSetup('MISSING', false), true);
  assert.equal(shouldShowCredentialSetup('INVALID', false), true);
});

test('credential setup preference is non-sensitive, persistent and clearable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-credential-lifecycle-'));
  try {
    const preference = new CredentialSetupPreference(root);
    assert.equal(await preference.required(), false);
    await preference.request();
    assert.equal(await preference.required(), true);
    const serialized = await readFile(preference.path, 'utf8');
    assert.deepEqual(JSON.parse(serialized), { version: 1, showOnNextStart: true });
    assert.doesNotMatch(serialized, /api|key|token|credential/i);
    await preference.clear();
    assert.equal(await preference.required(), false);
    await import('node:fs/promises').then(fs => fs.writeFile(preference.path, JSON.stringify({ version: 99, showOnNextStart: false })));
    assert.equal(await preference.required(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reconfiguration persists intent only after verified cleanup then uses the existing quit path', async () => {
  const events: string[] = [];
  const accepted = await requestCredentialReconfiguration({
    cleanup: async () => { events.push('cleanup'); return 'COMPLETED'; },
    persistPreference: async () => { events.push('persist'); },
    quit: async () => { events.push('quit'); },
    restore: () => events.push('restore'),
    showFailure: async () => { events.push('failure'); }
  });
  assert.equal(accepted, true);
  assert.deepEqual(events, ['cleanup', 'persist', 'quit']);
});

for (const outcome of ['FAILED', 'TIMED_OUT'] as const) {
  test(`reconfiguration remains visible and does not persist after ${outcome}`, async () => {
    const events: string[] = [];
    assert.equal(await requestCredentialReconfiguration({
      cleanup: async () => outcome,
      persistPreference: async () => { events.push('persist'); },
      quit: async () => { events.push('quit'); },
      restore: () => events.push('restore'),
      showFailure: async () => { events.push('failure'); }
    }), false);
    assert.deepEqual(events, []);
  });
}

test('preference failure restores the disconnected window and never quits', async () => {
  const events: string[] = [];
  assert.equal(await requestCredentialReconfiguration({
    cleanup: async () => 'COMPLETED',
    persistPreference: async () => { throw new Error('fixture-sensitive-message'); },
    quit: async () => { events.push('quit'); },
    restore: () => events.push('restore'),
    showFailure: async () => { events.push('sanitized-failure'); }
  }), false);
  assert.deepEqual(events, ['restore', 'sanitized-failure']);
});
