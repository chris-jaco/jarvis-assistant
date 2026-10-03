import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunContext } from '@openai/agents-core';
import { z } from 'zod';
import { VoiceToolBridge } from '../provider/tools.js';
import type { ConfirmationTrace } from '../diagnostics/confirmation.js';
import { ToolRegistry } from './registry.js';
import { ToolExecutor } from './execution.js';
async function fixture(traceEnabled = false) {
  const traces: ConfirmationTrace[] = [];
  const original = globalThis.fetch; let now = Date.now(); let executions = 0; let invocations = 0;
  const registry = new ToolRegistry();
  registry.register({ id: 'calendar.deleteEvent', name: 'Delete', description: 'Delete', integration: 'test', capability: 'delete', permission: 'SENSITIVE', schema: z.object({}), execute: async () => { executions++; return { deleted: true }; } });
  const executor = new ToolExecutor(registry, () => now);
  const decisions: boolean[] = []; const messages: string[] = [];
  globalThis.fetch = async (url, options) => {
    const path = String(url).split('/').pop(); const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (path === 'session') return Response.json({ confirmationTrace: traceEnabled, tools: registry.descriptors(), timezone: 'Europe/Madrid', now: new Date(now).toISOString() });
    if (path === 'invoke') { invocations++; return Response.json(await executor.invoke(body.invocationId, body.toolId, body.input)); }
    if (path === 'activity') return Response.json({ activity: executor.telemetry.snapshot(), pending: executor.pendingState() });
    if (path === 'cancel') { executor.invalidate(); return Response.json({ cancelled: true }); }
    if (path === 'decision') { decisions.push(body.approved); return Response.json(await executor.decide(body.confirmationId, body.approved)); }
    throw new Error('Unexpected path');
  };
  const bridge = new VoiceToolBridge(() => {}, message => messages.push(message), entry => traces.push(entry));
  const config = await bridge.initialize();
  const invoke = () => config.tools[0]!.invoke(new RunContext(), JSON.stringify({ inputJson: '{}' }));
  await invoke();
  const event = (type: string, fields: Record<string, unknown> = {}) => bridge.transportEvent({ type, ...fields });
  const prompt = async () => { await event('output_audio_buffer.started', { response_id: 'prompt' }); await event('output_audio_buffer.stopped', { response_id: 'prompt' }); };
  const speech = (item = 'new') => event('input_audio_buffer.speech_started', { item_id: item });
  const transcript = (text: string, item = 'new') => event('conversation.item.input_audio_transcription.completed', { item_id: item, transcript: text });
  return { traces, bridge, executor, decisions, messages, invoke, event, prompt, speech, transcript, executions: () => executions, invocations: () => invocations, expire: () => { now += 60_001; }, close: () => { bridge.close(); executor.close(); globalThis.fetch = original; } };
}
test('speech started before prompt completion cannot confirm, even when transcript arrives after completion', async () => {
  const f = await fixture(); try { await f.event('output_audio_buffer.started', { response_id: 'prompt' }); await f.speech(); await f.event('output_audio_buffer.stopped', { response_id: 'prompt' }); await f.speech(); await f.transcript('Sí'); assert.equal(f.executions(), 0); assert.equal(f.bridge.pending, null); } finally { f.close(); }
});
for (const phrase of ['sí', 'sí, confirma', 'confirmar', 'adelante', 'hazlo', 'sí, hazlo']) {
  test(`new post-prompt utterance '${phrase}' executes once, even if Realtime repeats a tool before transcription`, async () => {
    const f = await fixture(); try {
      const frozen = f.bridge.pending!.confirmationId;
      await f.prompt(); await f.speech();
      await f.invoke(); // create_response happens before final transcription; must not hit backend.
      assert.equal(f.invocations(), 1); assert.equal(f.bridge.pending?.confirmationId, frozen); assert.equal(f.executor.pendingState()?.confirmationId, frozen);
      await f.transcript(phrase); await f.transcript(phrase);
      assert.deepEqual(f.decisions, [true]); assert.equal(f.executions(), 1);
      assert.equal(f.executor.telemetry.snapshot()[0]?.confirmation, 'granted');
    } finally { f.close(); }
  });
}
for (const phrase of ['no', 'cancelar', 'cancela', 'no lo hagas']) {
  test(`negative '${phrase}' rejects without executing`, async () => { const f = await fixture(); try { await f.prompt(); await f.speech(); await f.transcript(phrase); assert.deepEqual(f.decisions, [false]); assert.equal(f.executions(), 0); } finally { f.close(); } });
}
test('unrelated or ambiguous speech never executes and invalidates pending action', async () => {
  for (const text of ['¿Qué tiempo hace?', 'No sé si sí o no', 'Sí, pero cambia la hora']) {
    const f = await fixture(); try { await f.prompt(); await f.speech(); await f.transcript(text); assert.equal(f.executions(), 0); assert.equal(f.executor.pendingState(), null); } finally { f.close(); }
  }
});
test('stale playback stop and cleared/interrupted prompt never arm approval', async () => {
  for (const interrupted of [false, true]) { const f = await fixture(); try {
    await f.event('output_audio_buffer.started', { response_id: 'prompt' });
    if (interrupted) await f.event('output_audio_buffer.cleared');
    await f.event('output_audio_buffer.stopped', { response_id: interrupted ? 'prompt' : 'previous' });
    await f.speech(); await f.transcript('sí'); assert.equal(f.executions(), 0);
  } finally { f.close(); } }
});
test('expired confirmation cannot execute; backend clock remains authoritative', async () => {
  const f = await fixture(); try { await f.prompt(); await f.speech(); f.expire(); await f.transcript('sí'); assert.equal(f.executions(), 0); assert.equal(f.executor.telemetry.snapshot()[0]?.confirmation, 'expired'); } finally { f.close(); }
});
test('old action transcript cannot approve a later pending action', async () => {
  const f = await fixture(); try {
    await f.prompt(); await f.speech('old'); const old = f.bridge.pending!.confirmationId;
    await f.bridge.decide(false); await f.invoke(); await f.prompt();
    assert.notEqual(f.bridge.pending!.confirmationId, old); await f.transcript('sí', 'old'); assert.equal(f.executions(), 0);
    await f.speech('new'); await f.transcript('sí', 'new'); assert.equal(f.executions(), 1);
  } finally { f.close(); }
});
test('UI confirmation works without speech/playback and is consumed exactly once', async () => {
  const f = await fixture(); try { await Promise.all([f.bridge.decide(true), f.bridge.decide(true)]); assert.equal(f.executions(), 1); assert.deepEqual(f.decisions, [true]); } finally { f.close(); }
});

