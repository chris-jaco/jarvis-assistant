import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const assetPath = resolve(root, 'public/brand/atlas-tray.ico');
const applicationAssetPath = resolve(root, 'public/brand/atlas-app.ico');

function icoDimensions(bytes: Buffer): number[] {
  const count = bytes.readUInt16LE(4);
  return Array.from({ length: count }, (_, index) => {
    const width = bytes[6 + index * 16];
    return width === 0 ? 256 : width!;
  });
}

test('official Windows Tray asset is a bounded five-resolution ICO', () => {
  const bytes = readFileSync(assetPath);
  assert.equal(bytes.readUInt16LE(0), 0, 'ICO reserved header');
  assert.equal(bytes.readUInt16LE(2), 1, 'ICO image type');
  assert.equal(bytes.readUInt16LE(4), 5, 'ICO entry count');

  const dimensions: number[] = [];
  const ranges: Array<[number, number]> = [];
  for (let index = 0; index < 5; index++) {
    const entry = 6 + index * 16;
    const width = bytes[entry] === 0 ? 256 : bytes[entry]!;
    const height = bytes[entry + 1] === 0 ? 256 : bytes[entry + 1]!;
    const size = bytes.readUInt32LE(entry + 8);
    const offset = bytes.readUInt32LE(entry + 12);
    assert.equal(width, height, 'Tray representation must remain square');
    assert.ok(size > 0 && offset >= 86 && offset + size <= bytes.length, 'ICO entry must remain inside the file');
    dimensions.push(width);
    ranges.push([offset, offset + size]);
  }

  assert.deepEqual([...dimensions].sort((left, right) => left - right), [16, 20, 24, 32, 48]);
  assert.equal(new Set(ranges.map(range => range.join(':'))).size, 5, 'ICO entries must be distinct');
});

test('Electron Main resolves the official ICO instead of the provisional legacy PNG', () => {
  const main = readFileSync(resolve(root, 'src/desktop/main.ts'), 'utf8');
  assert.match(main, /public\/brand\/atlas-tray\.ico/);
  assert.match(main, /public\/brand\/atlas-app\.ico/);
  assert.match(main, /icon: applicationIcon/);
  assert.doesNotMatch(main, /atlas_blanco\.png/);
});

test('official application icon contains the complete Windows resolution set', () => {
  const bytes = readFileSync(applicationAssetPath);
  assert.equal(bytes.readUInt16LE(0), 0, 'ICO reserved header');
  assert.equal(bytes.readUInt16LE(2), 1, 'ICO image type');
  assert.deepEqual(icoDimensions(bytes), [256, 128, 64, 48, 32, 24, 20, 16]);
});
