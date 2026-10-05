import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, writeFile, rm, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { NativeTransport } from '../browser/attached/transport.js';
import { FrameReader, frame } from '../browser/attached/framing.js';
import { parseRequest } from '../browser/attached/protocol.js';

test('real .NET host/broker: framed IPC handshake, allowed origin, epochs, multiplexing and disconnection', async t => {
  const binary = process.env.ATLAS_NATIVE_TEST_BINARY;
  if (!binary) { t.skip('Set ATLAS_NATIVE_TEST_BINARY to a compiled development host; no Windows installation required by tests'); return; }
  await access(binary);
  const root = await mkdtemp(join(tmpdir(), 'atlas-native-test-')); const app = join(root, 'app'); await cp(dirname(binary), app, { recursive: true });
  const executable = join(app, process.platform === 'win32' ? 'Atlas.NativeHost.exe' : 'Atlas.NativeHost');
  const extensionId = 'a'.repeat(32); await writeFile(join(app, 'atlas-host.json'), JSON.stringify({ extensionId }));
  let hold = false; let dispatched = 0; let cancellations = 0;
  const transport = new NativeTransport(executable, extensionId); const clients: ReturnType<typeof spawn>[] = [];
  try {
    transport.connections();
    await new Promise(resolve => setTimeout(resolve, 200));
    const denied = spawn(executable, [`chrome-extension://${'b'.repeat(32)}/`], { stdio: ['pipe','pipe','pipe'] }); clients.push(denied); let leaked = ''; denied.stdout!.on('data', data => { leaked += String(data); });
    assert.equal(await new Promise(resolve => denied.on('close', resolve)), 1); assert.equal(leaked, '');
    for (let i = 0; i < 2; ++i) {
      const host = spawn(executable, [`chrome-extension://${extensionId}/`], { stdio: ['pipe','pipe','pipe'] }); clients.push(host); host.stderr!.resume();
      const reader = new FrameReader((raw: any) => {
        if (raw.kind === 'cancel') ++cancellations;
        if (raw.kind === 'request') ++dispatched;
        if (raw.kind === 'request' && !hold) host.stdin!.write(frame({ protocol: 'atlas.browser', version: 1, kind: 'response', requestId: raw.requestId, backendSessionId: raw.backendSessionId, connectionEpoch: raw.connectionEpoch, reply: { outcome: 'OK', data: { available: true, connected: true, visible: true, connections: [] } } }));
      }); host.stdout!.on('data', data => reader.push(Buffer.from(data)));
    }
    const deadline = Date.now() + 5000; while (transport.connections().length !== 2) { if (Date.now() > deadline) throw new Error('Native host handshake failed'); await new Promise(resolve => setTimeout(resolve, 20)); }
    const make = () => parseRequest({ protocol: 'atlas.browser', version: 1, kind: 'request', requestId: randomUUID(), backendSessionId: randomUUID(), taskId: randomUUID(), connectionEpoch: transport.epoch, deadlineAt: Date.now() + 1000, operation: 'status', args: {} });
    for (const connection of transport.connections()) assert.equal((await transport.request(connection, make(), new AbortController().signal)).outcome, 'OK');
    const cancelled = new AbortController(); cancelled.abort(); assert.equal((await transport.request(transport.connections()[0]!, make(), cancelled.signal)).outcome, 'ERROR');
    hold = true; const inflightAbort = new AbortController(); const before = dispatched;
    const waiting = transport.request(transport.connections()[0]!, make(), inflightAbort.signal);
    const until = Date.now() + 1000; while (dispatched === before) { if (Date.now() > until) throw new Error('Request not dispatched'); await new Promise(resolve => setTimeout(resolve, 10)); }
    inflightAbort.abort(); assert.deepEqual(await waiting, { outcome: 'ERROR', code: 'EXECUTION_UNKNOWN' });
    await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(dispatched, before + 1); assert.equal(cancellations, 1);
    const previousEpoch = transport.epoch; transport.close(); assert.notEqual(transport.epoch, previousEpoch); const gone = await transport.request(randomUUID(), make(), new AbortController().signal); assert.deepEqual(gone, { outcome: 'ERROR', code: 'DISCONNECTED' });
  } finally { transport.close(); for (const child of clients) { child.stdin?.destroy(); child.kill(); } await new Promise(resolve => setTimeout(resolve, 100)); await rm(root, { recursive: true, force: true }); }
});
