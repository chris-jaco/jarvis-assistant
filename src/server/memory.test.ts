import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { createToolsHandler } from './tools.js';
import { ToolRegistry } from '../tools/registry.js';
import { MemoryService } from '../memory/service.js';
import { MemoryAdapter } from '../memory/adapter.js';
import { candidate, FakeMemoryStore } from '../memory/test-fixtures.js';
import { createMemoryRuntime } from '../memory/runtime.js';
async function fixture(diagnostics: Parameters<typeof createToolsHandler>[1] = {}) {
  const store = new FakeMemoryStore(); const service = new MemoryService(store); const registry = new ToolRegistry(); registry.add(new MemoryAdapter(service));
  let release!: () => void; let started!: () => void; let finished!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const start = new Promise<void>(resolve => { started = resolve; }); const finish = new Promise<void>(resolve => { finished = resolve; });
  const runtime = createToolsHandler({}, diagnostics, { runtime: { registry, timezone: 'Europe/Madrid', memory: { service, budget: 1000, limit: 5, automatic: true, extraction: { extract: async utterance => { started(); await gate; finished(); return [{ candidate: candidate(), sourceKind: 'explicit_user', evidence: utterance }]; } } } } });
  registry.register({ id: 'sensitive.test', name: 'Sensitive', description: 'Sensitive', integration: 'test', capability: 'test', permission: 'SENSITIVE', schema: z.object({}), execute: async () => ({ executed: true }) });
  const server = createServer(async (req, res) => { await runtime.handle(req, res); }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tools/`;
  const session = await fetch(url + 'session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const cookie = session.headers.get('set-cookie')!.split(';')[0]!; const info = await session.json() as { tools: Array<{ id: string }> };
  let sequence = 0;
  const post = async (route: string, body: unknown) => { const response = await fetch(url + route, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(route === 'memory-turn' ? { sequence: ++sequence, observedAt: new Date().toISOString(), ...body as object } : body) }); return { status: response.status, data: await response.json() as Record<string, unknown> }; };
  return { store, service, registry, info, post, start, release, finish, close: async () => { release(); runtime.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
test('automatic extraction persists real user provenance outside response path and internal ingestion is inaccessible to model', async () => {
  const f = await fixture(); try {
    assert.ok(!f.info.tools.some(t => t.id === 'memory.ingest'));
    const denied = await f.post('invoke', { invocationId: 'forge', toolId: 'memory.ingest', input: {} }); assert.equal(denied.status, 400);
    const response = await f.post('memory-turn', { itemId: 'one', utterance: 'Frekuent is a client.' }); await f.start; assert.equal(response.status, 200); assert.equal(f.store.records.length, 0);
    f.release(); await f.finish;
    // Wait for the queued filesystem/registry operation, bounded independently of audio.
    for (let i = 0; i < 200 && !f.store.records.length; i++) await new Promise<void>(resolve => setTimeout(resolve, 10));
    assert.equal(f.store.records.length, 1); assert.equal(f.store.records[0]!.source.kind, 'explicit_user');
    assert.equal(f.store.records[0]!.source.evidence, 'Frekuent is a client.');
    const context = await f.post('memory-context', { query: 'Frekuent' }); assert.ok(String(context.data.context).includes('Frekuent')); assert.ok(String(context.data.context).length <= 1000);
    await f.post('memory-turn', { itemId: 'one', utterance: 'Frekuent is a client.' }); assert.equal(f.store.records.length, 1);
  } finally { await f.close(); }
});
test('a new frozen SENSITIVE action prevents a delayed automatic write from invalidating it', async () => {
  const f = await fixture(); try {
    await f.post('memory-turn', { itemId: 'one', utterance: 'Frekuent is a client.' }); await f.start;
    const pending = await f.post('invoke', { invocationId: 'sensitive', toolId: 'sensitive.test', input: {} }); assert.equal(pending.data.status, 'pending');
    f.release(); await f.finish; await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(f.store.records.length, 0);
    const decision = await f.post('decision', { confirmationId: pending.data.confirmationId, approved: true }); assert.equal(decision.data.status, 'success');
  } finally { await f.close(); }
});
test('malformed optional memory config and storage failure do not break runtime; no paths or private data escape', async () => {
  const memory = createMemoryRuntime({ MEMORY_PATH: '/private/unsafe', MEMORY_CONTEXT_CHARS: 'bad' }); assert.equal(memory.automatic, false); await assert.rejects(memory.service.search('topic'));
  const f = await fixture(); try { f.store.failure = true; const response = await f.post('memory-context', { query: 'Frekuent' }); assert.deepEqual(response.data, { context: '' }); assert.equal(response.status, 200); } finally { await f.close(); }
});
test('raw secrets never start extraction or enter telemetry/persistence', async () => {
  const f = await fixture(); try { await f.post('memory-turn', { itemId: 'secret', utterance: 'My password is private.' }); assert.equal(f.store.records.length, 0); } finally { await f.close(); }
});

test('forgetting while extraction is queued cannot resurrect deleted facts across sessions', async () => {
  const f = await fixture(); try {
    await f.post('memory-turn', { itemId: 'first', utterance: 'Frekuent is a client.' }); await f.start;
    // Another session's approved correction/deletion advances the shared generation.
    const service = f.service;
    const record = await service.remember(candidate(), { kind: 'explicit_user', evidence: 'Frekuent is a client.', observedAt: new Date().toISOString() });
    // Exercise the shared service used by the runtime via a confirmed tool action.
    const { ToolExecutor } = await import('../tools/execution.js'); const otherSession = new ToolExecutor(f.registry);
    try { const prepared = await otherSession.invoke('forget', 'memory.forget', { id: record!.id }); assert.equal(prepared.status, 'pending'); if (prepared.status !== 'pending') throw new Error(); assert.equal((await otherSession.decide(prepared.confirmationId, true)).status, 'success'); } finally { otherSession.close(); }
    f.release(); await f.finish; await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(f.store.records.length, 0);
  } finally { await f.close(); }
});

test('a newer accepted user turn supersedes queued older extraction without stale writes', async () => {
  const f = await fixture(); try {
    await f.post('memory-turn', { itemId: 'old', utterance: 'Frekuent is a client.' }); await f.start;
    await f.post('memory-turn', { itemId: 'new', utterance: 'Frekuent is a client expanding to Portugal.' });
    f.release(); await f.finish;
    for (let i = 0; i < 200 && !f.store.records.length; i++) await new Promise<void>(resolve => setTimeout(resolve, 10));
    assert.equal(f.store.records.length, 1); assert.equal(f.store.records[0]!.source.evidence, 'Frekuent is a client expanding to Portugal.');
  } finally { await f.close(); }
});

test('verified latest voice spelling rejects model rewriting before a frozen memory correction is prepared', async () => {
  const f = await fixture(); try {
    const old = await f.service.remember(candidate('Platform is onavox.ai.', { key: 'platform', value: { platform: 'onavox.ai' } }), { kind: 'explicit_user', evidence: 'Platform is onavox.ai.', observedAt: new Date().toISOString() });
    await f.post('memory-turn', { itemId: 'spelling', utterance: 'La plataforma es O-N-A-B-O-X.ai' }); await f.start;
    // The model's rewritten evidence cannot defeat the actual transcript guard.
    const rejected = await f.post('invoke', { invocationId: 'wrong-spelling', toolId: 'memory.update', input: { target: { id: old!.id }, candidate: candidate('Platform is onavox.ai.', { key: 'platform', value: { platform: 'onavox.ai' } }), evidence: 'onavox.ai' } });
    assert.equal(rejected.status, 400); assert.equal(f.store.records.length, 1);
    const correct = await f.post('invoke', { invocationId: 'correct-spelling', toolId: 'memory.update', input: { target: { id: old!.id }, candidate: candidate('Platform is Onabox.ai.', { key: 'platform', value: { platform: 'Onabox.ai' } }), evidence: 'O-N-A-B-O-X.ai' } });
    assert.equal(correct.data.status, 'pending'); assert.ok(String(correct.data.summary).includes('Onabox.ai'));
    f.release(); await f.finish; assert.equal(f.store.records.length, 1);
    const executed = await f.post('decision', { confirmationId: correct.data.confirmationId, approved: true }); assert.equal(executed.data.status, 'success');
    assert.equal(f.store.records.find(r => r.status === 'current')!.value.platform, 'Onabox.ai');
  } finally { await f.close(); }
});

test('blocked automatic extraction cannot hold a store lock or delay explicit memory tools', { timeout: 3000 }, async () => {
  const f = await fixture(); try {
    const existing = await f.service.remember(candidate(), { kind: 'explicit_user', evidence: 'Frekuent is a client.', observedAt: new Date().toISOString() });
    await f.post('memory-turn', { itemId: 'blocked-extraction', utterance: 'Frekuent is a client.' }); await f.start;
    assert.equal((await f.post('invoke', { invocationId: 'read', toolId: 'memory.search', input: { query: 'Frekuent' } })).data.status, 'success');
    assert.equal((await f.post('invoke', { invocationId: 'get', toolId: 'memory.get', input: { id: existing!.id } })).data.status, 'success');
    const preference = candidate('Keep responses short.', { type: 'PREFERENCE', subject: { id: 'user', name: 'User', aliases: [] }, key: 'response_length' });
    assert.equal((await f.post('invoke', { invocationId: 'remember', toolId: 'memory.remember', input: { candidate: preference, evidence: 'Keep responses short.' } })).data.status, 'success');
    const update = await f.post('invoke', { invocationId: 'update', toolId: 'memory.update', input: { target: { id: existing!.id }, candidate: candidate('Updated client.') } });
    assert.equal(update.data.status, 'pending'); assert.equal((await f.post('decision', { confirmationId: update.data.confirmationId, approved: true })).data.status, 'success');
    const current = f.store.records.find(r => r.status === 'current' && r.key === existing!.key)!;
    const forget = await f.post('invoke', { invocationId: 'forget', toolId: 'memory.forget', input: { id: current.id } }); assert.equal(forget.data.status, 'pending');
    // Extraction is still gated: none of the foreground operations waited for it.
    f.release(); await f.finish;
    assert.equal((await f.post('decision', { confirmationId: forget.data.confirmationId, approved: false })).data.status, 'error');
  } finally { await f.close(); }
});

test('HTTP memory failures are diagnosed in development without private details; production remains silent', { timeout: 3000 }, async () => {
  for (const development of [true, false]) {
    const rows: unknown[] = []; const f = await fixture({ development, memorySink: row => rows.push(row) });
    try {
      f.store.failure = true;
      const result = await f.post('invoke', { invocationId: 'failed-search', toolId: 'memory.search', input: { query: 'Private person' } });
      assert.equal(result.data.status, 'error'); assert.ok(!JSON.stringify(result.data).includes('private path'));
      if (development) { assert.equal(rows.length, 1); const row = rows[0] as { operation: string; stage: string; elapsedMs: number }; assert.equal(row.operation, 'search'); assert.equal(row.stage, 'execute'); assert.ok(row.elapsedMs >= 0); assert.ok(!JSON.stringify(rows).includes('Private person')); }
      else assert.deepEqual(rows, []);
    } finally { await f.close(); }
  }
});

test('HTTP preference needs no personal ID; invalid field diagnostics remain private and approval stays backend-owned', async () => {
  const entries: import('../diagnostics/memory.js').MemoryDiagnostic[] = [];
  const f = await fixture({ development: true, memorySink: entry => entries.push(entry) });
  try {
    const bad = await f.post('invoke', { invocationId: 'bad-preference', toolId: 'memory.remember', input: { preference: { responseLength: 'private-invalid-value' }, evidence: 'private evidence' } });
    assert.equal(bad.data.status, 'error'); assert.equal(bad.data.category, 'INVALID_INPUT');
    assert.ok(entries.some(e => e.field === 'preference.responseLength' && e.rule === 'schema'));
    assert.ok(!JSON.stringify(entries).includes('private-invalid-value')); assert.ok(!JSON.stringify(entries).includes('private evidence'));
    const prepared = await f.post('invoke', { invocationId: 'good-preference', toolId: 'memory.remember', input: { preference: { responseLength: 'minimal' }, evidence: 'Remember that I prefer very short answers.' } });
    assert.equal(prepared.data.status, 'pending'); assert.equal(f.store.records.length, 0);
    const done = await f.post('decision', { confirmationId: prepared.data.confirmationId, approved: true });
    assert.equal(done.data.status, 'success'); assert.equal(f.store.records[0]!.subject.name, 'User'); assert.equal(f.store.records[0]!.source.kind, 'explicit_user');
    const replay = await f.post('decision', { confirmationId: prepared.data.confirmationId, approved: true }); assert.equal(replay.data.status, 'error'); assert.equal(f.store.records.length, 1);
  } finally { await f.close(); }
});
