import { access, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { listPackage } from '@electron/asar';

const root = resolve(process.argv[2] ?? 'release/win-unpacked');
const archive = join(root, 'resources', 'app.asar');
const requiredFiles = [
  'Atlas.exe',
  'resources/app.asar'
];
const requiredArchiveEntries = [
  '/package.json',
  '/dist/desktop-build/desktop/main.js',
  '/dist/server/server/index.js',
  '/dist/client/index.html',
  '/dist/desktop-preload/preload.cjs',
  '/dist/desktop-credential-setup/index.html',
  '/dist/desktop-credential-setup/preload.cjs',
  '/public/brand/atlas-app.ico',
  '/public/brand/atlas-tray.ico',
  '/node_modules/zod/package.json',
  '/node_modules/@openai/agents-core/package.json',
  '/node_modules/playwright/package.json'
];
const forbidden = /(?:^|\/)(?:\.env(?:\.|$)|\.local(?:\/|$)|credentials\.v1\.json$|journal\.json$|[^/]*google-tokens[^/]*\.json$)/i;

for (const relative of requiredFiles) await access(join(root, relative));
const entries = new Set(listPackage(archive));
for (const entry of requiredArchiveEntries) {
  if (!entries.has(entry)) throw new Error(`DESKTOP_PACKAGE_REQUIRED_FILE_MISSING:${entry}`);
}
for (const entry of entries) {
  if (forbidden.test(entry)) throw new Error(`DESKTOP_PACKAGE_PRIVATE_FILE_PRESENT:${basename(entry)}`);
}
if ([...entries].some(entry => entry.startsWith('/dist/extension/'))) {
  throw new Error('DESKTOP_PACKAGE_EXTENSION_MUST_REMAIN_EXTERNAL');
}

async function size(path) {
  const info = await stat(path);
  if (info.isFile()) return info.size;
  let bytes = 0;
  for (const entry of await readdir(path)) bytes += await size(join(path, entry));
  return bytes;
}

const bytes = await size(root);
console.log(JSON.stringify({ status: 'OK', artifact: basename(root), bytes, archiveEntries: entries.size }));
