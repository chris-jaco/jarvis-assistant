import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import { createServer as createHttpServer } from 'node:http';
import config from '../../vite.config.js';

test('actual Vite dev watcher excludes private browser profiles while still watching source files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-watcher-'));
  const profile = join(root, '.local/browser-profile/Default/Sessions');
  await mkdir(profile, { recursive: true }); await writeFile(join(profile, 'Session_1'), 'fixture');
  const hmrServer = createHttpServer();
  const server = await createServer({ ...config, configFile: false, root, server: { ...config.server, middlewareMode: true, hmr: { server: hmrServer } }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const deadline = Date.now() + 5000;
    while (!Object.keys(server.watcher.getWatched()).includes(root)) {
      if (Date.now() > deadline) throw new Error('Watcher initialization timed out');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(!Object.keys(server.watcher.getWatched()).some(path => path.includes('.local')));
    const events: string[] = []; server.watcher.on('all', (_event, path) => events.push(path));
    const source = join(root, 'source.ts');
    const sourceSeen = new Promise<void>(resolve => { server.watcher.on('add', path => { if (path === source) resolve(); }); });
    await writeFile(join(profile, 'Session_2'), 'fixture'); await writeFile(source, 'export const fixture = true;');
    await Promise.race([sourceSeen, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Source watcher did not fire')), 5000); timer.unref(); })]);
    assert.ok(!events.some(path => path.includes('.local')));
    assert.ok(!Object.keys(server.watcher.getWatched()).some(path => path.includes('.local')));
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
