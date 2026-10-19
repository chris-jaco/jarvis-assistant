import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { checkManifest, verifyBytes, PcmDetector, ResourceScope, requiredAssets } from '../../experiments/wake-word/core.js';
import type { Manifest } from '../../experiments/wake-word/core.js';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture(): Manifest {
  return { schema: 1,
    model: { repository: 'jguerrisi/sherpa-onnx-kws-zipformer-es-3M-2026-08-08', revision: 'b55eae7' + '0'.repeat(33), license: 'UNVERIFIED_PERSONAL_EVALUATION_ONLY' },
    runtime: { package: '@sherpaw/kws', version: '0.3.0' },
    files: requiredAssets.map(name => ({ name, sha256: digest(new Uint8Array([1])), bytes: 1 })), keywords: [['▁AT', 'LAS']]
  };
}
test('missing manifest/model fails closed', () => {
  assert.throws(() => checkManifest(undefined), /MANIFEST_INVALID/);
  const missing = fixture(); missing.files.pop(); assert.throws(() => checkManifest(missing), /MODEL_MISSING/);
});
test('manifest pins Spanish identity, runtime, revision and personal-only license status', () => {
  checkManifest(fixture());
  const other = fixture(); other.model.repository = 'english-substitute'; assert.throws(() => checkManifest(other));
  const moving = fixture(); moving.model.revision = 'main'; assert.throws(() => checkManifest(moving));
});
test('corrupt bytes, wrong size and invalid WASM fail before inference', async () => {
  const asset = fixture().files[0]!;
  await assert.rejects(verifyBytes(asset, new Uint8Array([2])), /ASSET_CORRUPT/);
  await assert.rejects(verifyBytes(asset, new Uint8Array([1, 1])), /ASSET_CORRUPT/);
  await assert.rejects(verifyBytes({ ...asset, name: 'runtime/x.wasm' }, new Uint8Array([1])), /WASM_INVALID/);
  await verifyBytes(asset, new Uint8Array([1]));
});
test('initialized PCM detector emits a bounded event and wipes input; simulated engine is not acoustic acceptance', () => {
  const input = new Float32Array([.5, -.5]);
  const d = new PcmDetector({ processAudio: () => [{ label: 'Atlas' }], dispose() {} }, () => 100);
  assert.deepEqual(d.process(input), { detected: true, engineMs: 0, pcmMs: .125 });
  assert.deepEqual([...input], [0, 0]); d.stop();
});
test('invalid PCM never reaches inference', () => {
  let calls = 0;
  const d = new PcmDetector({ processAudio() { calls++; return []; }, dispose() {} });
  for (const input of [new Float32Array(), new Float32Array([NaN]), new Float32Array([Infinity]), new Float32Array([2]), new Float32Array(16001)]) {
    assert.throws(() => d.process(input), /AUDIO_INVALID/);
  }
  assert.throws(() => d.process(new Float32Array([0]), 48000), /AUDIO_INVALID/);
  assert.equal(calls, 0); d.stop();
});
test('repeated hits are coalesced during cooldown and later hits remain available', () => {
  let clock = 0;
  const d = new PcmDetector({ processAudio: () => [{ label: 'Atlas' }, { label: 'Atlas' }], dispose() {} }, () => clock);
  assert.equal(d.process(new Float32Array([0])).detected, true);
  clock = 500; assert.equal(d.process(new Float32Array([0])).detected, false);
  clock = 1100; assert.equal(d.process(new Float32Array([0])).detected, true); d.stop();
});
test('stop frees engine once and refuses subsequent audio', () => {
  let freed = 0;
  const d = new PcmDetector({ processAudio: () => [], dispose() { freed++; } });
  d.stop(); d.stop(); assert.equal(freed, 1);
  assert.throws(() => d.process(new Float32Array([0])), /DETECTOR_STOPPED/);
});
test('errors are sanitized and all resource release callbacks run despite failure', async () => {
  const privateText = 'private-path-or-credential';
  const d = new PcmDetector({ processAudio() { throw Error(privateText); }, dispose() { throw Error(privateText); } });
  assert.throws(() => d.process(new Float32Array([0])), error => error instanceof Error && error.message === 'ENGINE_FAILED');
  assert.throws(() => d.stop(), /RELEASE_FAILED/);
  const scope = new ResourceScope(), released: string[] = [];
  scope.add(() => { released.push('worker'); }); scope.add(() => { released.push('context'); throw Error(privateText); }); scope.add(() => { released.push('tracks'); });
  await assert.rejects(scope.stop(), /RELEASE_FAILED/); await scope.stop();
  assert.deepEqual(released, ['tracks', 'context', 'worker']);
});
test('listening path contains no PCM persistence or external network; production never imports spike', () => {
  const root = resolve(import.meta.dirname, '../..');
  const browser = readFileSync(resolve(root, 'experiments/wake-word/browser.ts'), 'utf8');
  const worker = readFileSync(resolve(root, 'experiments/wake-word/worker.mjs'), 'utf8');
  const worklet = readFileSync(resolve(root, 'experiments/wake-word/pcm-worklet.js'), 'utf8');
  for (const source of [browser, worker, worklet]) assert.doesNotMatch(source, /localStorage|indexedDB|MediaRecorder|toWav|createObjectURL|sendBeacon|https:\/\//);
  assert.match(worker, /blockNetwork\(\);/);
  assert.match(browser, /restoreNetwork = blockNetwork\(\)/);
  assert.match(browser, /capture\.getTracks\(\)\.forEach\(t => t\.stop\(\)\)/);
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  assert.equal(manifest.build.files.some((p: string) => p.includes('experiments') || p.includes('wake-word-spike')), false);
  for (const file of ['src/desktop/main.ts', 'src/provider/openai.ts', 'src/desktop/lifecycle-runtime.ts']) assert.doesNotMatch(readFileSync(resolve(root, file), 'utf8'), /experiments\/wake-word/);
});
test('loopback harness rejects uploads and never serves arbitrary disk paths', async () => {
  const { startServer } = await import(new URL('../../experiments/wake-word/server.mjs', import.meta.url).href);
  const { server, url } = await startServer(0);
  try {
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(url + '/pcm', { method: 'POST', body: 'not-a-recording' })).status, 403);
    assert.equal((await fetch(url + '/package.json')).status, 404);
    assert.equal((await fetch(url, { headers: { Origin: 'https://outside.invalid' } })).status, 403);
    assert.equal((await fetch(url)).headers.get('cache-control'), 'no-store');
  } finally { await new Promise<void>(r => server.close(r)); }
});
test('server refuses missing or hash-corrupt local assets', async () => {
  const { loadAssets } = await import(new URL('../../experiments/wake-word/server.mjs', import.meta.url).href);
  const dir = await mkdtemp(resolve(tmpdir(), 'atlas-wake-'));
  try {
    await assert.rejects(loadAssets(dir));
    const m = fixture(); await writeFile(resolve(dir, 'manifest.json'), JSON.stringify(m));
    for (const asset of m.files) { await mkdir(resolve(dir, asset.name, '..'), { recursive: true }); await writeFile(resolve(dir, asset.name), new Uint8Array([2])); }
    await assert.rejects(loadAssets(dir), /ASSET_CORRUPT/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('preparation rejects malformed ONNX and encodes simple SentencePiece BPE without Python', async () => {
  const { checkOnnx, keywordTokens } = await import(new URL('../../experiments/wake-word/prepare.mjs', import.meta.url).href);
  assert.throws(() => checkOnnx(new Uint8Array([0])), /PROTO_INVALID/);
  assert.throws(() => checkOnnx(new Uint8Array([8, 1])), /ONNX_INVALID/);
  checkOnnx(new Uint8Array([8, 1, 58, 1, 0]));
  // Synthetic protobuf fixture exercises encoding, not real model compatibility or recognition.
  const piece = (name: string, score: number) => { const text = Buffer.from(name); const s = Buffer.alloc(4); s.writeFloatLE(score); return Buffer.concat([Buffer.from([10, text.length]), text, Buffer.from([21]), s]); };
  const p = piece('▁atlas', 1);
  const model = Buffer.concat([Buffer.from([10, p.length]), p]);
  assert.deepEqual(keywordTokens(model, '▁atlas 1', 'atlas'), ['▁atlas']);
  assert.throws(() => keywordTokens(model, '▁atlas 1', 'unknown'), /KEYWORD_UNSUPPORTED/);
});

test('worker blocks network APIs after local initialization and clears heap on stop', async () => {
  // Execute the actual worker protocol with an injected engine; this is not model/acoustic validation.
  const root = resolve(import.meta.dirname, '../..');
  const source = readFileSync(resolve(root, 'experiments/wake-word/worker.mjs'), 'utf8')
    .replace(/^import .*\n/, '')
    .replace("await import('/assets/runtime/core.js')", 'globalThis.__api');
  const messages: unknown[] = []; let network = 0, disposed = 0, closed = false;
  const heap = new Uint8Array([1, 2, 3]);
  const self: { onmessage?: (e: unknown) => Promise<void>; postMessage(v: unknown): void; close(): void } = {
    postMessage: v => messages.push(v), close: () => { closed = true; }
  };
  const { SpikeError } = await import('../../experiments/wake-word/core.js');
  const context = vm.createContext({
    self, console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    PcmDetector, SpikeError, Uint8Array, Float32Array, performance,
    fetch() { network++; },
    __api: {
      initKWSModule: async () => ({ HEAPU8: heap, FS: { writeFile() {} } }),
      createKeywordSpotter: () => ({ processAudio: () => [], dispose() { disposed++; } })
    }
  });
  vm.runInContext(source, context);
  await self.onmessage!({ data: { type: 'init', keywords: [['A']], threshold: .25, files: Object.fromEntries(['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'].map(n => [`model/${n}`, new ArrayBuffer(1)])) } });
  assert.equal((messages[0] as { type: string }).type, 'ready');
  for (const expression of ["fetch('https://outside.invalid')", 'new XMLHttpRequest()', 'new WebSocket("wss://outside.invalid")']) {
    assert.throws(() => vm.runInContext(expression, context), /NETWORK_DISABLED/);
  }
  assert.equal(network, 0);
  await self.onmessage!({ data: { type: 'stop' } });
  assert.equal(disposed, 1); assert.equal(closed, true); assert.deepEqual([...heap], [0, 0, 0]);
});

test('AudioWorklet bounds PCM backlog and stops rather than storing continuous audio', () => {
  let Processor: any;
  const messages: { type: string; pcm?: ArrayBuffer }[] = [];
  const context = vm.createContext({
    Float32Array,
    AudioWorkletProcessor: class { port = { onmessage: undefined, postMessage: (v: { type: string }) => messages.push(v) }; },
    registerProcessor: (_name: string, processor: unknown) => { Processor = processor; }
  });
  vm.runInContext(readFileSync(resolve(import.meta.dirname, '../../experiments/wake-word/pcm-worklet.js'), 'utf8'), context);
  const processor = new Processor();
  assert.equal(processor.process([[new Float32Array(1600)]]), true);
  assert.equal(messages[0]!.type, 'pcm');
  assert.equal(processor.process([[new Float32Array(1600)]]), false);
  assert.equal(messages[1]!.type, 'overrun');
  assert.equal(processor.buffer.every((v: number) => v === 0), true);
  assert.equal(processor.active, false);
});
