import { build } from 'vite';
import { mkdir, copyFile } from 'node:fs/promises';
const outDir = 'dist/extension';
await build({ configFile: false, publicDir: false, build: { outDir, emptyOutDir: true, lib: { entry: { 'service-worker': 'extension/src/service-worker.ts', popup: 'extension/src/popup.ts' }, formats: ['es'], fileName: (_format, name) => `${name}.js` }, minify: false } });
await build({ configFile: false, publicDir: false, build: { outDir, emptyOutDir: false, lib: { entry: 'extension/src/content.ts', name: 'AtlasContent', formats: ['iife'], fileName: () => 'content.js' }, minify: false } });
await mkdir(outDir, { recursive: true });
await copyFile('extension/manifest.json', `${outDir}/manifest.json`); await copyFile('extension/popup.html', `${outDir}/popup.html`);
