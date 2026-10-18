import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BackendSupervisor, backendEnvironment } from '../desktop/backend-supervisor.js';
import type { BackendProcess, BackendStartupDiagnostic } from '../desktop/backend-supervisor.js';
import { DesktopBackendClient } from '../desktop/backend-client.js';
import {
  CORE_BOOTSTRAP_PROTOCOL,
  createCoreBootstrapRequest,
  parseCoreBootstrapAck,
  parseCoreBootstrapRequest
} from '../desktop/core-bootstrap-protocol.js';
import { CoreCredentialBootstrapReceiver, receiveCoreCredentialBootstrap } from '../server/core-bootstrap.js';

const key = 'private-bootstrap-fixture-value';
const flush = () => new Promise<void>(resolveFlush => setImmediate(resolveFlush));

class BootstrapChild extends EventEmitter implements BackendProcess {
  stdout = new PassThrough(); stderr = new PassThrough(); pid = 7331; killed = 0; sent: unknown[] = [];
  kill(): boolean { this.killed++; this.emit('exit', null); return true; }
  postMessage(message: unknown): void { this.sent.push(message); }
  override once(event: 'spawn' | 'exit' | 'error', listener: (...args: any[]) => void): this { return super.once(event, listener); }
}

function supervisorFixture(timeout = 100) {
  const child = new BootstrapChild(); const diagnostics: BackendStartupDiagnostic[] = []; let environment: NodeJS.ProcessEnv | undefined;
  const supervisor = new BackendSupervisor({
    executable: 'electron', serverEntry: 'server.js', cwd: '.', runtime: 'utility', startupTimeoutMs: timeout, shutdownTimeoutMs: 5,
    spawn: (_executable, _args, options) => { environment = options.env; return child; }, diagnostic: event => diagnostics.push(event),
    clientFactory: endpoint => new DesktopBackendClient(endpoint.baseUrl, endpoint.secret, async input => Response.json(String(input).endsWith('/health') ? { ready: true } : { closing: true }))
  });
  return { child, diagnostics, supervisor, environment: () => environment };
}

test('packaged supervisor sends one generation-bound credential and gates readiness on an accepted secret-free ack', async () => {
  const f = supervisorFixture(); const generation = randomUUID(); let resolved = false;
  const starting = f.supervisor.start({ generation, openAIKey: key }).then(value => { resolved = true; return value; });
  f.child.emit('spawn'); assert.equal(f.child.sent.length, 1);
  assert.deepEqual(parseCoreBootstrapRequest(f.child.sent[0]), createCoreBootstrapRequest(generation, key));
  assert.equal(f.environment()?.OPENAI_API_KEY, undefined); assert.equal(f.environment()?.ATLAS_CREDENTIAL_BOOTSTRAP_GENERATION, generation);
  f.child.stdout.write('ATLAS_READY 43131\n'); await flush(); assert.equal(resolved, false);
  const ack = { protocol: CORE_BOOTSTRAP_PROTOCOL, kind: 'ACK', generation, status: 'ACCEPTED' } as const;
  f.child.emit('message', ack);
  assert.equal((await starting).baseUrl, 'http://127.0.0.1:43131');
  assert.deepEqual(parseCoreBootstrapAck(ack), ack); assert.equal(JSON.stringify(ack).includes(key), false);
  assert.deepEqual(f.diagnostics.map(event => event.stage), ['CORE_SPAWN_REQUESTED', 'CORE_SPAWNED', 'CORE_BOOTSTRAP_SENT', 'CORE_STDOUT_OBSERVED', 'CORE_READY_RECEIVED', 'CORE_BOOTSTRAP_ACK', 'CORE_HEALTH_STARTED', 'CORE_HEALTH_OK']);
  assert.equal(JSON.stringify(f.diagnostics).includes(key), false); await f.supervisor.stop();
});

