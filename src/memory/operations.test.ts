import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { rm, readFile, writeFile, lstat } from 'node:fs/promises';
import { TokenFileSecurity } from '../tools/adapters/token-security.js';
import { PrivateJsonMemoryStore } from './store.js';
import { MemoryService } from './service.js';
import { MemoryAdapter } from './adapter.js';
import { ToolRegistry } from '../tools/registry.js';
import { ToolExecutor } from '../tools/execution.js';
import { candidate, source } from './test-fixtures.js';
import { MemoryDiagnostics } from '../diagnostics/memory.js';
import type { MemoryDiagnostic } from '../diagnostics/memory.js';
import { ToolError } from '../tools/types.js';
function windowsSecurity(delay = 30) {
  const batches: string[][] = []; let singles = 0;
  const security = new TokenFileSecurity('win32', async () => { singles++; await new Promise(resolve => setTimeout(resolve, delay)); }, async (requests, signal) => {
    batches.push(requests.map(r => r.path));
    await new Promise(resolve => setTimeout(resolve, delay)); signal?.throwIfAborted();
  });
  return { security, batches, singles: () => singles };
}
async function fixture(delay = 30, diagnostics = new MemoryDiagnostics()) {
  const file = resolve('.local', 'memory-tests', randomUUID(), 'memories.json');
  await new PrivateJsonMemoryStore(file).read();
  const win = windowsSecurity(delay); const store = new PrivateJsonMemoryStore(file, win.security, diagnostics); const service = new MemoryService(store);
  const original = await service.remember(candidate(), source());
  const registry = new ToolRegistry(); registry.add(new MemoryAdapter(service, 3000, diagnostics));
  // Scaled timing budget: OS helper startup per batch is simulated, not mocked
  // away. A multi-process read/metadata-write path exceeds this budget.
  for (const t of registry.descriptors()) registry.resolve(t.id)!.timeoutMs = 400;
  const executor = new ToolExecutor(registry);
  return { file, store, service, original: original!, win, executor, close: async () => { executor.close(); await rm(dirname(file), { recursive: true, force: true }); } };
}
test('Windows-style helper latency: search/get each audit once, never take a write lock or contact extraction', { timeout: 10000 }, async () => {
  const f = await fixture(40); const prior = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('No external request allowed'); };
  try {
    const snapshot = await readFile(f.file, 'utf8'); const baseline = f.win.batches.length;
    // A foreign lock must not prevent safe atomic snapshot reads.
    await writeFile(f.file + '.lock', '', { mode: 0o600 });
    const search = await f.executor.invoke('search', 'memory.search', { query: 'Frekuent' }); assert.equal(search.status, 'success');
    assert.equal(f.win.batches.length - baseline, 1);
    assert.ok(f.win.batches.at(-1)!.includes(f.file));
    assert.ok(f.win.batches.at(-1)!.includes(dirname(f.file)));
    assert.ok(f.win.batches.at(-1)!.includes(resolve('.local')));
    const get = await f.executor.invoke('get', 'memory.get', { id: f.original.id }); assert.equal(get.status, 'success');
    assert.equal(f.win.batches.length - baseline, 2); assert.equal(f.win.singles(), 0);
    const contextual = await f.service.contextualSearch('What is pending with that?', 5, [f.original.id, f.original.id]);
    assert.equal(contextual.length, 1); assert.equal(f.win.batches.length - baseline, 3);
    assert.equal(await readFile(f.file, 'utf8'), snapshot); await rm(f.file + '.lock');
  } finally { globalThis.fetch = prior; await f.close(); }
});
test('direct preference remember, duplicate checks, update/forget preparation and literal correction are bounded local operations', { timeout: 10000 }, async () => {
  const f = await fixture(); const prior = globalThis.fetch; globalThis.fetch = async () => { throw new Error('No extraction/network allowed'); };
  try {
    const preference = candidate('Keep responses short.', { type: 'PREFERENCE', subject: { id: 'user', name: 'User', aliases: [] }, key: 'response_length' });
    const saved = await f.executor.invoke('preference', 'memory.remember', { candidate: preference, evidence: 'Keep responses short.' }); assert.equal(saved.status, 'success');
    assert.equal((await f.executor.invoke('duplicate', 'memory.remember', { candidate: preference, evidence: 'Keep responses short.' })).status, 'success');
    assert.equal((await f.store.read()).filter(r => r.key === 'response_length').length, 1);
    const platform = await f.service.remember(candidate('Platform is onavox.ai.', { key: 'platform', value: { platform: 'onavox.ai' } }), source('Platform is onavox.ai.'));
    const correction = await f.executor.invoke('correct', 'memory.update', { target: { id: platform!.id }, candidate: candidate('Platform is Onabox.ai.', { key: 'platform', value: { platform: 'Onabox.ai' } }), evidence: 'O-N-A-B-O-X.ai' });
    if (correction.status !== 'pending') throw new Error(JSON.stringify(correction));
    assert.equal((await f.executor.decide(correction.confirmationId, true)).status, 'success');
    assert.equal((await f.store.read()).find(r => r.status === 'current' && r.key === 'platform')!.value.platform, 'Onabox.ai');
    const forget = await f.executor.invoke('forget', 'memory.forget', { id: f.original.id }); assert.equal(forget.status, 'pending');
    if (forget.status === 'pending') await f.executor.decide(forget.confirmationId, false);
    assert.equal(f.win.singles(), 0);
  } finally { globalThis.fetch = prior; await f.close(); }
});
test('concurrent instances keep atomic writes and nonblocking readers; transactions cannot await recursive store operations', { timeout: 10000 }, async () => {
  const f = await fixture(); try {
    const other = new MemoryService(new PrivateJsonMemoryStore(f.file, f.win.security));
    const reads = Array.from({ length: 5 }, () => f.service.search('Frekuent'));
    await Promise.all([...reads, f.service.remember(candidate('First', { key: 'one' }), source('First')), other.remember(candidate('Second', { key: 'two' }), source('Second'))]);
    assert.equal((await f.store.read()).length, 3);
    await assert.rejects(f.store.transaction(() => f.store.read()), /INVALID_INPUT/);
    assert.equal((await f.store.read()).length, 3);
    await assert.rejects(lstat(f.file + '.lock'));
  } finally { await f.close(); }
});
test('aborted queued or security-stage writes never commit late and safely release the lock', { timeout: 10000 }, async () => {
  const diagnostics: MemoryDiagnostic[] = []; const f = await fixture(40, new MemoryDiagnostics(true, row => diagnostics.push(row))); try {
    const baseline = await readFile(f.file, 'utf8');
    const controller = new AbortController(); const pending = f.service.remember(candidate('Cancelled', { key: 'cancelled' }), source('Cancelled'), undefined, undefined, controller.signal);
    setTimeout(() => controller.abort(), 15); await assert.rejects(pending, /TIMEOUT/);
    assert.equal(await readFile(f.file, 'utf8'), baseline); await assert.rejects(lstat(f.file + '.lock'));
    assert.ok(diagnostics.some(row => row.code === 'TIMEOUT' && row.stage === 'security'));
    const first = f.service.remember(candidate('Valid', { key: 'valid' }), source('Valid'));
    const queued = new AbortController(); const second = f.service.remember(candidate('Queued', { key: 'queued' }), source('Queued'), undefined, undefined, queued.signal); queued.abort();
    await assert.rejects(second, /TIMEOUT/); await first;
    assert.ok(!(await f.store.read()).some(r => ['cancelled', 'queued'].includes(r.key)));
  } finally { await f.close(); }
});
test('development diagnostics whitelist safe operation/stage/code/duration; production is silent and sinks cannot fail execution', async () => {
  const entries: MemoryDiagnostic[] = []; const d = new MemoryDiagnostics(true, row => entries.push(row));
  await assert.rejects(d.run('search', 'lookup', async () => { throw Object.assign(new Error('private email token path data'), { code: 'PRIVATE_SECRET' }); }));
  assert.deepEqual(Object.keys(entries[0]!).sort(), ['code', 'elapsedMs', 'operation', 'stage']); assert.equal(entries[0]!.code, 'UPSTREAM'); assert.ok(entries[0]!.elapsedMs >= 0);
  assert.ok(!JSON.stringify(entries).includes('private')); const count = entries.length;
  await assert.rejects(new MemoryDiagnostics(false, row => entries.push(row)).run('get', 'lookup', async () => { throw new ToolError('UNCONFIGURED'); })); assert.equal(entries.length, count);
  await assert.rejects(new MemoryDiagnostics(true, () => { throw new Error('sink'); }).run('get', 'lookup', async () => { throw new ToolError('UNCONFIGURED'); }), /UNCONFIGURED/);
});