test('diagnostics identify affirmative cancellation with missing playback ID without exposing transcript or inputs', async () => {
  const f = await fixture(true); try {
    await f.prompt(); await f.speech('correction'); await f.transcript('Change the private attendee address', 'correction');
    const oldId = f.traces.find(entry => entry.event === 'tool.result')!.pendingId;
    await f.invoke();
    const newId = f.bridge.pending!.confirmationId;
    // This is a diagnostic probe, not a claim about the unknown live ordering.
    await f.event('output_audio_buffer.started', { response_id: 'prompt2', secret: 'DO_NOT_LOG_EVENT' });
    await f.event('output_audio_buffer.stopped');
    await f.speech('confirmation');
    await f.event('response.created', { response: { id: 'acknowledgment', text: 'DO_NOT_LOG_RESPONSE' } });
    await f.invoke();
    await f.event('response.done', { response: { id: 'acknowledgment' } });
    await f.transcript('Sí, confirmo.', 'confirmation');
    const classification = [...f.traces].reverse().find(entry => entry.event === 'transcript.classify')!;
    assert.equal(classification.classification, 'affirmative'); assert.equal(classification.capturedApprovable, false);
    assert.ok(f.traces.some(entry => entry.reason === 'missing_response_id'));
    assert.ok(f.traces.some(entry => entry.reason === 'blocked_while_pending'));
    assert.ok(f.traces.some(entry => entry.reason === 'affirmative_but_ineligible'));
    assert.notEqual(classification.pendingId, oldId);
    assert.equal(f.executions(), 0); assert.deepEqual(f.decisions, []);
    const output = JSON.stringify(f.traces);
    for (const value of [newId, 'Sí, confirmo', 'private attendee', 'DO_NOT_LOG_EVENT', 'DO_NOT_LOG_RESPONSE', 'acknowledgment']) assert.ok(!output.includes(value));
  } finally { f.close(); }
});
test('diagnostics observe cleared audio and captured eligibility separately; disabled tracing emits nothing', async () => {
  for (const enabled of [true, false]) {
    const f = await fixture(enabled); try {
      await f.prompt(); await f.event('output_audio_buffer.cleared'); await f.speech(); await f.transcript('Sí, confirmo.');
      if (enabled) {
        assert.ok(f.traces.some(entry => entry.event === 'playback.clear' && entry.armed === false));
        assert.ok(f.traces.some(entry => entry.event === 'speech.capture' && entry.capturedApprovable === false));
      } else assert.deepEqual(f.traces, []);
    } finally { f.close(); }
  }
});
