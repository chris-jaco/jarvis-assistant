import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RunContext } from '@openai/agents-core';
import { contentRequest } from '../../extension/src/content-transport.js';
import type { Grant } from '../../extension/src/controller.js';
import { parseRequest, timingSchema } from '../browser/attached/protocol.js';
import { ToolError } from './types.js';
import { safeError } from './execution.js';
import { VoiceToolBridge } from '../provider/tools.js';

const id = randomUUID;
test('content transport separates pre-dispatch unavailability, origin change and post-dispatch uncertainty', async () => {
  const epoch = id(), session = id(), scopeId = id(), tabId = id();
  const grant: Grant = { scopeId, tabId, chromeId: 7, origin: 'https://fixture.example', session, task: id(), lifetime: 'task', expiresAt: Date.now() + 900_000, title: 'Fixture', url: 'https://fixture.example/' };
  const request = parseRequest({ protocol: 'atlas.browser', version: 1, kind: 'request', requestId: id(), backendSessionId: session, taskId: grant.task, connectionEpoch: epoch, deadlineAt: Date.now() + 10_000, operation: 'type', args: { scopeId, tabId, ref: id(), documentId: id(), snapshotId: id(), text: 'fixture', mode: 'replace' } });
  for (const stage of ['injection','init','command','malformed'] as const) {
    let actions = 0, dispatched = false;
    const api = { tabs: { update: async () => {}, get: async () => ({ url: 'https://fixture.example/results' }), sendMessage: async (_tab: number, raw: any) => {
      if (raw.kind === 'init') { if (stage === 'init') throw new Error('PRIVATE'); return { completed: true }; }
      ++actions; dispatched = true; if (stage === 'command') throw new Error('PRIVATE'); return { outcome: 'OK', privateData: 'PRIVATE' };
    } }, scripting: { executeScript: async () => { if (stage === 'injection') throw new Error('PRIVATE'); } } } as unknown as Pick<typeof chrome, 'tabs' | 'scripting'>;
    const result = await contentRequest(api, () => epoch, 7, grant, request);
    const { timings, ...outcome } = result; assert.ok(timingSchema.safeParse(timings).success);
    assert.deepEqual(outcome, { outcome: 'ERROR', code: stage === 'command' || stage === 'malformed' ? 'EXECUTION_UNKNOWN' : 'CONTENT_UNAVAILABLE' });
    assert.equal(actions, stage === 'command' || stage === 'malformed' ? 1 : 0);
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
    dispatched = false;
    (api.tabs.get as any) = async () => ({ url: stage === 'injection' || stage === 'init' || dispatched ? 'https://other.example/' : 'https://fixture.example/results' });
    const differentOrigin = await contentRequest(api, () => epoch, 7, grant, request);
    if (stage === 'injection' || stage === 'init') { assert.equal(differentOrigin.outcome, 'REQUIRES_USER_INTERACTION'); assert.equal((differentOrigin as any).reason, 'ORIGIN_PERMISSION'); }
    else { const { timings, ...outcome } = differentOrigin; assert.deepEqual(outcome, { outcome: 'ERROR', code: 'EXECUTION_UNKNOWN' }); }
  }
});
test('safe tool errors expose only strict conflict metadata; generic CONFLICT/unknown never authorize recovery', () => {
  assert.deepEqual(safeError(new ToolError('CONFLICT', { reason: 'ELEMENT_CHANGED', execution: 'NOT_EXECUTED', remainingRecoveries: 2, recoverable: true })), { status: 'error', category: 'CONFLICT', message: 'La acción no se ejecutó. Resuelve el control en la observación nueva en silencio; no es un control bloqueado.', browserRecovery: { reason: 'ELEMENT_CHANGED', execution: 'NOT_EXECUTED', remainingRecoveries: 2, recoverable: true } });
  for (const error of [new ToolError('CONFLICT'), new ToolError('EXECUTION_UNKNOWN'), new ToolError('CONFLICT', { reason: 'PRIVATE', execution: 'NOT_EXECUTED', remainingRecoveries: 2, recoverable: true } as any), new Error('PRIVATE_TOKEN')]) {
    const result = safeError(error); assert.ok(!('browserRecovery' in result)); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
});
test('Realtime conflict recovery guidance is silent and bounded; unknown result never issues another action', async () => {
  const original = globalThis.fetch; let calls = 0; const notices: string[] = [];
  let response: any = { status: 'error', category: 'CONFLICT', message: 'fixture', browserRecovery: { reason: 'SNAPSHOT_CONSUMED', execution: 'NOT_EXECUTED', remainingRecoveries: 2, recoverable: true } };
  globalThis.fetch = async url => {
    const path = String(url);
    if (path.endsWith('/session')) return Response.json({ tools: [{ id: 'browser.press', description: 'Fixture', inputSchema: {} }], timezone: 'Europe/Madrid', now: new Date().toISOString() });
    if (path.endsWith('/activity')) return Response.json({ activity: [], pending: null });
    ++calls; return Response.json(response);
  };
  const bridge = new VoiceToolBridge(() => {}, message => notices.push(message));
  const decode = (raw: unknown) => typeof raw === 'string' ? JSON.parse(raw) : raw as any;
  try {
    const config = await bridge.initialize(); const press = config.tools[0]!;
    const invoke = () => press.invoke(new RunContext(), JSON.stringify({ inputJson: JSON.stringify({ ref: id(), key: 'Enter' }) }));
    let result = decode(await invoke()); assert.ok(result.instruction.includes('Sin hablar')); assert.equal(calls, 1); assert.equal(notices.length, 0);
    response = { ...response, browserRecovery: { ...response.browserRecovery, remainingRecoveries: 0, recoverable: false } };
    result = decode(await invoke()); assert.ok(result.instruction.includes('Detente')); assert.equal(calls, 2);
    response = { status: 'error', category: 'EXECUTION_UNKNOWN', message: 'No repetir' };
    result = decode(await invoke()); assert.equal(result.category, 'EXECUTION_UNKNOWN'); assert.equal(result.instruction, undefined); assert.equal(calls, 3); assert.equal(notices.length, 0);
  } finally { bridge.close(); globalThis.fetch = original; }
});

test('diagnostics whitelist conflict reasons and stage timings; arbitrary fields never reach the sink', async () => {
  const { BrowserDiagnostics } = await import('../browser/diagnostics.js');
  const rows: any[] = []; const diagnostics = new BrowserDiagnostics(true, row => rows.push(row));
  diagnostics.metadata({ queueMs: 12, injectionMs: 3, initializationMs: 2, observationBuildMs: 7, returnMs: 1, transportMs: 30, privateText: 'PRIVATE' } as any, 'SNAPSHOT_EXPIRED');
  assert.equal(rows[0].reason, 'SNAPSHOT_EXPIRED'); assert.equal(rows[0].timings.observationBuildMs, 7); assert.ok(!JSON.stringify(rows).includes('PRIVATE'));
  diagnostics.metadata({ queueMs: NaN } as any, 'PRIVATE' as any); assert.equal(rows[1].reason, undefined); assert.equal(rows[1].timings, undefined);
});
