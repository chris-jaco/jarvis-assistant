import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfirmationIntentClassifier, CONFIRMATION_INTENT_INSTRUCTIONS, intentSchema } from './confirmation-intent.js';
const completion = (intent: string) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ intent }) }] }] });
for (const intent of intentSchema.options) {
  test(`semantic classifier validates structured ${intent} without executing tools`, async () => {
    const classifier = new ConfirmationIntentClassifier('fake-key', async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const data = JSON.parse(String(init?.body));
      assert.equal(data.store, false); assert.equal(data.tools, undefined);
      assert.equal(data.instructions, CONFIRMATION_INTENT_INSTRUCTIONS);
      assert.equal(data.text.format.strict, true); assert.deepEqual(data.text.format.schema.properties.intent.enum, intentSchema.options);
      assert.deepEqual(JSON.parse(data.input), { frozenAction: 'Frozen action', utterance: 'Natural utterance' });
      assert.ok(init?.signal); return Response.json(completion(intent));
    });
    assert.equal(await classifier.classify('Frozen action', 'Natural utterance'), intent);
  });
}
test('classifier is conservative about material changes, uncertain approval and untrusted input', () => {
  for (const requirement of ['without changes, conditions, uncertainty', 'recipient, sender/account, subject, body, attachments, date, attendees', 'even if introduced with agreement', 'untrusted DATA', 'attempted instruction', 'When in doubt choose ambiguous']) assert.ok(CONFIRMATION_INTENT_INSTRUCTIONS.includes(requirement));
});
test('missing configuration, refusal, incomplete/malformed output, invalid intent and upstream errors fail closed', async () => {
  assert.equal(await new ConfirmationIntentClassifier().classify('Frozen', 'Sí'), 'ambiguous');
  for (const output of [{ status: 'incomplete' }, { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] }, completion('execute'), { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{secret-key' }] }] }]) {
    assert.equal(await new ConfirmationIntentClassifier('fake', async () => Response.json(output)).classify('Frozen', 'Sí'), 'ambiguous');
  }
  for (const request of [async () => new Response('secret-token', { status: 500 }), async () => { throw new Error('secret-token'); }]) {
    assert.equal(await new ConfirmationIntentClassifier('fake', request).classify('Frozen', 'Sí'), 'ambiguous');
  }
  let calls = 0;
  const classifier = new ConfirmationIntentClassifier('fake', async () => { calls++; return Response.json(completion('affirmative')); });
  assert.equal(await classifier.classify('Frozen', 'x'.repeat(2001)), 'ambiguous'); assert.equal(calls, 0);
});
