import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve, parse, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TokenFileSecurity } from '../tools/adapters/token-security.js';
import type { FileSecurityEntry } from '../tools/adapters/token-security.js';
import { MemoryDiagnostics } from '../diagnostics/memory.js';
import { ToolError } from '../tools/types.js';
import { recordSchema } from './types.js';
import type { MemoryRecord, MemoryStore } from './types.js';
import { containsSecret } from './privacy.js';
const snapshot = z.object({ version: z.literal(1), records: z.array(recordSchema).max(2000) }).strict();
const queues = new Map<string, Promise<unknown>>();
export class PrivateJsonMemoryStore implements MemoryStore {
  readonly path: string;
  constructor(path = '.local/memory/memories.json', private readonly security = new TokenFileSecurity(), private readonly diagnostics = new MemoryDiagnostics()) {
    this.path = resolve(path);
    const local = resolve('.local'); const within = relative(local, this.path);
    if (within.startsWith('..' + sep) || within === '..' || !within || resolve(local, within) !== this.path || parse(within).root) throw new Error('MEMORY_PATH must be inside .local');
  }
  private async directory(signal?: AbortSignal): Promise<FileSecurityEntry[]> {
    signal?.throwIfAborted(); let cursor = dirname(this.path); const ancestors: string[] = [];
    while (cursor !== parse(cursor).root) { ancestors.unshift(cursor); cursor = dirname(cursor); }
    for (const path of ancestors) {
      try { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new ToolError('UNCONFIGURED'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    const local = resolve('.local'); const directories = [local]; let current = local;
    for (const component of relative(local, dirname(this.path)).split(sep).filter(Boolean)) { current = resolve(current, component); directories.push(current); }
    const entries: FileSecurityEntry[] = [];
    for (const path of directories) {
      signal?.throwIfAborted(); let newlyCreated = false;
      try { await mkdir(path, { mode: 0o700 }); newlyCreated = true; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      const info = await lstat(path); this.security.validateStructure(info, true);
      entries.push({ path, info, directory: true, newlyCreated });
    }
    return entries;
  }
  private audit(operation: 'read' | 'write', entries: FileSecurityEntry[], signal?: AbortSignal): Promise<void> {
    return this.diagnostics.run(operation, 'security', () => this.security.validateMany(entries, signal), signal);
  }
  private async snapshot(entries: FileSecurityEntry[], operation: 'read' | 'write', signal?: AbortSignal): Promise<MemoryRecord[]> {
    let info;
    try { info = await lstat(this.path); this.security.validateStructure(info); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') { await this.audit(operation, entries, signal); return []; } throw e; }
    const handle = await open(this.path, constants.O_RDONLY | (this.security.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
    try {
      const opened = await handle.stat(); this.security.validateStructure(opened);
      if (info.dev !== opened.dev || info.ino !== opened.ino) throw new ToolError('UNCONFIGURED');
      await this.audit(operation, [...entries, { path: this.path, info: opened }], signal);
      signal?.throwIfAborted();
      const after = await lstat(this.path); this.security.validateStructure(after);
      if (after.dev !== opened.dev || after.ino !== opened.ino) throw new ToolError('UNCONFIGURED');
      if (opened.size > 8 * 1024 * 1024) throw new ToolError('LIMIT');
      return await this.diagnostics.run(operation, 'snapshot', async () => {
        const records = snapshot.parse(JSON.parse(await handle.readFile('utf8'))).records;
        if (containsSecret(records)) throw new ToolError('INVALID_INPUT'); return records;
      }, signal);
    } finally { await handle.close(); }
  }
  async read(signal?: AbortSignal): Promise<MemoryRecord[]> {
    try {
      const entries = await this.diagnostics.run('read', 'directory', () => this.directory(signal), signal);
      return await this.diagnostics.run('read', 'snapshot', () => this.snapshot(entries, 'read', signal), signal);
    } catch (error) { if (signal?.aborted) throw new ToolError('TIMEOUT'); throw new ToolError('UNCONFIGURED'); }
  }
  async transaction<T>(change: (records: MemoryRecord[]) => T, signal?: AbortSignal): Promise<T> {
    const previous = queues.get(this.path) ?? Promise.resolve();
    const operation = (async () => {
      await this.diagnostics.run('write', 'queue', async () => { await previous.catch(() => undefined); signal?.throwIfAborted(); }, signal);
      const entries = await this.diagnostics.run('write', 'directory', () => this.directory(signal), signal);
      // Validate the parent before creating even the empty lock; no security cache.
      await this.audit('write', entries, signal);
      for (const entry of entries) entry.newlyCreated = false;
      const lockPath = this.path + '.lock'; let lock;
      try { lock = await this.diagnostics.run('write', 'lock', () => open(lockPath, 'wx', 0o600), signal); this.security.validateStructure(await lock.stat()); }
      catch (e) { await lock?.close(); if (lock) await unlink(lockPath).catch(() => undefined); throw new ToolError((e as NodeJS.ErrnoException).code === 'EEXIST' ? 'CONFLICT' : 'UNCONFIGURED'); }
      try {
        // Private, non-queued snapshot: no recursive transaction acquisition.
        // Audit every directory, lock and existing file in ONE Windows process.
        const records = await this.snapshot([...entries, { path: lockPath, info: await lock.stat() }], 'write', signal);
        signal?.throwIfAborted(); const result = change(records);
        if (result && typeof (result as { then?: unknown }).then === 'function') throw new ToolError('INVALID_INPUT');
        const serialized = await this.diagnostics.run('write', 'validation', async () => {
          const data = snapshot.parse({ version: 1, records }); if (containsSecret(data)) throw new ToolError('INVALID_INPUT');
          const text = JSON.stringify(data); if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new ToolError('LIMIT'); return text;
        }, signal);
        const temporary = `${this.path}.${randomUUID()}.tmp`; let handle;
        const fresh = async (): Promise<FileSecurityEntry[]> => {
          const paths = entries.map(entry => ({ ...entry, newlyCreated: false }));
          const checks: FileSecurityEntry[] = [];
          for (const entry of paths) checks.push({ ...entry, info: await lstat(entry.path) });
          checks.push({ path: temporary, info: await lstat(temporary) });
          try { checks.push({ path: this.path, info: await lstat(this.path) }); }
          catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
          return checks;
        };
        try {
          signal?.throwIfAborted(); handle = await open(temporary, 'wx', 0o600);
          const temporaryInfo = await handle.stat(); this.security.validateStructure(temporaryInfo);
          await this.audit('write', await fresh(), signal); // Never write bytes before private ACL validation.
          signal?.throwIfAborted();
          const checked = await lstat(temporary); this.security.validateStructure(await handle.stat());
          if (checked.dev !== temporaryInfo.dev || checked.ino !== temporaryInfo.ino) throw new ToolError('UNCONFIGURED');
          await handle.writeFile(serialized); await handle.sync(); await handle.close(); handle = undefined;
          await this.audit('write', await fresh(), signal); // Revalidate before atomic replacement; no ACL cache.
          signal?.throwIfAborted();
          const final = await lstat(temporary); this.security.validateStructure(final);
          if (final.dev !== temporaryInfo.dev || final.ino !== temporaryInfo.ino) throw new ToolError('UNCONFIGURED');
          signal?.throwIfAborted();
          await this.diagnostics.run('write', 'commit', () => rename(temporary, this.path), signal);
          return result;
        } finally { await handle?.close(); await unlink(temporary).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new ToolError('UNCONFIGURED'); }); }
      } finally { await lock.close(); await unlink(lockPath); }
    })();
    queues.set(this.path, operation);
    try { return await operation; }
    catch (e) { if (signal?.aborted) throw new ToolError('TIMEOUT'); throw e instanceof ToolError ? e : new ToolError('UNCONFIGURED'); }
    finally { if (queues.get(this.path) === operation) queues.delete(this.path); }
  }
}