test('wrong, duplicate and malformed acknowledgments fail closed without another credential send', async () => {
  for (const acknowledge of [
    (generation: string) => ({ protocol: CORE_BOOTSTRAP_PROTOCOL, kind: 'ACK', generation: randomUUID(), status: 'ACCEPTED' }),
    (generation: string) => ({ protocol: CORE_BOOTSTRAP_PROTOCOL, kind: 'ACK', generation, status: 'REJECTED', reason: 'GENERATION_MISMATCH' }),
    (_generation: string) => ({ arbitrary: true })
  ]) {
    const f = supervisorFixture(); const generation = randomUUID(); const starting = f.supervisor.start({ generation, openAIKey: key });
    f.child.emit('spawn'); f.child.emit('message', acknowledge(generation));
    await assert.rejects(starting, /BOOTSTRAP_REJECTED/); assert.equal(f.child.sent.length, 1); assert.equal(f.child.killed, 1);
  }
  const f = supervisorFixture(); const generation = randomUUID(); const starting = f.supervisor.start({ generation, openAIKey: key });
  f.child.emit('spawn'); const ack = { protocol: CORE_BOOTSTRAP_PROTOCOL, kind: 'ACK', generation, status: 'ACCEPTED' } as const;
  f.child.emit('message', ack); f.child.emit('message', ack);
  await assert.rejects(starting, /BOOTSTRAP_REJECTED/); assert.equal(f.child.sent.length, 1);

  const invalid = supervisorFixture(); const invalidStart = invalid.supervisor.start({ generation: randomUUID(), openAIKey: ' bad-value' });
  invalid.child.emit('spawn'); await assert.rejects(invalidStart, /BOOTSTRAP_SEND_FAILED/);
  assert.equal(invalid.child.sent.length, 0); assert.equal(invalid.child.killed, 1);
});

test('bootstrap timeout and crashes before or after acknowledgment never retry or auto-restart', async () => {
  const timed = supervisorFixture(5); const timedGeneration = randomUUID(); const timeout = timed.supervisor.start({ generation: timedGeneration, openAIKey: key }); timed.child.emit('spawn');
  await assert.rejects(timeout, /START_TIMEOUT/); assert.equal(timed.child.sent.length, 1); assert.equal(timed.child.killed, 1);
  timed.child.emit('message', { protocol: CORE_BOOTSTRAP_PROTOCOL, kind: 'ACK', generation: timedGeneration, status: 'ACCEPTED' });
  timed.child.stdout.write('ATLAS_READY 43139\n'); await flush();
  assert.equal(timed.diagnostics.some(event => event.stage === 'CORE_BOOTSTRAP_ACK'), false);
  assert.equal(timed.diagnostics.some(event => event.stage === 'CORE_READY_RECEIVED'), false);
  const early = supervisorFixture(); const earlyStart = early.supervisor.start({ generation: randomUUID(), openAIKey: key }); early.child.emit('spawn'); early.child.emit('exit', 17);
  await assert.rejects(earlyStart, /EXITED_EARLY/); assert.equal(early.child.sent.length, 1);
  const after = supervisorFixture(); const generation = randomUUID(); let crash: number | null | undefined;
  const owned = new BackendSupervisor({ executable: 'electron', serverEntry: 'server.js', cwd: '.', runtime: 'utility', spawn: () => after.child, diagnostic: () => {}, onUnexpectedExit: code => { crash = code; }, clientFactory: endpoint => new DesktopBackendClient(endpoint.baseUrl, endpoint.secret, async () => Response.json({ ready: true })) });
  const started = owned.start({ generation, openAIKey: key }); after.child.emit('spawn'); after.child.emit('message', { protocol: CORE_BOOTSTRAP_PROTOCOL, kind: 'ACK', generation, status: 'ACCEPTED' }); after.child.stdout.write('ATLAS_READY 43132\n'); await started;
  after.child.emit('exit', 9); assert.equal(crash, 9); assert.equal(after.child.sent.length, 1);
});

test('a Core exit after readiness but before health completion invalidates startup', async () => {
  const child = new BootstrapChild(); const generation = randomUUID(); let releaseHealth!: () => void; let unexpected = 0;
  const health = new Promise<void>(resolve => { releaseHealth = resolve; });
  const supervisor = new BackendSupervisor({
    executable: 'electron', serverEntry: 'server.js', cwd: '.', runtime: 'utility', spawn: () => child, diagnostic: () => {}, onUnexpectedExit: () => { unexpected++; },
    clientFactory: () => ({ health: () => health, dispose() {}, shutdown: async () => undefined } as unknown as DesktopBackendClient)
  });
  const starting = supervisor.start({ generation, openAIKey: key }); child.emit('spawn');
  child.emit('message', { protocol: CORE_BOOTSTRAP_PROTOCOL, kind: 'ACK', generation, status: 'ACCEPTED' }); child.stdout.write('ATLAS_READY 43138\n');
  await flush(); child.emit('exit', 19); releaseHealth();
  await assert.rejects(starting, /EXITED_DURING_HEALTH/); assert.equal(unexpected, 0); assert.equal(child.sent.length, 1);
});

