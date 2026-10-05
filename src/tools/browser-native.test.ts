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
import { AttachedChromeProvider } from '../browser/attached/provider.js';
import { BrowserAdapter } from './adapters/browser.js';
import { ToolRegistry } from './registry.js';
import { ToolExecutor } from './execution.js';
import { ExtensionController } from '../../extension/src/controller.js';
import type { Surface } from '../../extension/src/controller.js';

test('real .NET host/broker: framed IPC handshake, allowed origin, epochs, multiplexing and disconnection', async t => {
  const binary = process.env.ATLAS_NATIVE_TEST_BINARY;
  if (!binary) { t.skip('Set ATLAS_NATIVE_TEST_BINARY to a compiled development host; no Windows installation required by tests'); return; }
  await access(binary);
  const root = await mkdtemp(join(tmpdir(), 'atlas-native-test-')); const app = join(root, 'app'); await cp(dirname(binary), app, { recursive: true });
  const executable = join(app, process.platform === 'win32' ? 'Atlas.NativeHost.exe' : 'Atlas.NativeHost');
  const extensionId = 'a'.repeat(32); await writeFile(join(app, 'atlas-host.json'), JSON.stringify({ extensionId }));
  let hold = false; let dispatched = 0; let cancellations = 0; let creates = 0; const diagnostics: string[] = [];
  const transport = new NativeTransport(executable, extensionId, { diagnostic: line => diagnostics.push(line) }); const clients: ReturnType<typeof spawn>[] = [];
  try {
    const provider = new AttachedChromeProvider(transport); const registry = new ToolRegistry(); registry.add(new BrowserAdapter(provider)); const executor = new ToolExecutor(registry);
    // Reproduce first tool call before Chrome has connected: it must await the handshake, not fail UNCONFIGURED.
    const coldOpen = provider.inSession(randomUUID(), () => executor.invoke('cold-open', 'browser.open', { url: 'https://fixture.example/' }));
    assert.equal(transport.connections().length, 0);
    const handshakeAbort = new AbortController(); const abortedHandshake = transport.waitForConnections(handshakeAbort.signal); handshakeAbort.abort();
    await assert.rejects(abortedHandshake, (error: any) => error.category === 'TIMEOUT'); // No command dispatch; does not cancel the other waiter.
    await new Promise(resolve => setTimeout(resolve, 200));
    const denied = spawn(executable, [`chrome-extension://${'b'.repeat(32)}/`], { stdio: ['pipe','pipe','pipe'] }); clients.push(denied); let leaked = ''; denied.stdout!.on('data', data => { leaked += String(data); });
    assert.equal(await new Promise(resolve => denied.on('close', resolve)), 1); assert.equal(leaked, '');
    for (let i = 0; i < 2; ++i) {
      const host = spawn(executable, [`chrome-extension://${extensionId}/`], { stdio: ['pipe','pipe','pipe'] }); clients.push(host); host.stderr!.resume();
      const controller = new ExtensionController({ create: async () => { ++creates; return 7; }, invalidate: async () => {} } as unknown as Surface, () => {});
      const reader = new FrameReader((raw: any) => {
        if (raw.kind === 'hello') void controller.reset(raw);
        if (raw.kind === 'cancel') controller.cancel(raw);
        if (raw.kind === 'cancel') ++cancellations;
        if (raw.kind === 'request') ++dispatched;
        if (raw.kind === 'request' && !hold) void controller.receive(raw).then(reply => host.stdin!.write(frame({ protocol: 'atlas.browser', version: 1, kind: 'response', requestId: raw.requestId, backendSessionId: raw.backendSessionId, connectionEpoch: raw.connectionEpoch, reply })));
      }); host.stdout!.on('data', data => reader.push(Buffer.from(data)));
      if (i === 0) { const result = await coldOpen; assert.equal(result.status, 'success'); if (result.status !== 'success') throw new Error('Cold open failed'); assert.equal((result.data as any).browserState.outcome, 'ACCESS_PENDING'); assert.equal(creates, 1); assert.ok(diagnostics.some(line => line.includes('configured=true'))); assert.ok(diagnostics.some(line => line.includes('stage=bridge_wait code=OK'))); }
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
