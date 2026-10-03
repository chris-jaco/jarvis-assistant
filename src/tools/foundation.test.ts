import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ToolRegistry } from './registry.js';
import { ToolExecutor } from './execution.js';
import { requiresConfirmation } from './permissions.js';
import type { ToolDefinition, Permission } from './types.js';
import { ToolError } from './types.js';
function fixture(permission: Permission = 'READ', confirm?: boolean, execute?: ToolDefinition['execute']) {
  let count = 0; const registry = new ToolRegistry();
  const definition: ToolDefinition = { id: 'test.action', name: 'Test action', description: 'Test', integration: 'test', capability: 'test', permission, confirm,
    schema: z.object({ value: z.string() }).strict(), execute: execute ?? (async () => { count++; return { done: true }; }) };
  registry.register(definition); return { registry, definition, count: () => count, executor: new ToolExecutor(registry) };
}
const input = { value: 'private' };
test('registry resolves, rejects duplicates and exposes schema without execution handlers', () => {
  const f = fixture(); assert.equal(f.registry.resolve('test.action'), f.definition); assert.equal(f.registry.resolve('missing'), undefined);
  assert.throws(() => f.registry.register(f.definition)); assert.throws(() => f.registry.register({ ...f.definition, id: 'test_action' })); assert.throws(() => f.registry.register({ ...f.definition, id: 'bad id' }));
  const descriptor = f.registry.descriptors()[0]!; assert.equal(descriptor.integration, 'test'); assert.ok(descriptor.inputSchema); assert.ok(!('execute' in descriptor));
});
test('permission policy cannot disable SENSITIVE approval; WRITE configurable and default safe', () => {
  assert.equal(requiresConfirmation({ permission: 'READ', confirm: true }), false);
  assert.equal(requiresConfirmation({ permission: 'WRITE' }), true);
  assert.equal(requiresConfirmation({ permission: 'WRITE', confirm: false }), false);
  assert.equal(requiresConfirmation({ permission: 'SENSITIVE', confirm: false }), true);
});
test('READ and opted-out WRITE execute without confirmation', async () => {
  for (const permission of ['READ', 'WRITE'] as const) { const f = fixture(permission, false); assert.equal((await f.executor.invoke('1', 'test.action', input)).status, 'success'); assert.equal(f.count(), 1); }
});
for (const permission of ['WRITE', 'SENSITIVE'] as const) {
  test(`${permission} pauses; approval is consumed atomically and executes exactly once`, async () => {
    const f = fixture(permission, permission === 'SENSITIVE' ? false : true);
    const result = await f.executor.invoke('1', 'test.action', input); assert.equal(f.count(), 0); assert.equal(result.status, 'pending');
    if (result.status !== 'pending') throw new Error();
    const decisions = await Promise.all([f.executor.decide(result.confirmationId, true), f.executor.decide(result.confirmationId, true)]);
    assert.equal(decisions.filter(r => r.status === 'success').length, 1); assert.equal(f.count(), 1);
    assert.equal((await f.executor.invoke('1', 'test.action', input)).status, 'pending'); assert.equal(f.count(), 1);
    const row = f.executor.telemetry.snapshot()[0]!; assert.equal(row.confirmation, 'granted'); assert.equal(row.status, 'success'); assert.ok(row.durationMs !== undefined);
  });
}
test('rejection cannot execute and telemetry excludes private inputs', async () => {
  const f = fixture('SENSITIVE'); const r = await f.executor.invoke('1', 'test.action', input); if (r.status !== 'pending') throw new Error();
  const rejected = await f.executor.decide(r.confirmationId, false); assert.equal(rejected.status, 'error'); assert.equal(f.count(), 0);
  assert.equal(f.executor.telemetry.snapshot()[0]?.confirmation, 'rejected'); assert.ok(!JSON.stringify(f.executor.telemetry.snapshot()).includes('private'));
});
test('expired, wrong, replaced and closed confirmations cannot execute', async () => {
  for (const mode of ['expired', 'wrong', 'replaced', 'closed']) {
    const f = fixture('SENSITIVE'); let now = 0; const e = new ToolExecutor(f.registry, () => now, 10);
    const r = await e.invoke('1', 'test.action', input); if (r.status !== 'pending') throw new Error();
    if (mode === 'expired') now = 11;
    if (mode === 'replaced') await e.invoke('2', 'test.action', input);
    if (mode === 'closed') e.close();
    assert.equal((await e.decide(mode === 'wrong' ? 'wrong' : r.confirmationId, true)).status, 'error'); assert.equal(f.count(), 0);
  }
});
test('invalid and unknown inputs never execute; call ID cannot be rebound', async () => {
  const f = fixture();
  for (const raw of [{ value: 5 }, { value: 'a', extra: true }, null]) assert.equal((await f.executor.invoke(JSON.stringify(raw), 'test.action', raw)).status, 'error');
  assert.equal((await f.executor.invoke('unknown', 'missing', input)).status, 'error'); assert.equal(f.count(), 0);
  await f.executor.invoke('id', 'test.action', input);
  const rebound = await f.executor.invoke('id', 'test.action', { value: 'b' }); assert.equal(rebound.status, 'error'); assert.equal(f.count(), 1);
});
test('duplicates share in-flight result and do not repeat execution', async () => {
  let count = 0; const f = fixture('READ', false, async () => { count++; await new Promise(r => setTimeout(r, 5)); return true; });
  const [a, b] = await Promise.all([f.executor.invoke('1', 'test.action', input), f.executor.invoke('1', 'test.action', input)]);
  assert.deepEqual(a, b); assert.equal(count, 1);
});
test('exceptions and upstream bodies cannot leak secrets', async () => {
  for (const error of [new Error('sk-secret OAuth-refresh-token'), new ToolError('UNCONFIGURED')]) {
    const f = fixture('READ', false, async () => { throw error; }); const r = await f.executor.invoke('1', 'test.action', input);
    assert.equal(r.status, 'error'); assert.ok(!JSON.stringify([r, f.executor.telemetry.snapshot()]).includes('sk-secret'));
  }
});
test('timeout aborts transport and reports uncertain result safely', async () => {
  const f = fixture('READ', false, async (_input, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('secret')))));
  f.definition.timeoutMs = 5; const r = await f.executor.invoke('1', 'test.action', input); assert.equal(r.status, 'error'); if (r.status === 'error') assert.equal(r.category, 'TIMEOUT');
});
test('cancel/new action during preparation invalidates stale action', async () => {
  const f = fixture('SENSITIVE'); let release!: (value: unknown) => void;
  f.definition.prepare = async () => new Promise(resolve => { release = resolve; });
  const pending = f.executor.invoke('1', 'test.action', input); f.executor.invalidate(); release(input);
  assert.equal((await pending).status, 'error'); assert.equal(f.executor.pendingState(), null); assert.equal(f.count(), 0);
});