test('Core receiver rejects invalid generations and duplicate requests and returns only a secret-free ack', () => {
  const generation = randomUUID(); const receiver = new CoreCredentialBootstrapReceiver(generation);
  const wrong = receiver.accept(createCoreBootstrapRequest(randomUUID(), key)); assert.equal(wrong.ack.status, 'REJECTED'); assert.equal(wrong.credential, undefined);
  const accepted = receiver.accept(createCoreBootstrapRequest(generation, key)); assert.equal(accepted.credential, key); assert.equal(accepted.ack.status, 'ACCEPTED'); assert.equal(JSON.stringify(accepted.ack).includes(key), false);
  const duplicate = receiver.accept(createCoreBootstrapRequest(generation, key)); assert.deepEqual(duplicate.ack, { protocol: CORE_BOOTSTRAP_PROTOCOL, kind: 'ACK', generation, status: 'REJECTED', reason: 'DUPLICATE' });
  assert.equal(parseCoreBootstrapRequest({ ...createCoreBootstrapRequest(generation, key), extra: true }), undefined);
  assert.throws(() => createCoreBootstrapRequest(generation, 'x'.repeat(8_193)), /BOOTSTRAP_INVALID/);
});

test('Core waits for a valid parentPort message and acknowledges before resolving credentials', async () => {
  class Port extends EventEmitter { sent: unknown[] = []; postMessage(message: unknown) { this.sent.push(message); } }
  const port = new Port(); const generation = randomUUID();
  const pending = receiveCoreCredentialBootstrap(port as unknown as Electron.ParentPort, generation, 100);
  port.emit('message', { data: createCoreBootstrapRequest(generation, key) });
  assert.deepEqual(await pending, { OPENAI_API_KEY: key }); assert.equal(JSON.stringify(port.sent).includes(key), false);
  const acknowledged = port.sent.length; port.emit('message', { data: createCoreBootstrapRequest(generation, key) });
  assert.equal(port.sent.length, acknowledged);
  await assert.rejects(receiveCoreCredentialBootstrap(undefined, generation, 5), /CHANNEL_UNAVAILABLE/);
  const silent = new Port(); await assert.rejects(receiveCoreCredentialBootstrap(silent as unknown as Electron.ParentPort, randomUUID(), 5), /BOOTSTRAP_TIMEOUT/);
  assert.equal(silent.listenerCount('message'), 0);
});

test('development remains environment-based while packaged Core bootstrap precedes tools, server and readiness', () => {
  const generation = randomUUID();
  assert.equal(backendEnvironment({ OPENAI_API_KEY: key }, 'a'.repeat(64), 'utility').OPENAI_API_KEY, key);
  const packaged = backendEnvironment({}, 'b'.repeat(64), 'utility', generation);
  assert.equal(packaged.OPENAI_API_KEY, undefined); assert.equal(packaged.ATLAS_CREDENTIAL_BOOTSTRAP_GENERATION, generation);
  const server = readFileSync(resolve(import.meta.dirname, '../server/index.ts'), 'utf8');
  assert.ok(server.indexOf('receiveCoreCredentialBootstrap') < server.indexOf('createToolsHandler(runtimeEnvironment'));
  assert.ok(server.indexOf('receiveCoreCredentialBootstrap') < server.indexOf('server.listen'));
  const preload = readFileSync(resolve(import.meta.dirname, '../desktop/preload.ts'), 'utf8');
  const setupPreload = readFileSync(resolve(import.meta.dirname, '../desktop/credential-setup-preload.ts'), 'utf8');
  assert.doesNotMatch(`${preload}\n${setupPreload}`, /core-bootstrap|parentPort|OPENAI_API_KEY/);
});
