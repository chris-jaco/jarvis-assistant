import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve, parse, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TokenFileSecurity } from '../tools/adapters/token-security.js';
import { ToolError } from '../tools/types.js';
import { recordSchema } from './types.js';
import type { MemoryRecord, MemoryStore } from './types.js';
import { containsSecret } from './privacy.js';
const snapshot = z.object({ version: z.literal(1), records: z.array(recordSchema).max(2000) }).strict();
const queues = new Map<string, Promise<unknown>>();
export class PrivateJsonMemoryStore implements MemoryStore {
  readonly path: string;
  constructor(path = '.local/memory/memories.json', private readonly security = new TokenFileSecurity()) {
    this.path = resolve(path);
    // Deliberately keep all V0.4 data in ignored .local, including custom paths.
    const local = resolve('.local'); const within = relative(local, this.path);
    if (within.startsWith('..' + sep) || within === '..' || !within || resolve(local, within) !== this.path || parse(within).root) throw new Error('MEMORY_PATH must be inside .local');
  }
  private async directory(): Promise<void> {
    // Check each existing ancestor before recursive mkdir; never follow a symlink.
    let cursor = dirname(this.path);
    const ancestors: string[] = [];
    while (cursor !== parse(cursor).root) { ancestors.unshift(cursor); cursor = dirname(cursor); }
    for (const path of ancestors) {
      try { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new ToolError('UNCONFIGURED'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    const local = resolve('.local');
    const directories = [local]; let current = local;
    for (const component of relative(local, dirname(this.path)).split(sep).filter(Boolean)) { current = resolve(current, component); directories.push(current); }
    for (const dir of directories) {
      let created = false;
      try { await mkdir(dir, { mode: 0o700 }); created = true; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      await this.security.validate(dir, await lstat(dir), true, created);
    }
  }
  async read(): Promise<MemoryRecord[]> {
    try {
      await this.directory();
      try { await this.security.validate(this.path, await lstat(this.path)); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
      const handle = await open(this.path, constants.O_RDONLY | (this.security.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
      try {
        const info = await handle.stat(); await this.security.validate(this.path, info);
        if (info.size > 8 * 1024 * 1024) throw new ToolError('LIMIT');
        const records = snapshot.parse(JSON.parse(await handle.readFile('utf8'))).records;
        if (containsSecret(records)) throw new ToolError('INVALID_INPUT');
        return records;
      } finally { await handle.close(); }
    } catch { throw new ToolError('UNCONFIGURED'); }
  }
  async transaction<T>(change: (records: MemoryRecord[]) => T): Promise<T> {
    const previous = queues.get(this.path) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      await this.directory();
      const lockPath = this.path + '.lock'; let lock;
      try { lock = await open(lockPath, 'wx', 0o600); await this.security.validate(lockPath, await lock.stat()); }
      catch (e) { await lock?.close(); if (lock) await unlink(lockPath).catch(() => undefined); throw new ToolError((e as NodeJS.ErrnoException).code === 'EEXIST' ? 'CONFLICT' : 'UNCONFIGURED'); }
      try {
      const records = await this.read(); const result = change(records);
      const data = snapshot.parse({ version: 1, records });
      if (containsSecret(data)) throw new ToolError('INVALID_INPUT');
      const serialized = JSON.stringify(data);
      if (Buffer.byteLength(serialized) > 8 * 1024 * 1024) throw new ToolError('LIMIT');
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      let handle;
      try {
        handle = await open(temporary, 'wx', 0o600);
        await this.security.validate(temporary, await handle.stat());
        await handle.writeFile(serialized); await handle.sync(); await handle.close(); handle = undefined;
        // Revalidate destination before replacement. The directory is private.
        try { await this.security.validate(this.path, await lstat(this.path)); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        await rename(temporary, this.path);
      } finally { await handle?.close(); await unlink(temporary).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new ToolError('UNCONFIGURED'); }); }
      return result;
      } finally { await lock.close(); await unlink(lockPath); }
    });
    queues.set(this.path, operation);
    try { return await operation; }
    catch (e) { throw e instanceof ToolError ? e : new ToolError('UNCONFIGURED'); }
    finally { if (queues.get(this.path) === operation) queues.delete(this.path); }
  }
}
