import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { attachedConfiguration } from '../browser/attached/config.js';
import { NativeTransport } from '../browser/attached/transport.js';
import { AttachedChromeProvider } from '../browser/attached/provider.js';
import { BrowserAdapter } from './adapters/browser.js';
import { ToolExecutor } from './execution.js';
import { ToolRegistry } from './registry.js';
import { createToolRuntime } from '../server/tools.js';

test('Node dotenv preserves unquoted Windows host backslashes and the documented attached variable names', () => {
  const path = String.raw`C:\Users\fixture\AppData\Local\Atlas\BrowserBridge\0.5.1\Atlas.NativeHost.exe`;
  const env = parseEnv(`BROWSER_ENABLED=true\nBROWSER_PROVIDER=attached\nATLAS_BROWSER_EXTENSION_ID=${'a'.repeat(32)}\nATLAS_BROWSER_HOST_PATH=${path}\n`);
  assert.equal(env.ATLAS_BROWSER_HOST_PATH, path); assert.ok(win32.isAbsolute(env.ATLAS_BROWSER_HOST_PATH!));
  assert.equal(env.BROWSER_PROVIDER, 'attached'); assert.equal(env.BROWSER_ENABLED, 'true'); assert.match(env.ATLAS_BROWSER_EXTENSION_ID!, /^[a-p]{32}$/);
});

test('invalid attached config reports logical issues immediately, without spawning or waiting for a bridge', async () => {
  const lines: string[] = []; const transport = new NativeTransport(undefined, undefined, { diagnostic: line => lines.push(line) });
  const provider = new AttachedChromeProvider(transport); const registry = new ToolRegistry(); registry.add(new BrowserAdapter(provider)); const executor = new ToolExecutor(registry);
  let waited = false; transport.waitForConnections = async () => { waited = true; throw new Error('Must not wait on invalid config'); };
  try {
    transport.initialize();
    const result = await provider.inSession(randomUUID(), () => executor.invoke('invalid', 'browser.open', { url: 'https://fixture.example/' }));
    assert.equal(result.status, 'error'); assert.equal((result as any).category, 'UNCONFIGURED'); assert.equal(waited, false);
    assert.equal(lines.length, 1); assert.match(lines[0]!, /configured=false.*ATLAS_BROWSER_HOST_PATH:missing.*ATLAS_BROWSER_EXTENSION_ID:missing/);
    assert.deepEqual(transport.connections(), []);
  } finally { transport.close(); }
});

test('configuration rejects unavailable/relative/nonregular hosts and invalid IDs without disclosing values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-attached-config-')); const host = join(root, 'host.exe'); await writeFile(host, 'fixture');
  try {
    assert.equal(attachedConfiguration(host, 'a'.repeat(32)).configured, true);
    for (const [path, extension] of [[undefined, undefined], ['relative.exe', 'PRIVATE_EXTENSION_VALUE'], [join(root, 'missing.exe'), 'a'.repeat(32)], [root, 'a'.repeat(32)]] as const) {
      const config = attachedConfiguration(path, extension); assert.equal(config.configured, false);
      assert.ok(!JSON.stringify(config).includes('PRIVATE_EXTENSION_VALUE')); assert.ok(!JSON.stringify(config).includes(root));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('configured broker failure is UPSTREAM rather than UNCONFIGURED; pre-dispatch cancellation remains TIMEOUT', async () => {
  const lines: string[] = []; const transport = new NativeTransport(process.execPath, 'a'.repeat(32), { diagnostic: line => lines.push(line) });
  try {
    assert.equal(transport.configuration().configured, true);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(transport.waitForConnections(cancelled.signal), (error: any) => error.category === 'TIMEOUT');
    assert.equal(lines.length, 0, 'An already-aborted call must not launch a broker');
    // Node is a regular executable but not the Atlas host: --broker exits with an error.
    await assert.rejects(transport.waitForConnections(new AbortController().signal), (error: any) => error.category === 'UPSTREAM');
    assert.ok(lines.some(line => line.includes('configured=true'))); assert.ok(lines.some(line => line.includes('stage=broker_closed code=FAILED')));
    assert.ok(!lines.join('\n').includes(process.execPath)); assert.ok(!lines.join('\n').includes('a'.repeat(32)));
  } finally { transport.close(); }
});

test('runtime receives dotenv attached config and reports startup even with BROWSER_TRACE=false', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-runtime-config-')); const host = join(root, 'host.exe'); await writeFile(host, 'non-executable fixture'); await mkdir(join(root, '.local'));
  const env = parseEnv(`BROWSER_ENABLED=true\nBROWSER_PROVIDER=attached\nBROWSER_TRACE=false\nATLAS_BROWSER_EXTENSION_ID=${'a'.repeat(32)}\nATLAS_BROWSER_HOST_PATH=${host}\nMEMORY_PATH=${join(root, '.local/memory/memories.json')}\n`);
  const lines: string[] = []; const original = console.info; console.info = (...args: unknown[]) => { lines.push(args.join(' ')); };
  let runtime: ReturnType<typeof createToolRuntime> | undefined;
  try {
    runtime = createToolRuntime(env);
    assert.equal(lines[0], '[ATLAS browser] provider=attached configured=true');
    assert.ok(runtime.registry.descriptors().some(tool => tool.id === 'browser.requestAccess'));
    assert.ok(!runtime.registry.descriptors().some(tool => tool.id === 'browser.close'));
    assert.ok(!lines.join('\n').includes(root)); assert.ok(!lines.join('\n').includes('a'.repeat(32)));
  } finally { await runtime?.browser.close(); console.info = original; await rm(root, { recursive: true, force: true }); }
});

test('cancellation after asynchronous channel readiness cannot dispatch the browser action', async () => {
  const controller = new AbortController(); const channel = randomUUID(); let dispatches = 0;
  const provider = new AttachedChromeProvider({ epoch: randomUUID(), configuration: () => ({ configured: true, issues: [] }),
    connections: () => [channel], waitForConnections: async () => { controller.abort(); return [channel]; },
    request: async () => { ++dispatches; return { outcome: 'OK', data: { completed: true } }; }, subscribe: () => () => {}, close: () => {}
  });
  await assert.rejects(provider.inSession(randomUUID(), () => provider.openTab('https://fixture.example/', controller.signal)), (error: any) => error.category === 'TIMEOUT');
  assert.equal(dispatches, 0);
});
