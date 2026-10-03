import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunContext } from '@openai/agents-core';
import { VoiceToolBridge } from '../provider/tools.js';
const id = '00000000-0000-4000-8000-000000000001';
async function fixture() {
  const original = globalThis.fetch;
  let pending: { confirmationId: string; summary: string; expiresAt: number } | null = null;
  const decisions: boolean[] = []; const messages: string[] = [];
  globalThis.fetch = async (url, options) => {
    const path = String(url).split('/').pop();
    if (path === 'session') return Response.json({ tools: [{ id: 'calendar.deleteEvent', description: 'Delete', inputSchema: {} }], timezone: 'Europe/Madrid', now: new Date().toISOString() });
    if (path === 'invoke') { pending = { confirmationId: id, summary: '¿Eliminar Prueba?', expiresAt: Date.now() + 60_000 }; return Response.json({ status: 'pending', ...pending }); }
    if (path === 'activity') return Response.json({ activity: [], pending });
    if (path === 'cancel') { pending = null; return Response.json({ cancelled: true }); }
    if (path === 'decision') { decisions.push(JSON.parse(String(options?.body)).approved); pending = null; return Response.json({ status: 'success', data: { deleted: true } }); }
    throw new Error('Unexpected path');
  };
  const bridge = new VoiceToolBridge(() => {}, message => messages.push(message));
  const config = await bridge.initialize();
  await config.tools[0]!.invoke(new RunContext(), JSON.stringify({ inputJson: '{}' }));
  return { bridge, decisions, messages, close: () => { bridge.close(); globalThis.fetch = original; } };
}
test('voice yes requires new speech after confirmation prompt playback, cannot approve delayed old transcript', async () => {
  const early = await fixture();
  try { early.bridge.speechStarted('early'); await early.bridge.transcript('early', 'Sí.'); assert.deepEqual(early.decisions, []); assert.equal(early.bridge.pending, null); } finally { early.close(); }
  const f = await fixture();
  try {
    f.bridge.playbackFinished(); f.bridge.speechStarted('new'); await f.bridge.transcript('old', 'No.'); assert.deepEqual(f.decisions, []);
    await f.bridge.transcript('old', 'Sí.'); assert.deepEqual(f.decisions, []);
    await f.bridge.transcript('new', 'Sí.'); assert.deepEqual(f.decisions, [true]); await f.bridge.transcript('new', 'Sí.'); assert.equal(f.decisions.length, 1); assert.equal(f.messages.length, 1);
  } finally { f.close(); }
});
test('voice no rejects and unrelated new utterance invalidates pending confirmation', async () => {
  const rejected = await fixture(); try { rejected.bridge.playbackFinished(); rejected.bridge.speechStarted('new'); await rejected.bridge.transcript('new', 'No.'); assert.deepEqual(rejected.decisions, [false]); } finally { rejected.close(); }
  const unrelated = await fixture(); try { unrelated.bridge.playbackFinished(); unrelated.bridge.speechStarted('new'); await unrelated.bridge.transcript('new', '¿Qué tiempo hace?'); await unrelated.bridge.transcript('new', 'Sí.'); assert.deepEqual(unrelated.decisions, []); assert.equal(unrelated.bridge.pending, null); } finally { unrelated.close(); }
});
