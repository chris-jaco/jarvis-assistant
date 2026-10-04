import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateRequestPath } from './private-paths.js';
test('private storage/credential paths are blocked before Vite, including @fs, encoded separators and Windows case', () => {
  for (const path of ['/.local/memory/memories.json', '/@fs/C:/repo/.LOCAL/memory/memories.json', '/@fs/workspace/repo/.local/google-tokens.json', '/%2elocal/memory/memories.json', '/%252elocal%252fmemory%252fmemories.json', '/.local%5Cmemory%5Cmemories.json', '/.env', '/.env.local', '/.git/config', '/custom/g_account.json', '/custom/google-tokens.json', '/invalid%']) assert.equal(privateRequestPath(path), true, path);
  for (const path of ['/', '/src/core/personality.ts', '/api/tools/memory-turn', '/api/tools/memory-context', '/src/memory/privacy.ts']) assert.equal(privateRequestPath(path), false, path);
});
