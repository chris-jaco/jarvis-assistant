import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { RunContext } from '@openai/agents-core';
import { z } from 'zod';
import { VoiceToolBridge } from '../provider/tools.js';
import { OpenAIVoiceProvider } from '../provider/openai.js';
import { ToolRegistry } from '../tools/registry.js';
import { ToolExecutor } from '../tools/execution.js';
import { ConfirmationDialog } from './confirmation-dialog.js';
async function fixture(deferIntent = false) {
  const doc = new JSDOM(await readFile('index.html', 'utf8')).window.document as unknown as Document;
  const dialog = doc.querySelector('dialog')!; dialog.showModal = () => dialog.setAttribute('open', ''); dialog.close = () => dialog.removeAttribute('open');
  const registry = new ToolRegistry(); let executions = 0; let now = Date.now(); const frozen = 'synthetic body never rendered';
  registry.register({ id: 'gmail.send', name: 'Send', description: 'Test', integration: 'test', capability: 'send', permission: 'SENSITIVE', schema: z.object({ body: z.string() }), summarize: () => '¿Confirmás enviar el mensaje de prueba?', execute: async input => { assert.equal((input as { body: string }).body, frozen); executions++; return { sent: true }; } });
  const executor = new ToolExecutor(registry, () => now); const original = globalThis.fetch; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async (url, options) => {
    const path = String(url).split('/').pop(); const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (path === 'session') return Response.json({ tools: registry.descriptors(), timezone: 'Europe/Madrid', now: new Date(now).toISOString() });
    if (path === 'invoke') return Response.json(await executor.invoke(body.invocationId, body.toolId, body.input));
    if (path === 'activity') return Response.json({ activity: executor.telemetry.snapshot(), pending: executor.pendingState() });
    if (path === 'decision') return Response.json(await executor.decide(body.confirmationId, body.approved));
    if (path === 'intent') { if (deferIntent) await gate; return Response.json({ confirmationId: body.confirmationId, intent: 'affirmative' }); }
    throw new Error('Unexpected test request');
  };
  const provider = new OpenAIVoiceProvider({ state: () => {}, transcript: () => {} }, doc.querySelector('audio')!);
  const yes = doc.querySelector<HTMLButtonElement>('#tool-approve')!; const no = doc.querySelector<HTMLButtonElement>('#tool-reject')!;
  const ui = new ConfirmationDialog(dialog, doc.querySelector('#tool-confirmation')!, doc.querySelector('#confirmation-status')!, yes, no, (approved, id) => provider.confirmTool(approved, id));
  const bridge = new VoiceToolBridge((_rows, pending) => ui.update(pending), () => {}); Object.defineProperty(provider, 'tools', { value: bridge });
  const config = await bridge.initialize(); const invoke = () => config.tools[0]!.invoke(new RunContext(), JSON.stringify({ inputJson: JSON.stringify({ body: frozen }) }));
  await invoke();
  const event = (type: string, fields: Record<string, unknown> = {}) => bridge.transportEvent({ type, ...fields });
  const prompt = async () => { await event('response.created', { response: { id: 'prompt' } }); await event('output_audio_buffer.stopped', { response_id: 'prompt' }); await event('input_audio_buffer.speech_started', { item_id: 'yes' }); };
  const voice = () => event('conversation.item.input_audio_transcription.completed', { item_id: 'yes', transcript: 'Sí, confirmo.' });
  const settle = async () => { for (let i = 0; i < 30 && dialog.open; i++) await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(dialog.open, false); };
  return { provider, ui, dialog, get yes() { return doc.querySelector<HTMLButtonElement>('#tool-approve')!; }, get no() { return doc.querySelector<HTMLButtonElement>('#tool-reject')!; }, bridge, invoke, prompt, voice, release, settle, executions: () => executions, expire: () => { now += 60001; }, close: () => { release(); ui.dispose(); bridge.close(); executor.close(); globalThis.fetch = original; } };
}
test('voice approval closes the same dialog; stale clicks cannot send twice or render raw parameters', async () => {
  const f = await fixture(); try {
    assert.equal(f.dialog.open, true); assert.equal(f.dialog.querySelector('#tool-confirmation')!.textContent, f.bridge.pending!.summary); assert.ok(!f.dialog.textContent!.includes('synthetic body'));
    await f.prompt(); await f.voice(); assert.equal(f.executions(), 1); assert.equal(f.dialog.open, false); f.yes.click(); assert.equal(f.executions(), 1);
  } finally { f.close(); }
});
test('click then late voice cannot execute twice', async () => {
  const f = await fixture(); try { await f.prompt(); f.yes.click(); await f.voice(); await f.settle(); assert.equal(f.executions(), 1); } finally { f.close(); }
});
test('click during semantic classification supersedes it and shares the exact frozen action', async () => {
  const f = await fixture(true); try { await f.prompt(); const voice = f.voice(); f.yes.click(); f.release(); await voice; await f.settle(); assert.equal(f.executions(), 1); } finally { f.close(); }
});
test('dialog Cancel rejects through the existing backend decision path', async () => {
  const f = await fixture(); try { f.no.click(); await f.settle(); assert.equal(f.executions(), 0); assert.equal(f.bridge.pending, null); } finally { f.close(); }
});
test('stale dialog ID cannot approve a replacement action and backend expiry prevents execution', async () => {
  const f = await fixture(); try {
    const old = f.bridge.pending!; await f.bridge.decide(false); await f.invoke(); const current = f.bridge.pending!; assert.notEqual(old.confirmationId, current.confirmationId);
    f.ui.update(old); f.yes.click(); assert.equal(f.executions(), 0); assert.equal(f.bridge.pending!.confirmationId, current.confirmationId);
    f.ui.update(current); f.expire(); f.yes.click(); await f.settle(); assert.equal(f.executions(), 0);
  } finally { f.close(); }
});
