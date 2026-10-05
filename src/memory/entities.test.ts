import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryService } from './service.js';
import { MemoryAdapter } from './adapter.js';
import { ToolExecutor } from '../tools/execution.js';
import { ToolRegistry } from '../tools/registry.js';
import { candidate, source, FakeMemoryStore } from './test-fixtures.js';
import { literalIdentifiers } from './spelling.js';
import { JARVIS_MEMORY_INSTRUCTIONS, JARVIS_TOOL_INSTRUCTIONS } from '../core/personality.js';
function fixture() {
  const store = new FakeMemoryStore(); const service = new MemoryService(store); const registry = new ToolRegistry(); registry.add(new MemoryAdapter(service));
  return { store, service, executor: new ToolExecutor(registry) };
}
const project = (name: string) => candidate(`${name} is a project.`, { type: 'PROJECT', subject: { id: name, name, aliases: [] }, key: 'project_scope' });
test('voice boundary variants resolve canonical AIbound in standalone and conversational queries without new entities', async () => {
  const f = fixture(); try {
    const original = await f.service.remember(project('AIbound'), source('AIbound is a project.'));
    for (const name of ['AI-bound', 'AI Bound', 'aibound', 'AI--bound']) {
      assert.equal(await f.service.resolve(name), original!.subject.id);
      assert.equal((await f.service.search(`What do you know about ${name}?`))[0]!.subject.id, original!.subject.id);
      const record = await f.service.remember(project(name), source(`${name} is a project.`));
      assert.equal(record!.subject.id, original!.subject.id); assert.equal(record!.subject.name, 'AIbound');
    }
    assert.equal(new Set(f.store.records.map(r => r.subject.id)).size, 1);
  } finally { f.executor.close(); }
});
test('AI-Bomb and AI Bond only suggest canonical names and cannot automatically create or mutate a near entity', async () => {
  const f = fixture(); try {
    await f.service.remember(project('AIbound'), source());
    for (const name of ['AI-Bomb', 'AI Bond']) {
      assert.equal(await f.service.resolve(name), null);
      const result = await f.executor.invoke(name, 'memory.search', { query: `What do you remember about ${name}?` });
      assert.equal(result.status, 'success'); if (result.status !== 'success') throw new Error();
      assert.deepEqual((result.data as { candidates: string[] }).candidates, ['AIbound']);
      assert.equal((result.data as { clarificationRequired: boolean }).clarificationRequired, true);
      await assert.rejects(f.service.remember(project(name), source()), /AMBIGUOUS/);
      assert.equal(f.store.records.length, 1);
    }
    assert.deepEqual(await f.service.suggestions('entirely unrelated topic'), []);
    const forgotten = await f.executor.invoke('unsafe', 'memory.forget', { query: 'AI-Bomb' }); assert.equal(forgotten.status, 'error');
  } finally { f.executor.close(); }
});
test('preexisting duplicate boundary aliases and multiple near candidates require clarification', async () => {
  const f = fixture(); try {
    const record = await f.service.remember(project('AIbound'), source());
    f.store.records.push({ ...structuredClone(record!), id: crypto.randomUUID(), subject: { id: 'separate', name: 'AI Bound', aliases: [] } });
    await assert.rejects(f.service.resolve('AI-bound'), /AMBIGUOUS/);
    await assert.rejects(f.service.search('AI Bound'), /AMBIGUOUS/);
    await assert.rejects(f.service.remember(project('AI-bound'), source()), /AMBIGUOUS/);
    assert.equal((await f.service.suggestions('AI-Bomb')).length, 2);
  } finally { f.executor.close(); }
});
test('explicit domain spelling is literal; no B/V substitution, including hyphen-spelled letters', async () => {
  assert.deepEqual(literalIdentifiers('Es Onabox.ai'), ['Onabox.ai']);
  assert.deepEqual(literalIdentifiers('O-N-A-B-O-X.ai'), ['Onabox.ai']);
  assert.deepEqual(literalIdentifiers('sofia@example.com'), []);
  const f = fixture(); try {
    const old = await f.service.remember(candidate('Platform is onavox.ai.', { key: 'platform', value: { platform: 'onavox.ai' } }), source('Platform is onavox.ai.'));
    for (const [index, evidence] of ['Onabox.ai', 'O-N-A-B-O-X.ai'].entries()) {
      const wrong = candidate('Platform is onavox.ai.', { key: 'platform', value: { platform: 'onavox.ai' } });
      const rejected = await f.executor.invoke('bad' + index, 'memory.update', { target: { id: old!.id }, candidate: wrong, evidence });
      assert.equal(rejected.status, 'error'); assert.equal(f.executor.pendingState(), null); assert.equal(f.store.records.length, 1);
    }
    const corrected = candidate('Platform is Onabox.ai.', { key: 'platform', value: { platform: 'Onabox.ai' } });
    const prepared = await f.executor.invoke('good', 'memory.update', { target: { id: old!.id }, candidate: corrected, evidence: 'O-N-A-B-O-X.ai' });
    assert.equal(prepared.status, 'pending'); if (prepared.status !== 'pending') throw new Error();
    assert.ok(prepared.summary.includes('Onabox.ai')); assert.equal(f.store.records[0]!.value.platform, 'onavox.ai');
    corrected.value.platform = 'tampered.ai'; // external caller mutation cannot alter frozen payload
    assert.equal((await f.executor.decide(prepared.confirmationId, true)).status, 'success');
    const current = f.store.records.find(r => r.status === 'current')!; assert.equal(current.value.platform, 'Onabox.ai'); assert.equal(current.source.evidence, 'O-N-A-B-O-X.ai');
    assert.equal(current.supersedes, old!.id);
  } finally { f.executor.close(); }
});
test('a literal spelling correction can rename the exact frozen entity without changing its identity', async () => {
  const f = fixture(); try {
    const old = await f.service.remember(project('onavox.ai'), source('onavox.ai is a project.'));
    const prepared = await f.executor.invoke('rename', 'memory.update', { target: { id: old!.id }, candidate: project('Onabox.ai'), evidence: 'O-N-A-B-O-X.ai' });
    if (prepared.status !== 'pending') throw new Error(JSON.stringify(prepared));
    assert.equal((await f.executor.decide(prepared.confirmationId, true)).status, 'success');
    const updated = f.store.records.find(r => r.status === 'current')!; assert.equal(updated.subject.name, 'Onabox.ai'); assert.equal(updated.subject.id, old!.subject.id);
  } finally { f.executor.close(); }
});
test('memory-first contextual continuity and explicit current-information search coexist in central instructions', () => {
  for (const clause of ['objetivo activo', 'continuidad de esa tarea', 'explícitamente Internet', 'clarificationRequired', 'evidencia literal', 'valor exacto congelado']) assert.ok(JARVIS_MEMORY_INSTRUCTIONS.includes(clause));
  assert.ok(JARVIS_TOOL_INSTRUCTIONS.includes('Para información actual usa web.search'));
});
test('literal identifiers in ordinary sentence punctuation remain valid, including more than one domain', async () => {
  const f = fixture(); try {
    const saved = await f.service.remember(candidate('We use Onabox.ai.', { value: {} }), source('Onabox.ai'));
    assert.ok(saved);
    assert.ok(await f.service.remember(candidate('We use Onabox.ai and Example.ai.', { key: 'other_platforms', value: { first: 'Onabox.ai', second: 'Example.ai' } }), source('Onabox.ai and Example.ai')));
    assert.ok(await f.service.remember(candidate('The platform is Onabox.', { key: 'proper_noun', value: { platform: 'Onabox' } }), source('O-N-A-B-O-X')));
  } finally { f.executor.close(); }
});
