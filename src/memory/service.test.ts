import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryService } from './service.js';
import { candidate, source, FakeMemoryStore } from './test-fixtures.js';
import { ToolRegistry } from '../tools/registry.js';
import { ToolExecutor } from '../tools/execution.js';
import { MemoryAdapter } from './adapter.js';
import { containsSecret } from './privacy.js';
const setup = () => { let now = Date.now(); const store = new FakeMemoryStore(); const service = new MemoryService(store, () => now); return { store, service, tick: (ms = 1000) => { now += ms; }, now: () => now }; };

test('explicit memory is structured with stable entities, UTC timestamps, provenance and relationships', async () => {
  const f = setup(); const record = await f.service.remember(candidate('My partner is Sofia.', { type: 'PERSON', subject: { id: 'user', name: 'User', aliases: [] }, key: 'partner', relationships: [{ predicate: 'partner', target: { id: 'sofia', name: 'Sofia', aliases: [] } }] }), source('My partner is Sofia.'));
  assert.equal(record!.source.kind, 'explicit_user'); assert.equal(record!.status, 'current'); assert.match(record!.id, /^[a-f0-9-]{36}$/); assert.ok(record!.createdAt.endsWith('Z'));
  assert.equal((await f.service.search('What do you know about Sofia?'))[0]!.relationships[0]!.predicate, 'partner');
  assert.equal((await f.service.search('What is Sofia email?'))[0]!.value.email, undefined);
});
test('mentions deduplicate; explicit corrections supersede history; lower-authority inferences cannot overwrite', async () => {
  const f = setup(); const old = await f.service.remember(candidate('Delivery October 20', { key: 'delivery' }), source('Delivery October 20', 'explicit_user', f.now()));
  f.tick(); const repeated = await f.service.remember(candidate('Delivery October 20', { key: 'delivery' }), source('The delivery remains October 20', 'explicit_user', f.now()));
  assert.equal(old!.id, repeated!.id); assert.equal(f.store.records.length, 1); assert.equal(repeated!.corroborations, 2);
  f.tick(); await f.service.remember(candidate('Delivery October 26', { key: 'delivery', confidence: 1 }), source('inference', 'conversation_inference', f.now()));
  assert.equal((await f.service.search('Frekuent delivery'))[0]!.content, 'Delivery October 20');
  f.tick(); const corrected = await f.service.remember(candidate('Delivery October 25', { key: 'delivery' }), source('It moved to October 25', 'explicit_user', f.now()));
  assert.equal(corrected!.supersedes, old!.id); assert.equal(f.store.records[0]!.status, 'superseded'); assert.equal((await f.service.search('Frekuent delivery')).length, 1);
  assert.ok(!f.service.context(f.store.records).includes('October 20')); assert.ok(f.service.context(f.store.records).includes('October 25'));
});
test('older explicit statements cannot override newer explicit facts; low-confidence guesses are discarded', async () => {
  const f = setup(); await f.service.remember(candidate('Current fact'), source('Current fact', 'explicit_user', f.now()));
  await f.service.remember(candidate('Older fact'), source('Older fact', 'explicit_user', f.now() - 5000));
  assert.equal(f.store.records[0]!.content, 'Current fact');
  assert.equal(await f.service.remember(candidate('Guess', { subject: { id: 'new', name: 'New', aliases: [] }, confidence: 0.4 }), source('Guess', 'conversation_inference')), null);
});
test('temporary facts expire without refresh from access and require explicit TTL', async () => {
  const f = setup(); await assert.rejects(f.service.remember(candidate('Focus this week', { type: 'TEMPORARY' }), source()));
  const record = await f.service.remember(candidate('Focus this week', { type: 'TEMPORARY', expiresAt: new Date(f.now() + 2000).toISOString() }), source());
  assert.equal((await f.service.search('Frekuent')).length, 1); f.tick(2001);
  assert.equal((await f.service.search('Frekuent')).length, 0); assert.equal(f.service.context([record!]), ''); await assert.rejects(f.service.get(record!.id));
});
test('retrieval combines entity, importance, confidence, recency and bounded relevant content', async () => {
  const f = setup(); await f.service.remember(candidate(), source());
  await f.service.remember(candidate('Other organization', { subject: { id: 'other', name: 'Other', aliases: [] } }), source('Other organization'));
  for (let i = 0; i < 9; i++) { f.tick(); await f.service.remember(candidate(`Portugal project ${i}`, { key: 'project-' + i, importance: i / 10 }), source('Portugal ' + i, 'explicit_user', f.now())); }
  const found = await f.service.search('What are we doing with Frekuent?', 5); assert.equal(found.length, 5); assert.ok(found.every(r => r.subject.name === 'Frekuent'));
  assert.ok(found[0]!.lastAccessedAt); // Reads update metadata in memory, not the write queue.
  assert.ok(f.store.records.every(r => r.lastAccessedAt === null));
  await f.service.remember(candidate('Later fact', { key: 'later' }), source('Later fact'));
  assert.ok(f.store.records.some(r => r.lastAccessedAt)); const context = f.service.context(found, 750); assert.ok(context.length <= 750); assert.ok(!context.includes('Other organization'));
});
test('two same-name people do not resolve or mutate ambiguously', async () => {
  const f = setup(); for (const id of ['sofia-org-a', 'sofia-org-b']) await f.service.remember(candidate('Known person', { type: 'PERSON', subject: { id, name: 'Sofia', aliases: [] } }), source('Sofia ' + id));
  await assert.rejects(f.service.resolve('Sofia')); await assert.rejects(f.service.search('Email Sofia'));
  const registry = new ToolRegistry(); registry.add(new MemoryAdapter(f.service)); const executor = new ToolExecutor(registry);
  try { const result = await executor.invoke('forget', 'memory.forget', { query: 'Sofia' }); assert.equal(result.status, 'error'); if (result.status === 'error') assert.equal(result.category, 'AMBIGUOUS'); assert.equal(f.store.records.length, 2); } finally { executor.close(); }
});
test('memory tools share permissions, confirmation, telemetry, exact deletion and error normalization', async () => {
  const f = setup(); const registry = new ToolRegistry(); registry.add(new MemoryAdapter(f.service)); const executor = new ToolExecutor(registry);
  try {
    const saved = await executor.invoke('remember', 'memory.remember', { candidate: candidate(), evidence: 'Frekuent is a client.' }); assert.equal(saved.status, 'success');
    const id = f.store.records[0]!.id;
    assert.equal((await executor.invoke('get', 'memory.get', { id })).status, 'success');
    const pending = await executor.invoke('delete', 'memory.forget', { id }); assert.equal(pending.status, 'pending'); assert.equal(f.store.records.length, 1); if (pending.status !== 'pending') throw new Error();
    assert.equal((await executor.decide(pending.confirmationId, false)).status, 'error'); assert.equal(f.store.records.length, 1);
    const again = await executor.invoke('delete2', 'memory.forget', { id }); if (again.status !== 'pending') throw new Error();
    assert.equal((await executor.decide(again.confirmationId, true)).status, 'success'); assert.equal(f.store.records.length, 0); assert.equal((await executor.decide(again.confirmationId, true)).status, 'error');
    assert.ok(!JSON.stringify(executor.telemetry.snapshot()).includes('Frekuent'));
    f.store.failure = true; const failure = await executor.invoke('failed', 'memory.search', { query: 'Frekuent' }); assert.equal(failure.status, 'error'); assert.ok(!JSON.stringify(failure).includes('private path'));
  } finally { executor.close(); }
});
test('forgetting removes superseded lineage and prepared deletion fails if the fact changed', async () => {
  const f = setup(); const original = await f.service.remember(candidate('Old'), source('Old', 'explicit_user', f.now())); f.tick(); const latest = await f.service.remember(candidate('New'), source('New', 'explicit_user', f.now()));
  await assert.rejects(f.service.forget(original!.id, original!.updatedAt)); await f.service.forget(latest!.id, latest!.updatedAt); assert.equal(f.store.records.length, 0);
});
for (const secret of ['password is hunter2', 'mi contraseña es privada', 'API key: sk-proj-abcdefghijklmnopqrstuv', 'Bearer opaque-token', 'refresh_token=private', 'authentication code 123456', '4111 1111 1111 1111', '-----BEGIN PRIVATE KEY-----', 'security answer: name', 'ES9121000418450200051332']) {
  test(`deterministic secret filter blocks ${secret.split(' ')[0]} without storing it`, async () => { const f = setup(); assert.equal(containsSecret(secret), true); await assert.rejects(f.service.remember(candidate(secret), source(secret))); assert.equal(f.store.records.length, 0); });
}

