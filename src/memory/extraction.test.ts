import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIMemoryExtraction, MEMORY_EXTRACTION_INSTRUCTIONS } from './extraction.js';
const entity = (name: string) => ({ identity: name.toLowerCase(), name, aliases: [] });
const response = (memories: unknown[]) => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ memories }) }] }] });
const memory = (utterance: string) => ({ type: 'ORGANIZATION', subject: entity('Frekuent'), key: 'markets', content: 'Frekuent is a client expanding to Portugal.', value: [{ key: 'market', value: 'Portugal' }], relationships: [], confidence: 0.98, importance: 0.85, expiresAt: null, evidence: utterance, sourceKind: 'explicit_user' });
test('normal stable statements extract compact grounded memory without requiring remember phrasing', async () => {
  const utterance = "Frekuent is a client and we're expanding to Portugal.";
  const extraction = new OpenAIMemoryExtraction('fake', 'Europe/Madrid', async (_url, init) => {
    const body = JSON.parse(String(init?.body)); assert.equal(body.store, false); assert.equal(body.tools, undefined); assert.equal(body.text.format.strict, true); assert.equal(JSON.parse(body.input).utterance, utterance); return response([memory(utterance)]);
  });
  const results = await extraction.extract(utterance, [], new Date().toISOString()); assert.equal(results.length, 1); assert.equal(results[0]!.candidate.value.market, 'Portugal'); assert.equal(results[0]!.sourceKind, 'explicit_user');
});
test('irrelevant chatter, missing configuration, invalid output and ungrounded/low-confidence guesses yield no candidates', async () => {
  const now = new Date().toISOString(); const utterance = 'Hola, gracias.';
  assert.deepEqual(await new OpenAIMemoryExtraction().extract(utterance, [], now), []);
  assert.deepEqual(await new OpenAIMemoryExtraction('fake', undefined, async () => response([])).extract(utterance, [], now), []);
  for (const candidate of [memory('statement not said'), { ...memory(utterance), confidence: 0.2 }, { ...memory(utterance), sourceKind: 'system' }]) assert.deepEqual(await new OpenAIMemoryExtraction('fake', undefined, async () => response([candidate])).extract(utterance, [], now), []);
  assert.deepEqual(await new OpenAIMemoryExtraction('fake', undefined, async () => new Response('private', { status: 500 })).extract(utterance, [], now), []);
  for (const term of ['greetings', 'entire emails/documents', 'assistant speculation', 'VERBATIM', 'SAME entity identity']) assert.ok(MEMORY_EXTRACTION_INSTRUCTIONS.includes(term));
});
test('deterministic raw secret filtering runs before LLM; returned secret candidates are also rejected', async () => {
  let calls = 0; const now = new Date().toISOString();
  const extraction = new OpenAIMemoryExtraction('fake', undefined, async () => { calls++; return response([memory('api key: secret-value')]); });
  assert.deepEqual(await extraction.extract('api key: secret-value', [], now), []); assert.equal(calls, 0);
  assert.deepEqual(await extraction.extract('Frekuent is a client.', [], now), []); assert.equal(calls, 1);
});
test('literal and spelled domain corrections cannot be rewritten even when model evidence omits the spelling', async () => {
  for (const utterance of ['La plataforma es Onabox.ai', 'La plataforma es O-N-A-B-O-X.ai']) {
    const now = new Date().toISOString();
    for (const name of ['Onabox.ai', 'onavox.ai']) {
      const item = { ...memory('La plataforma'), content: `La plataforma es ${name}.`, value: [{ key: 'platform', value: name }] };
      const result = await new OpenAIMemoryExtraction('fake', undefined, async () => response([item])).extract(utterance, [], now);
      assert.equal(result.length, name === 'Onabox.ai' ? 1 : 0);
    }
  }
});
