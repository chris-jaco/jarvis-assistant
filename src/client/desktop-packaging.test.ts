import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const packageDocument = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

test('Windows dir package has stable identity, ASAR, official icon and no installer target', () => {
  assert.equal(packageDocument.main, 'dist/desktop-build/desktop/main.js');
  assert.equal(packageDocument.build.appId, 'com.atlas.desktop');
  assert.equal(packageDocument.build.productName, 'Atlas');
  assert.equal(packageDocument.build.asar, true);
  assert.deepEqual(packageDocument.build.win.target, ['dir']);
  assert.equal(packageDocument.build.win.icon, 'public/brand/atlas-app.ico');
  assert.doesNotMatch(JSON.stringify(packageDocument.build), /nsis|publish|sign|updat/i);
});

test('package manifest includes each runtime boundary and excludes private development data', () => {
  const files = packageDocument.build.files as string[];
  for (const required of [
    'dist/client/**/*', 'dist/server/**/*', 'dist/desktop-build/**/*',
    'dist/desktop-preload/**/*', 'dist/desktop-credential-setup/**/*',
    'public/brand/**/*', 'node_modules/**/*', 'package.json'
  ]) assert.ok(files.includes(required), required);
  for (const excluded of ['!**/.env*', '!**/.local/**', '!**/*google-tokens*.json', '!**/credentials.v1.json', '!**/journal.json']) {
    assert.ok(files.includes(excluded), excluded);
  }
  assert.equal(files.some(value => value.includes('dist/extension')), false);
});

test('packaged Core uses the Electron UtilityProcess and private bootstrap without global Node', () => {
  const main = readFileSync(resolve(root, 'src/desktop/main.ts'), 'utf8');
  const supervisor = readFileSync(resolve(root, 'src/desktop/backend-supervisor.ts'), 'utf8');
  assert.match(main, /utilityProcess\.fork/);
  assert.match(main, /runtime: 'utility'/);
  assert.match(supervisor, /else delete env\.ELECTRON_RUN_AS_NODE/);
  assert.match(main, /withOpenAIKey/);
  assert.doesNotMatch(main, /child_process|executable:\s*['"]node(?:\.exe)?['"]/i);
});

test('package verifier checks runtime dependencies, setup assets and private-file absence', () => {
  const verifier = readFileSync(resolve(root, 'scripts/verify-desktop-package.mjs'), 'utf8');
  for (const expected of [
    'dist/server/server/index.js', 'dist/desktop-preload/preload.cjs',
    'dist/desktop-credential-setup/index.html', 'public/brand/atlas-app.ico',
    'node_modules/zod/package.json', 'node_modules/playwright/package.json'
  ]) assert.match(verifier, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(verifier, /DESKTOP_PACKAGE_PRIVATE_FILE_PRESENT/);
  assert.match(verifier, /DESKTOP_PACKAGE_EXTENSION_MUST_REMAIN_EXTERNAL/);
});
