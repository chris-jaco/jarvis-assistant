import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm, lstat, readFile, symlink } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TokenFileSecurity } from '../tools/adapters/token-security.js';
import { PrivateJsonMemoryStore } from './store.js';
import { MemoryService } from './service.js';
import { candidate, source } from './test-fixtures.js';
import { ToolError } from '../tools/types.js';
const command = promisify(execFile);
test('batched Windows checks retain fail-closed structural checks and cancellation before ACL execution', async () => {
  let called = 0;
  const security = new TokenFileSecurity('win32', async () => { throw new Error('single check unexpected'); }, async () => { called++; });
  const directory = await lstat('.');
  await assert.rejects(security.validateMany([{ path: '.', info: directory }]), /UNCONFIGURED/); assert.equal(called, 0);
  const c = new AbortController(); c.abort(); await assert.rejects(security.validateMany([{ path: '.', info: directory, directory: true }], c.signal)); assert.equal(called, 0);
  await security.validateMany([{ path: '.', info: directory, directory: true }]); assert.equal(called, 1);
});
test('failed batch ACL validation never writes memory bytes and releases temporary/lock files', { timeout: 10000 }, async () => {
  const file = resolve('.local', 'memory-tests', randomUUID(), 'memories.json');
  let rejectTemporary = false;
  const security = new TokenFileSecurity('win32', async () => {}, async requests => { if (rejectTemporary && requests.some(r => r.path.endsWith('.tmp'))) throw new ToolError('UNCONFIGURED'); });
  await new PrivateJsonMemoryStore(file).read();
  const store = new PrivateJsonMemoryStore(file, security); const service = new MemoryService(store);
  try {
    await service.remember(candidate(), source()); const before = await readFile(file, 'utf8'); rejectTemporary = true;
    await assert.rejects(service.remember(candidate('Never commit', { key: 'rejected' }), source('Never commit')), /UNCONFIGURED/);
    assert.equal(await readFile(file, 'utf8'), before); await assert.rejects(lstat(file + '.lock'));
    rejectTemporary = false; assert.equal((await store.read()).length, 1);
  } finally { await rm(dirname(file), { recursive: true, force: true }); }
});
test('native Windows batched memory ACLs reject broad permissions and reparse paths without disabling checks', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const file = resolve('.local', 'memory-tests', randomUUID(), 'memories.json'); const linked = dirname(file) + '-junction';
  const store = new PrivateJsonMemoryStore(file); const service = new MemoryService(store);
  const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
  try {
    await service.remember(candidate(), source()); assert.equal((await service.search('Frekuent')).length, 1);
    await command(icacls, [file, '/grant', '*S-1-1-0:(R)']); await assert.rejects(store.read(), /UNCONFIGURED/);
    await command(icacls, [file, '/remove:g', '*S-1-1-0']); assert.equal((await store.read()).length, 1);
    await symlink(dirname(file), linked, 'junction'); await assert.rejects(new PrivateJsonMemoryStore(join(linked, 'memories.json')).read(), /UNCONFIGURED/);
  } finally { await rm(linked, { force: true, recursive: true }); await rm(dirname(file), { recursive: true, force: true }); }
});

test('local reads audit once and mutations retain four fresh security batches with stage profiling', async () => {
  const file = resolve('.local', 'memory-tests', randomUUID(), 'memories.json');
  let audits = 0; const stages: import('../diagnostics/memory.js').MemoryDiagnostic[] = [];
  const { MemoryDiagnostics } = await import('../diagnostics/memory.js');
  const security = new TokenFileSecurity('win32', async () => { throw new Error('unexpected single audit'); }, async () => { audits++; });
  const diagnostics = new MemoryDiagnostics(true, entry => stages.push(entry), true);
  const store = new PrivateJsonMemoryStore(file, security, diagnostics);
  try {
    await store.read(); assert.equal(audits, 1); audits = 0;
    const service = new MemoryService(store); await service.remember(candidate(), source()); assert.equal(audits, 4);
    audits = 0; stages.length = 0;
    const record = (await store.read())[0]!; audits = 0;
    await service.remember(candidate('Updated local fact'), source('Updated local fact'), { id: record.id, updatedAt: record.updatedAt });
    assert.equal(audits, 4);
    for (const stage of ['queue', 'lock', 'security', 'snapshot', 'validation', 'write', 'sync', 'commit']) assert.ok(stages.some(e => e.stage === stage && e.code === 'OK'), stage);
    assert.ok(stages.every(e => Object.keys(e).every(key => ['operation', 'stage', 'code', 'elapsedMs'].includes(key))));
    assert.ok(!JSON.stringify(stages).includes('Updated local fact'));
  } finally { await rm(dirname(file), { recursive: true, force: true }); }
});