test('approved update supersedes the exact prepared fact; fuzzy deletion cannot mutate', async () => {
  const f = setup(); const record = await f.service.remember(candidate('October 20', { key: 'delivery' }), source('October 20'));
  const registry = new ToolRegistry(); registry.add(new MemoryAdapter(f.service)); const executor = new ToolExecutor(registry);
  try {
    const fuzzy = await executor.invoke('fuzzy', 'memory.forget', { query: 'Freku' }); assert.equal(fuzzy.status, 'error'); assert.equal(f.store.records.length, 1);
    const prepared = await executor.invoke('update', 'memory.update', { target: { id: record!.id }, candidate: candidate('October 25', { key: 'delivery' }) }); assert.equal(prepared.status, 'pending'); assert.equal(f.store.records[0]!.content, 'October 20'); if (prepared.status !== 'pending') throw new Error();
    const result = await executor.decide(prepared.confirmationId, true); assert.equal(result.status, 'success'); assert.equal((await f.service.search('Frekuent delivery'))[0]!.content, 'October 25');
  } finally { executor.close(); }
});

test('bounded backend maintenance does not consume foreground budget or bypass/invalidate SENSITIVE confirmation', async () => {
  const registry = new ToolRegistry();
  registry.register({ id: 'read', name: 'Read', description: 'Read', integration: 'test', capability: 'read', permission: 'READ', schema: (await import('zod')).z.object({}), execute: async () => ({ ok: true }) });
  let mutations = 0; registry.register({ id: 'sensitive', name: 'Sensitive', description: 'Sensitive', integration: 'test', capability: 'write', permission: 'SENSITIVE', schema: (await import('zod')).z.object({}), execute: async () => { mutations++; return {}; } });
  const executor = new ToolExecutor(registry);
  try {
    for (let i = 0; i < 105; i++) assert.equal((await executor.invoke('bg' + i, 'read', {}, { background: true })).status, 'success');
    assert.equal((await executor.invoke('blocked', 'sensitive', {}, { background: true })).status, 'error');
    const pending = await executor.invoke('fg', 'sensitive', {}); if (pending.status !== 'pending') throw new Error();
    const blocked = await executor.invoke('during-pending', 'read', {}, { background: true }); assert.equal(blocked.status, 'error'); assert.equal(executor.pendingState()!.confirmationId, pending.confirmationId); assert.equal(mutations, 0);
    await executor.decide(pending.confirmationId, true); assert.equal(mutations, 1);
    for (let i = 0; i < 99; i++) assert.equal((await executor.invoke('fg' + i, 'read', {})).status, 'success');
    assert.equal((await executor.invoke('fg-limit', 'read', {})).status, 'error');
  } finally { executor.close(); }
});

