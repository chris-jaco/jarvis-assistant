// Executable specification only. Identity here means the future server's verified
// credential context. Never derive it from a caller-supplied decision body.
import test from 'node:test';
import assert from 'node:assert/strict';

function decide(intent, identity, decision, now) {
  if (identity.revoked || identity.expires <= now || intent.expires <= now ||
      intent.user !== identity.user || intent.device !== identity.device ||
      intent.session !== identity.session || decision.id !== intent.id ||
      decision.digest !== intent.digest || decision.nonce !== intent.nonce) return 'REJECTED';
  if (intent.state !== 'PENDING') return 'ALREADY_HANDLED';
  intent.state = decision.approved === true ? 'RESERVED' : 'CANCELLED';
  return intent.state;
}
const user = { user: 'u', device: 'phone', session: 's', expires: 90 };
const intent = { ...user, id: 'i', digest: 'synthetic-operation', nonce: 'n', state: 'PENDING' };
const approval = { id: 'i', digest: intent.digest, nonce: 'n', approved: true };
test('remote design binds a decision to the initiating device, session, operation and lifetime', () => {
  for (const changed of [{ user: 'other' }, { device: 'pc' }, { session: 'other' }, { revoked: true }, { expires: 50 }]) {
    assert.equal(decide({ ...intent }, { ...user, ...changed }, approval, 50), 'REJECTED');
  }
  for (const changed of [{ id: 'next' }, { digest: 'edited' }, { nonce: 'old' }]) {
    assert.equal(decide({ ...intent }, user, { ...approval, ...changed }, 50), 'REJECTED');
  }
  assert.equal(decide({ ...intent, expires: 50 }, user, approval, 50), 'REJECTED');
});
test('remote design treats denial, reservation and unknown completion as terminal for a decision', () => {
  for (const approved of [true, false]) {
    const pending = { ...intent };
    assert.equal(decide(pending, user, { ...approval, approved }, 50), approved ? 'RESERVED' : 'CANCELLED');
    assert.equal(decide(pending, user, approval, 51), 'ALREADY_HANDLED');
  }
  assert.equal(decide({ ...intent, state: 'UNKNOWN' }, user, approval, 50), 'ALREADY_HANDLED');
});
