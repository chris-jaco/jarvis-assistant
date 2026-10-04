import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, rm, writeFile, chmod, symlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PrivateJsonMemoryStore } from './store.js';
import { MemoryService } from './service.js';
import { candidate, source } from './test-fixtures.js';
const path = () => resolve('.local', 'memory-tests', randomUUID(), 'memories.json');

test('private atomic persistence survives a separate Node process and database/lock/tmp files remain Git-ignored', async () => {
  const file = path(); try {
    const first = new MemoryService(new PrivateJsonMemoryStore(file)); const record = await first.remember(candidate(), source());
    const second = new MemoryService(new PrivateJsonMemoryStore(file)); assert.equal((await second.search('Frekuent'))[0]!.id, record!.id);
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', 'import {PrivateJsonMemoryStore} from "./src/memory/store.ts"; const rows=await new PrivateJsonMemoryStore(process.argv[1]).read(); process.stdout.write(String(rows.length));', file], { cwd: process.cwd(), encoding: 'utf8' }); assert.equal(output, '1');
    if (process.platform !== 'win32') { assert.equal((await lstat(file)).mode & 0o777, 0o600); assert.equal((await lstat(dirname(file))).mode & 0o777, 0o700); }
    for (const name of [file, file + '.lock', file + '.tmp']) assert.ok(execFileSync('git', ['check-ignore', name], { encoding: 'utf8' }).trim());
    await assert.rejects(lstat(file + '.lock'));
  } finally { await rm(dirname(file), { recursive: true, force: true }); }
});
test('concurrent instances serialize updates; a foreign writer lock fails safely without overwriting', async () => {
  const file = path(); try {
    const a = new MemoryService(new PrivateJsonMemoryStore(file)); const b = new MemoryService(new PrivateJsonMemoryStore(file));
    await Promise.all([a.remember(candidate('One', { key: 'one' }), source('One')), b.remember(candidate('Two', { key: 'two' }), source('Two'))]);
    assert.equal((await new PrivateJsonMemoryStore(file).read()).length, 2);
    await writeFile(file + '.lock', '', { mode: 0o600 }); await assert.rejects(a.remember(candidate('Three', { key: 'three' }), source('Three'))); assert.equal((await new PrivateJsonMemoryStore(file).read()).length, 2);
  } finally { await rm(dirname(file), { recursive: true, force: true }); }
});
test('malformed or secret-containing snapshots fail closed; custom storage cannot leave ignored .local', async () => {
  assert.throws(() => new PrivateJsonMemoryStore('/tmp/public-memory.json'));
  const file = path(); try {
    const store = new PrivateJsonMemoryStore(file); await store.read(); await writeFile(file, '{malformed private-content', { mode: 0o600 }); await assert.rejects(store.read());
  } finally { await rm(dirname(file), { recursive: true, force: true }); }
});
test('POSIX unsafe permissions and symbolic links refuse memory reads/writes', { skip: process.platform === 'win32' }, async () => {
  const file = path(); try {
    const store = new PrivateJsonMemoryStore(file); await store.read(); await writeFile(file, '{"version":1,"records":[]}', { mode: 0o600 }); await chmod(file, 0o644); await assert.rejects(store.read());
    await rm(file); await symlink('/tmp', file); await assert.rejects(store.read());
  } finally { await rm(dirname(file), { recursive: true, force: true }); }
});
