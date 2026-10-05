import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ToolRegistry } from './registry.js';
import { ToolExecutor } from './execution.js';

test('tool latency separates preparation, confirmation wait and execution without changing approval', async () => {
  let now = 1000; const registry = new ToolRegistry();
  registry.register({ id: 'test.timing', name: 'Timing', description: 'Timing', integration: 'test', capability: 'write', permission: 'WRITE', confirm: true, schema: z.object({}), prepare: async () => { now += 3000; return {}; }, execute: async () => { now += 4000; return {}; } });
  const executor = new ToolExecutor(registry, () => now);
  try {
    const p = await executor.invoke('timing', 'test.timing', {}); if (p.status !== 'pending') throw new Error();
    now += 30_000; assert.equal((await executor.decide(p.confirmationId, true)).status, 'success');
    const row = executor.telemetry.snapshot()[0]!;
    assert.equal(row.durationMs, 37_000); assert.equal(row.preparationMs, 3000); assert.equal(row.confirmationWaitMs, 30_000); assert.equal(row.executionMs, 4000);
  } finally { executor.close(); }
});
