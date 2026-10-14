import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DesktopLifecycleCoordinator,
  type DesktopCleanupOutcome,
  type DesktopLifecycleTransition,
  type DesktopTerminationReason
} from '../desktop/lifecycle-coordinator.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const cleanups: ReturnType<typeof deferred<DesktopCleanupOutcome>>[] = [];
  const terminations: Array<{ reason: DesktopTerminationReason; gate: ReturnType<typeof deferred<void>> }> = [];
  const transitions: DesktopLifecycleTransition[] = [];
  const coordinator = new DesktopLifecycleCoordinator({
    cleanupForHide: () => { const gate = deferred<DesktopCleanupOutcome>(); cleanups.push(gate); return gate.promise; },
    terminate: reason => { const gate = deferred<void>(); terminations.push({ reason, gate }); return gate.promise; },
    transition: transition => transitions.push(transition)
  });
  return { coordinator, cleanups, terminations, transitions };
}

async function tick(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }

test('desktop lifecycle accepts explicit visible voice transitions and rejects invalid ones', () => {
  const f = fixture();
  assert.equal(f.coordinator.state, 'STARTING');
  assert.equal(f.coordinator.voiceConnected().accepted, false);
  assert.equal(f.coordinator.ready().to, 'VISIBLE_DISCONNECTED');
  assert.equal(f.coordinator.ready(true).accepted, false);
  assert.equal(f.coordinator.voiceConnected().to, 'VISIBLE_ACTIVE');
  assert.equal(f.coordinator.voiceConnected().accepted, false);
  assert.equal(f.coordinator.voiceDisconnected().to, 'VISIBLE_DISCONNECTED');
});

for (const outcome of ['FAILED', 'TIMED_OUT'] as const) {
  test(`hide ${outcome} remains visible and never infers cleanup success`, async () => {
    const f = fixture(); f.coordinator.ready(true);
    const hiding = f.coordinator.hide(); await tick();
    assert.equal(f.coordinator.state, 'PREPARING_HIDE'); assert.equal(f.cleanups.length, 1);
    f.cleanups[0]!.resolve(outcome); assert.equal(await hiding, outcome);
    assert.equal(f.coordinator.state, 'VISIBLE_ERROR');
    assert.equal(f.transitions.at(-1)?.cleanup, outcome);
    assert.equal(f.transitions.some(transition => transition.cleanup === 'COMPLETED'), false);
  });
}

test('hide completes only after explicit COMPLETED and restore never reconnects voice', async () => {
  const f = fixture(); f.coordinator.ready(true);
  const hiding = f.coordinator.hide(); await tick(); f.cleanups[0]!.resolve('COMPLETED');
  assert.equal(await hiding, 'COMPLETED'); assert.equal(f.coordinator.state, 'HIDDEN_DISCONNECTED');
  assert.equal(f.coordinator.restore().to, 'VISIBLE_DISCONNECTED');
  assert.equal(f.coordinator.state, 'VISIBLE_DISCONNECTED');
  assert.equal(f.coordinator.voiceConnected().accepted, true);
});

test('hide exceptions fail closed and a deliberate later hide is a fresh operation', async () => {
  const f = fixture(); f.coordinator.ready();
  const first = f.coordinator.hide(); await tick(); f.cleanups[0]!.reject(new Error('fixture'));
  assert.equal(await first, 'FAILED'); assert.equal(f.coordinator.state, 'VISIBLE_ERROR');
  const second = f.coordinator.hide(); await tick(); assert.equal(f.cleanups.length, 2);
  f.cleanups[1]!.resolve('COMPLETED'); assert.equal(await second, 'COMPLETED');
  assert.equal(f.coordinator.state, 'HIDDEN_DISCONNECTED');
});

test('duplicate HIDE coalesces one cleanup and one result', async () => {
  const f = fixture(); f.coordinator.ready();
  const first = f.coordinator.hide(); const second = f.coordinator.hide();
  assert.equal(first, second); await tick(); assert.equal(f.cleanups.length, 1);
  f.cleanups[0]!.resolve('COMPLETED'); assert.equal(await first, 'COMPLETED');
  assert.equal(f.transitions.some(transition => transition.event === 'HIDE' && transition.coalesced), true);
});

