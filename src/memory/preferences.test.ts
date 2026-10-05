import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import { FakeMemoryStore, candidate, source } from './test-fixtures.js';
import { MemoryService, normalize } from './service.js';
import { MemoryAdapter } from './adapter.js';
import { PrivateJsonMemoryStore } from './store.js';
import { responsePreference } from './preferences.js';
import { containsMemorySecrets, containsSecret } from './privacy.js';
import { ToolRegistry } from '../tools/registry.js';
import { ToolExecutor } from '../tools/execution.js';
import { MemoryDiagnostics } from '../diagnostics/memory.js';
import type { MemoryDiagnostic } from '../diagnostics/memory.js';
import { MemoryValidationError, validationField } from './validation.js';
import { JARVIS_INSTRUCTIONS } from '../core/personality.js';
const setup = () => { const store = new FakeMemoryStore(); const service = new MemoryService(store); const registry = new ToolRegistry(); registry.add(new MemoryAdapter(service)); return { store, service, registry, executor: new ToolExecutor(registry) }; };
const input = (evidence = '¿Podrías guardar que tus respuestas sean lo más cortas posible?') => ({ preference: { responseLength: 'minimal' }, evidence });
async function approve(f: ReturnType<typeof setup>, id: string, evidence?: string) { const p = await f.executor.invoke(id, 'memory.remember', input(evidence)); assert.equal(p.status, 'pending'); if (p.status !== 'pending') throw new Error(); assert.equal((await f.executor.decide(p.confirmationId, true)).status, 'success'); return p; }
test('direct preference needs no personal ID, is local, frozen and confirmed exactly once', async () => {
  const f = setup(); const previous = globalThis.fetch; globalThis.fetch = async () => { throw new Error('network must not be used'); };
  try {
    const p = await approve(f, 'first'); const record = f.store.records[0]!;
    assert.equal(record.type, 'PREFERENCE'); assert.equal(record.subject.name, 'User'); assert.match(record.subject.id, /^entity-[a-f0-9]{24}$/); assert.equal(record.value.response_length, 'minimal'); assert.equal(record.source.kind, 'explicit_user');
    assert.equal((await f.executor.decide(p.confirmationId, true)).status, 'error'); assert.equal(f.store.records.length, 1);
    assert.equal((await f.executor.invoke('read', 'memory.search', { query: 'User' })).status, 'success');
  } finally { globalThis.fetch = previous; f.executor.close(); }
});
test('equivalent preference deduplicates; newer explicit preference supersedes existing style and preserves other settings', async () => {
  const f = setup(); try {
    const old = await f.service.remember({ ...responsePreference({ responseLength: 'short' }), key: 'response_style', value: { response_length: 'short', tone: 'calm' } }, source('Brief answers', 'explicit_user', Date.now() - 1000));
    await approve(f, 'new'); const current = f.store.records.find(r => r.status === 'current')!;
    assert.equal(current.supersedes, old!.id); assert.equal(current.key, 'response_style'); assert.equal(current.value.tone, 'calm'); assert.equal(current.value.response_length, 'minimal');
    assert.equal(f.store.records.find(r => r.id === old!.id)!.supersededBy, current.id);
    await approve(f, 'equivalent', 'Remember that I prefer the shortest possible answers.');
    assert.equal(f.store.records.length, 2); assert.equal(f.store.records.find(r => r.status === 'current')!.id, current.id);
    await f.service.remember({ ...responsePreference({ responseLength: 'detailed' }), key: 'response_style' }, source('Inferred preference', 'conversation_inference'));
    assert.equal(f.store.records.find(r => r.status === 'current')!.value.response_length, 'minimal');
  } finally { f.executor.close(); }
});
test('malformed, rejected and stale preferences never mutate; concurrent changes invalidate frozen proposal', async () => {
  const f = setup(); try {
    for (const preference of [{ responseLength: 'anything' }, { responseLength: 42 }, { responseLength: 'minimal', subject: 'personal' }]) {
      assert.equal((await f.executor.invoke(randomUUID(), 'memory.remember', { preference, evidence: 'brief' })).status, 'error');
    }
    const p = await f.executor.invoke('reject', 'memory.remember', input()); if (p.status !== 'pending') throw new Error();
    await f.executor.decide(p.confirmationId, false); assert.equal(f.store.records.length, 0);
    const stale = await f.executor.invoke('stale', 'memory.remember', input()); if (stale.status !== 'pending') throw new Error();
    await f.service.remember(responsePreference({ responseLength: 'short' }), source('A concurrent preference'));
    const result = await f.executor.decide(stale.confirmationId, true); assert.equal(result.status, 'error'); if (result.status === 'error') assert.equal(result.category, 'CONFLICT');
    assert.equal(f.store.records.length, 1); assert.equal(f.store.records[0]!.value.response_length, 'short');
  } finally { f.executor.close(); }
});
test('generated entity hash resembling IBAN is metadata; actual credentials remain blocked', async () => {
  let synthetic = ''; for (let i = 0; i < 10_000; i++) { const id = 'generic-user-' + i; const hash = createHash('sha256').update(normalize(id)).digest('hex').slice(0, 24); if (/^[a-f]{2}\d{2}/.test(hash)) { synthetic = id; break; } }
  assert.ok(synthetic); const file = resolve('.local', 'memory-tests', randomUUID(), 'memories.json');
  const entries: MemoryDiagnostic[] = []; const diagnostics = new MemoryDiagnostics(true, e => entries.push(e));
  try {
    const store = new PrivateJsonMemoryStore(file, undefined, diagnostics); const service = new MemoryService(store);
    const record = await service.remember(candidate('Prefers short responses.', { type: 'PREFERENCE', subject: { id: synthetic, name: 'User', aliases: [] }, key: 'response_length', value: { response_length: 'short' } }), source('Keep answers short.'));
    assert.equal(containsSecret([record]), true); assert.equal(containsMemorySecrets([record!]), false);
    assert.equal((await store.read()).length, 1);
    const iban = 'ES9121000418450200051332';
    for (const patch of [{ content: iban }, { value: { reference: iban } }, { subject: { id: iban, name: 'User', aliases: [] } }]) await assert.rejects(service.remember(candidate('Safe', patch), source('Safe')));
    await assert.rejects(service.remember(candidate(), source(iban))); assert.equal((await store.read()).length, 1);
    assert.equal(entries.length, 0);
    await assert.rejects(store.transaction(rows => { rows[0]!.value.reference = iban; }));
    assert.ok(entries.some(e => e.field === 'value.*' && e.rule === 'secret_filter'));
    assert.ok(!JSON.stringify(entries).includes(iban));
    assert.equal((await store.read())[0]!.value.reference, undefined);
  } finally { await rm(dirname(file), { recursive: true, force: true }); }
});
test('validation diagnostics expose static field/rule only; instructions prohibit invented ID requirements', async () => {
  const entries: MemoryDiagnostic[] = []; const d = new MemoryDiagnostics(true, e => entries.push(e), true);
  await assert.rejects(d.run('remember', 'validation', async () => { throw new MemoryValidationError(validationField(['candidate', 'value', 'private-name']), 'schema'); }));
  assert.equal(entries[0]!.field, 'value.*'); assert.equal(entries[0]!.rule, 'schema'); assert.ok(!JSON.stringify(entries).includes('private-name'));
  await d.run('read', 'security', async () => {}); assert.equal(entries[1]!.code, 'OK');
  assert.match(JARVIS_INSTRUCTIONS, /INVALID_INPUT/); assert.match(JARVIS_INSTRUCTIONS, /no.*nombre.*ID/i);
});

test('expired current-user preference confirmation never executes', async () => {
  const f = setup(); let now = Date.now(); const executor = new ToolExecutor(f.registry, () => now);
  try {
    const pending = await executor.invoke('expire', 'memory.remember', input()); if (pending.status !== 'pending') throw new Error();
    now += 60_001; assert.equal((await executor.decide(pending.confirmationId, true)).status, 'error'); assert.equal(f.store.records.length, 0);
  } finally { executor.close(); f.executor.close(); }
});
