import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, createLogger } from 'vite';
import config from '../../vite.config.js';

test('Atlas dev dependency scan discovers application imports without scanning the extension popup source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-dev-scan-'));
  await mkdir(join(root, 'extension'));
  await mkdir(join(root, 'node_modules/fixture-dependency'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<script type="module" src="/main.ts"></script>');
  await writeFile(join(root, 'main.ts'), 'import { value } from "fixture-dependency"; console.log(value);');
  await writeFile(join(root, 'extension/popup.html'), '<script type="module" src="popup.js"></script>');
  await writeFile(join(root, 'node_modules/fixture-dependency/package.json'), JSON.stringify({ name: 'fixture-dependency', version: '1.0.0', type: 'module', exports: './index.js' }));
  await writeFile(join(root, 'node_modules/fixture-dependency/index.js'), 'export const value = 1;');
  const errors: string[] = [];
  const logger = createLogger('silent'); logger.error = message => { errors.push(message); };
  const server = await createServer({ ...config, root, configFile: false, customLogger: logger,
    optimizeDeps: { ...config.optimizeDeps, force: true }, server: { ...config.server, port: 0, host: '127.0.0.1', hmr: false }
  });
  try {
    await server.listen();
    const optimizer = server.environments.client!.depsOptimizer;
    assert.ok(optimizer, 'Dependency discovery must stay enabled');
    await optimizer.init();
    await optimizer.scanProcessing;
    const dependencies = { ...optimizer.metadata.discovered, ...optimizer.metadata.optimized };
    assert.ok(dependencies['fixture-dependency'], 'Real application dependencies are still scanned');
    assert.ok(!dependencies['popup.js'], 'Extension source HTML must not be a dev entrypoint');
    assert.ok(!Object.keys(server.watcher.getWatched()).some(path => /\/extension(?:\/|$)/.test(path.replaceAll('\\', '/'))));
    assert.deepEqual(errors, []);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