test('RESTORE supersedes pending HIDE; stale cleanup cannot hide or reconnect', async () => {
  const f = fixture(); f.coordinator.ready(true);
  const hiding = f.coordinator.hide(); await tick();
  assert.equal(f.coordinator.restore().to, 'VISIBLE_DISCONNECTED');
  f.cleanups[0]!.resolve('COMPLETED'); assert.equal(await hiding, 'COMPLETED');
  assert.equal(f.coordinator.state, 'VISIBLE_DISCONNECTED');
  assert.equal(f.transitions.at(-1)?.event, 'RESTORE');
});

test('QUIT supersedes HIDE immediately and stale cleanup cannot overwrite termination', async () => {
  const f = fixture(); f.coordinator.ready(true);
  const hiding = f.coordinator.hide(); await tick();
  const quitting = f.coordinator.quit(); await tick();
  assert.equal(f.coordinator.state, 'SHUTTING_DOWN'); assert.equal(f.terminations.length, 1);
  assert.equal(f.terminations[0]!.reason, 'QUIT');
  f.cleanups[0]!.resolve('COMPLETED'); assert.equal(await hiding, 'COMPLETED');
  assert.equal(f.coordinator.state, 'SHUTTING_DOWN');
  f.terminations[0]!.gate.resolve(); await quitting;
  assert.equal(f.coordinator.state, 'TERMINATED');
});

test('CORE_CRASH supersedes HIDE immediately without retrying cleanup or effects', async () => {
  const f = fixture(); f.coordinator.ready();
  const hiding = f.coordinator.hide(); await tick();
  const crashing = f.coordinator.coreCrash(); await tick();
  assert.equal(f.coordinator.state, 'CORE_FAILED'); assert.equal(f.cleanups.length, 1);
  assert.deepEqual(f.terminations.map(value => value.reason), ['CORE_CRASH']);
  f.cleanups[0]!.resolve('FAILED'); await hiding;
  assert.equal(f.coordinator.state, 'CORE_FAILED');
  f.terminations[0]!.gate.resolve(); await crashing;
  assert.equal(f.coordinator.state, 'TERMINATED');
});

test('RESTORE then QUIT starts one terminal operation and forbids later restore', async () => {
  const f = fixture(); f.coordinator.ready();
  const hiding = f.coordinator.hide(); await tick(); f.cleanups[0]!.resolve('COMPLETED'); await hiding;
  f.coordinator.restore(); const quitting = f.coordinator.quit(); await tick();
  assert.equal(f.coordinator.restore().accepted, false); assert.equal(f.terminations.length, 1);
  f.terminations[0]!.gate.resolve(); await quitting;
  assert.equal(f.coordinator.state, 'TERMINATED'); assert.equal(f.coordinator.restore().accepted, false);
});

test('QUIT and CORE_CRASH share one terminal effect; crash wins the observable in-flight state', async () => {
  const f = fixture(); f.coordinator.ready(true);
  const quitting = f.coordinator.quit(); await tick();
  const crashing = f.coordinator.coreCrash();
  assert.equal(quitting, crashing); assert.equal(f.coordinator.state, 'CORE_FAILED');
  assert.equal(f.terminations.length, 1); assert.equal(f.terminations[0]!.reason, 'QUIT');
  f.terminations[0]!.gate.resolve(); await Promise.all([quitting, crashing]);
  assert.equal(f.coordinator.state, 'TERMINATED');
  await f.coordinator.coreCrash(); await f.coordinator.quit();
  assert.equal(f.terminations.length, 1);
});

test('duplicate QUIT and duplicate CORE_CRASH are idempotent single-use terminal operations', async () => {
  for (const event of ['QUIT', 'CORE_CRASH'] as const) {
    const f = fixture(); f.coordinator.ready();
    const first = event === 'QUIT' ? f.coordinator.quit() : f.coordinator.coreCrash();
    const second = event === 'QUIT' ? f.coordinator.quit() : f.coordinator.coreCrash();
    assert.equal(first, second); await tick(); assert.equal(f.terminations.length, 1);
    f.terminations[0]!.gate.resolve(); await Promise.all([first, second]);
    assert.equal(f.coordinator.state, 'TERMINATED');
  }
});

test('terminal effect failure still reaches irreversible TERMINATED without retry', async () => {
  const f = fixture(); f.coordinator.ready();
  const quitting = f.coordinator.quit(); await tick(); f.terminations[0]!.gate.reject(new Error('fixture'));
  await quitting; assert.equal(f.coordinator.state, 'TERMINATED');
  assert.equal(f.coordinator.ready().accepted, false);
  assert.equal(await f.coordinator.hide(), 'FAILED');
  await f.coordinator.quit(); await f.coordinator.coreCrash();
  assert.equal(f.terminations.length, 1);
});