test('uncertain/expired memories remain inspectable and deletable but cannot enter current context', async () => {
  const f = setup(); const record = await f.service.remember(candidate('Uncertain dated fact', { confidence: 0.5, expiresAt: new Date(f.now() + 1000).toISOString() }), source('Uncertain dated fact'));
  assert.equal((await f.service.search('Frekuent')).length, 0); assert.equal((await f.service.search('Frekuent', 5, { uncertain: true })).length, 1);
  f.tick(1001); const inspection = await f.service.search('Frekuent', 5, { uncertain: true, expired: true }); assert.equal(inspection.length, 1); assert.equal(f.service.context(inspection), '');
  await f.service.forget(record!.id, record!.updatedAt); assert.equal(f.store.records.length, 0);
});

test('forgetting wins over automatic ingestion already waiting to enter its storage transaction', async () => {
  const f = setup(); const record = await f.service.remember(candidate(), source());
  const generation = f.service.mutationGeneration; let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const start = new Promise<void>(resolve => { started = resolve; });
  const transaction = f.store.transaction.bind(f.store); let pause = true;
  f.store.transaction = async change => { if (pause) { pause = false; started(); await gate; } return transaction(change); };
  const delayed = f.service.remember(candidate(), source(), undefined, generation); await start;
  await f.service.forget(record!.id, record!.updatedAt); release(); await assert.rejects(delayed); assert.equal(f.store.records.length, 0);
});

test('explicit entity forgetting freezes exact related records, preserves unrelated facts and is all-or-nothing', async () => {
  const f = setup(); const sofia = await f.service.remember(candidate('Sofia is my partner.', { type: 'PERSON', subject: { id: 'sofia', name: 'Sofia', aliases: [] } }), source('Sofia is my partner.'));
  await f.service.remember(candidate('My partner is Sofia.', { type: 'USER_PROFILE', subject: { id: 'user', name: 'User', aliases: [] }, key: 'partner', relationships: [{ predicate: 'partner', target: { id: 'sofia', name: 'Sofia', aliases: [] } }] }), source('My partner is Sofia.'));
  await f.service.remember(candidate(), source());
  const registry = new ToolRegistry(); registry.add(new MemoryAdapter(f.service)); const executor = new ToolExecutor(registry);
  try {
    const prepared = await executor.invoke('entity', 'memory.forget', { query: 'Sofia', scope: 'entity' }); if (prepared.status !== 'pending') throw new Error(); assert.equal(f.store.records.length, 3); assert.ok(prepared.summary.includes('2 recuerdos'));
    assert.equal((await executor.decide(prepared.confirmationId, true)).status, 'success'); assert.equal(f.store.records.length, 1); assert.equal(f.store.records[0]!.subject.name, 'Frekuent');
    await assert.rejects(f.service.entityDeletion('Freku')); // no fuzzy deletion
    await assert.rejects(f.service.forgetMany([{ id: f.store.records[0]!.id, updatedAt: f.store.records[0]!.updatedAt }, { id: sofia!.id, updatedAt: sofia!.updatedAt }])); assert.equal(f.store.records.length, 1);
  } finally { executor.close(); }
});
