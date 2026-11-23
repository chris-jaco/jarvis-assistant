import test from 'node:test';
import assert from 'node:assert/strict';
import { createCallController } from '../session.ts';

test('stop during permission releases late media and leaves a newer session intact', async () => {
  const states = [];
  const controller = createCallController(state => states.push(state));
  const permission = Promise.withResolvers();
  let releases = 0;
  const first = controller.start(async scope => {
    await permission.promise;
    scope.own(() => releases++);
    scope.connected();
    scope.fail();
  });
  await controller.start(async () => assert.fail('duplicate'));
  controller.stop();
  await controller.start(async scope => { scope.connected(); });
  permission.resolve();
  await first;
  assert.equal(releases, 1);
  assert.deepEqual(states, ['connecting', 'idle', 'connecting', 'connected']);
  controller.stop();
});

test('error releases all owned resources in reverse order', async () => {
  const released = [], states = [];
  const controller = createCallController(state => states.push(state));
  await controller.start(async scope => {
    scope.own(() => released.push('focus'));
    scope.own(() => { released.push('tracks'); throw new Error(); });
    scope.own(() => released.push('peer'));
    throw new Error('fixture');
  });
  assert.deepEqual(released, ['peer', 'tracks', 'focus']);
  assert.deepEqual(states, ['connecting', 'error']);
});

test('connection deadline aborts an unfinished attempt without reconnecting', async () => {
  const states = [];
  const controller = createCallController(state => states.push(state), 5);
  await controller.start(async scope => {
    await new Promise(resolve => scope.signal.addEventListener('abort', resolve, { once: true }));
    scope.connected();
  });
  assert.deepEqual(states, ['connecting', 'error']);
});

test('closing a native channel during Stop cannot turn an intentional stop into an error', async () => {
  const states = [];
  const call = createCallController(state => states.push(state));
  await call.start(async scope => { scope.own(scope.fail); scope.connected(); });
  call.stop();
  assert.deepEqual(states, ['connecting', 'connected', 'idle']);
});
