import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmationTracer } from '../diagnostics/confirmation.js';
import type { ConfirmationTrace } from '../diagnostics/confirmation.js';
test('confirmation trace whitelists metadata, replaces identifiers, and tolerates logging failures', () => {
  const output: ConfirmationTrace[] = [];
  const trace = confirmationTracer(true, entry => output.push(entry));
  const entry = { event: 'speech.capture', reason: 'captured', pendingId: 'private-identifier', itemId: 'private-item', input: { email: 'DO_NOT_LOG_EMAIL' }, transcript: 'DO_NOT_LOG_TRANSCRIPT', token: 'DO_NOT_LOG_TOKEN' };
  trace(entry); trace(entry);
  assert.equal(output[0]!.pendingId, output[1]!.pendingId);
  const serialized = JSON.stringify(output);
  for (const secret of ['private-identifier', 'private-item', 'DO_NOT_LOG_EMAIL', 'DO_NOT_LOG_TRANSCRIPT', 'DO_NOT_LOG_TOKEN']) assert.ok(!serialized.includes(secret));
  assert.doesNotThrow(() => confirmationTracer(true, () => { throw new Error('Logging unavailable'); })(entry));
  confirmationTracer(false, () => assert.fail('Disabled logger called'))(entry);
});
