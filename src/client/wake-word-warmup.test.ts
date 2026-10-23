import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { prepareLiveWarm, verifyNewStream } from '../../experiments/wake-word/live-warmup.js';
import { PcmDetector } from '../../experiments/wake-word/core.js';
import { PcmTrace } from '../../experiments/wake-word/trace.js';
import { measurePcm, SignalTotals } from '../../experiments/wake-word/signal.js';
import { prepareWarm } from '../../experiments/wake-word/warmup.js';
import { runWarmupPairs } from '../../experiments/wake-word/warmup-pairs.js';
import { waitOfflineResult } from '../../experiments/wake-word/offline.js';
import { createWasmProfiler, profileExports } from '../../experiments/wake-word/profile.js';
import { replayPcm } from '../../experiments/wake-word/replay.js';
import { SpikeError } from '../../experiments/wake-word/core.js';

function fixture(mode = 'normal') {
  let time = 0, calls = 0, resets = 0, streamBlocks = 0, disposed = 0;
  const inputs: Float32Array[] = [];
  const module: any = { HEAPU8: new Uint8Array(32) };
  profileExports.forEach((n, i) => { module[n] = () => {
    if (i === 2) { calls++; time += mode === 'timeout' ? 10001 : 5; if (mode === 'engine-error') throw Error('private-engine'); }
  }; });
  const originals = profileExports.map(n => module[n]);
  const engine = { processAudio(pcm: Float32Array) {
    streamBlocks++; inputs.push(pcm); module[profileExports[0]]();
    if (mode !== 'no-decode') module[profileExports[2]]();
    return pcm.some(v => v > 0) ? [{ label: 'Atlas' }] : [];
  }, reset() { resets++; if (mode === 'reset-error') throw Error('private-reset'); streamBlocks = 0; }, dispose() { disposed++; } };
  return { module, engine, originals, inputs, now: () => time,
    counts: () => ({ calls, resets, streamBlocks, disposed }) };
}

test('warm preparation uses only bounded silence, restores hooks and resets stream before unchanged WAV replay with counters at zero', () => {
  const h = fixture(), result = prepareWarm(h.module, h.engine, h.now);
  assert.equal(result.syntheticBlocks, 2); assert.equal(result.decodeCalls, 2);
  assert.equal(h.counts().resets, 1); assert.equal(h.counts().streamBlocks, 0);
  assert.ok(h.inputs.every(pcm => pcm.length === 1600 && pcm.every(v => v === 0)));
  profileExports.forEach((n, i) => assert.equal(h.module[n], h.originals[i]));
  const real = new Float32Array(4800).fill(.25), original = real.slice();
  const p = createWasmProfiler(h.module, undefined, h.now), measured = p.wrapEngine(h.engine);
  const warm = replayPcm(real.slice(), measured), coldFixture = fixture();
  const cold = replayPcm(original.slice(), coldFixture.engine);
  assert.deepEqual(real, original); assert.equal(warm.pcmFnv1a32, cold.pcmFnv1a32);
  assert.deepEqual(warm.events, cold.events); assert.equal(warm.rawHits, cold.rawHits);
  assert.equal(warm.detections, cold.detections); assert.equal(warm.suppressedHits, cold.suppressedHits);
  assert.equal(p.snapshot().firstBlock.sequence, 0); assert.equal(p.snapshot().stages[3]!.calls, 3);
});

test('limits, timeout, reset failure and native failure restore all profiling exports without retrying reset', () => {
  for (const [mode, code] of [['no-decode','WARMUP_LIMIT'], ['timeout','WARMUP_TIMEOUT'], ['reset-error','WARMUP_RESET_FAILED'], ['engine-error','private-engine']]) {
    const h = fixture(mode);
    assert.throws(() => prepareWarm(h.module, h.engine, h.now), new RegExp(code!));
    assert.ok(h.inputs.length <= 30); assert.ok(h.inputs.every(pcm => pcm.every(v => v === 0)));
    profileExports.forEach((n, i) => assert.equal(h.module[n], h.originals[i]));
    assert.equal(h.counts().resets, mode === 'reset-error' ? 1 : 0);
    h.engine.dispose(); assert.equal(h.counts().disposed, 1);
  }
  assert.throws(() => prepareWarm({}, { processAudio: () => [], dispose() {} } as any), /WARMUP_UNSUPPORTED/);
});

function report(warm: boolean) {
  const wall = warm ? 100 : 600;
  const blocks = Array.from({ length: 207 }, (_, sequence) => { const decode = sequence < 63 || sequence === 91; const cost = sequence === 0 ? wall : decode ? 100 : 2;
    return { sequence, status: 'COMPLETED', wallMs: cost, decodeCalls: Number(decode), decodeWallMs: decode ? cost : 0, decodeMaxWallMs: decode ? cost : 0, rawHits: Number([27,46,91].includes(sequence)), heapBefore: 32, heapAfter: 32 }; });
  const total = blocks.reduce((sum, b) => sum + b.wallMs, 0);
  return { mode: 'LOCAL_WAV_WASM', wavSha256: 'a'.repeat(64), pcmSha256: 'b'.repeat(64), conversion: { downmix: false, resampled: false },
    configuration: { threshold: .25, score: 1, maxActivePaths: 4, cooldownMs: 1000, model: { revision: 'c'.repeat(40) }, keywords: [['atlas']] },
    result: { experimentMode: warm ? 'WARM' : 'COLD', preparation: warm ? { state: 'COMPLETED', decodeCalls: 2 } : { state: 'NOT_REQUESTED' },
      blocks: 207, processedSamples: 330411, pcmFnv1a32: 'f5a0e491', rawHits: 3, detections: 3, suppressedHits: 0, appendedSilenceSamples: 0,
      events: [27,46,91].map(block => ({ block, sampleOffset: block * 1600, sampleEnd: (block + 1) * 1600, rawHits: 1 })),
      processingTiming: { totalProcessingWallMs: total },
      wasmProfile: { firstDecode: { sequence: 0, wallMs: wall }, subsequentDecode: { maxWallMs: 100 }, maxBlockWallMs: wall,
        totalWallMs: total, withoutDecode: 143, stages: [{},{},{},{ calls: 64 }], recent: blocks } } };
}

test('runner executes exactly five sequential Cold/Warm pairs with fixed criteria and compact reports', async () => {
  let active = 0; const calls: boolean[] = [];
  const r = await runWarmupPairs('private-local-path', async (_path, warm) => {
    active++; assert.equal(active, 1); calls.push(warm); await Promise.resolve(); active--; return report(warm);
  });
  assert.deepEqual(calls, Array.from({ length: 10 }, (_, i) => i % 2 === 1));
  assert.equal(r.verdict, 'GO_FOR_EXPERIMENTAL_LIVE_TEST_ONLY'); assert.equal(r.pairs.length, 5);
  assert.doesNotMatch(JSON.stringify(r), /private-local-path|deviceId|transcript|pcm":/);
});

test('changed hashes, hits, config, reset readiness, excessive peaks and absent benefit block GO', async () => {
  for (const change of [
    (r: any) => { r.pcmSha256 = 'different'; },
    (r: any) => { r.result.events[0].block = 28; },
    (r: any) => { r.configuration.threshold = .05; },
    (r: any) => { r.result.preparation.state = 'FAILED'; },
    (r: any) => { r.result.wasmProfile.maxBlockWallMs = 300; },
    (r: any) => { r.result.wasmProfile.firstDecode.wallMs = 500; }
  ]) {
    const r = await runWarmupPairs('ignored', async (_path, warm) => { const value = report(warm); if (warm) change(value); return value; });
    assert.equal(r.verdict, 'NO_GO');
  }
});

test('runner stops on failure without retry or leaking native errors or filenames', async () => {
  let calls = 0;
  const r = await runWarmupPairs('private-file', async () => { calls++; throw Error('private-native'); });
  assert.equal(calls, 1); assert.equal(r.verdict, 'NO_GO'); assert.equal(r.code, 'WARMUP_EXPERIMENT_FAILED');
  assert.doesNotMatch(JSON.stringify(r), /private/);
});

test('parent watchdog detects a stuck warm-up and cleans listeners; result before reset confirmation fails closed', async () => {
  const worker = new EventEmitter();
  const waiting = waitOfflineResult(worker as any, true, 1000, 10);
  worker.emit('message', { phase: 'WARMUP_START' });
  await assert.rejects(waiting, (e: any) => e instanceof SpikeError && e.code === 'WARMUP_TIMEOUT');
  assert.equal(worker.eventNames().length, 0);
  const early = waitOfflineResult(worker as any, true, 1000, 10);
  worker.emit('message', { ok: true, result: {} });
  await assert.rejects(early, /OFFLINE_ENGINE_FAILED/); assert.equal(worker.eventNames().length, 0);
  const good = waitOfflineResult(worker as any, true, 1000, 10);
  worker.emit('message', { phase: 'WARMUP_START' }); worker.emit('message', { phase: 'WARMUP_END' });
  worker.emit('message', { ok: true, result: { state: 'DONE' } });
  assert.deepEqual(await good, { state: 'DONE' }); assert.equal(worker.eventNames().length, 0);
});


test('offline Warm worker confirms reset before WAV, restores hooks and releases model/PCM on success and reset error', async () => {
  const source = readFileSync(new URL('../../experiments/wake-word/offline-worker.mjs', import.meta.url), 'utf8')
    .replace(/^import .*\n/gm, '').replace('await import(pathToFileURL(workerData.runtimePath).href)', 'globalThis.__api');
  for (const mode of ['normal', 'reset-error']) {
    const h = fixture(mode), messages: any[] = [];
    h.module.FS = { writeFile() { assert.fail('No PCM persistence'); } };
    let closed = false;
    const pcm = new Float32Array(4800).fill(.25);
    const ctx = vm.createContext({ prepareWarm, createWasmProfiler, replayPcm, SpikeError, Float32Array, Uint8Array,
      console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
      workerData: { warm: true, threshold: .25, models: {}, pcm: pcm.buffer, runtimePath: 'private-path', keywords: [['atlas']] },
      parentPort: { postMessage(v: any) { messages.push(structuredClone(v)); }, close() { closed = true; } },
      __api: { initKWSModule: async () => h.module, createKeywordSpotter: (_m: any, config: any) => {
        assert.equal(config.keywords[0].threshold, .25); assert.equal(config.keywords[0].score, 1); assert.equal(config.maxActivePaths, 4);
        return h.engine;
      } } });
    await vm.runInContext('(async () => {' + source + '})()', ctx);
    assert.equal(messages[0].phase, 'WARMUP_START');
    if (mode === 'normal') {
      assert.equal(messages[1].phase, 'WARMUP_END'); assert.equal(messages[2].ok, true);
      assert.equal(messages[2].result.experimentMode, 'WARM');
      assert.equal(messages[2].result.wasmProfile.firstBlock.sequence, 0);
      assert.equal(messages[2].result.rawHits, 3);
    } else assert.equal(messages.at(-1).code, 'WARMUP_RESET_FAILED');
    assert.equal(h.counts().resets, 1); assert.equal(h.counts().disposed, 1); assert.equal(closed, true);
    assert.ok(pcm.every(v => v === 0)); assert.ok(h.module.HEAPU8.every((v: number) => v === 0));
    profileExports.forEach((n, i) => assert.equal(h.module[n], h.originals[i]));
    assert.doesNotMatch(JSON.stringify(messages), /private-path|private-reset/);
  }
});


test('Live reset verification observes a distinct created stream and old-stream destruction without exposing handles', () => {
  const h = fixture();
  h.module._SherpaOnnxCreateKeywordStream = () => 22;
  h.module._SherpaOnnxDestroyOnlineStream = () => {};
  const create = h.module._SherpaOnnxCreateKeywordStream, destroy = h.module._SherpaOnnxDestroyOnlineStream;
  const reset = h.engine.reset.bind(h.engine);
  h.engine.reset = () => { h.module._SherpaOnnxCreateKeywordStream(10); h.module._SherpaOnnxDestroyOnlineStream(11); reset(); };
  const report = prepareLiveWarm(h.module, h.engine);
  assert.equal(report.newStreamVerified, true); assert.ok(report.decodeCalls >= 2); assert.equal(h.counts().resets, 1);
  assert.equal(h.counts().streamBlocks, 0);
  assert.equal(h.module._SherpaOnnxCreateKeywordStream, create); assert.equal(h.module._SherpaOnnxDestroyOnlineStream, destroy);
  assert.doesNotMatch(JSON.stringify(report), /handle|pointer|device|pcm|transcript/i);
});

test('missing, reused or unverifiable stream reset fails closed and restores observer descriptors', () => {
  assert.throws(() => verifyNewStream({}, () => {}), /WARMUP_RESET_FAILED/);
  for (const scenario of ['same', 'missing', 'throw']) {
    const module: any = { _SherpaOnnxCreateKeywordStream: () => 11, _SherpaOnnxDestroyOnlineStream: () => {} };
    const descriptors = Object.getOwnPropertyDescriptors(module);
    assert.throws(() => verifyNewStream(module, () => {
      if (scenario === 'throw') throw Error('private');
      if (scenario !== 'missing') { module._SherpaOnnxCreateKeywordStream(); module._SherpaOnnxDestroyOnlineStream(11); }
    }));
    assert.deepEqual(Object.getOwnPropertyDescriptors(module), descriptors);
  }
});

test('actual Live Worker prepares before readiness, preserves live counter zero and cleans up failed reset', async () => {
  const source = readFileSync(new URL('../../experiments/wake-word/worker.mjs', import.meta.url), 'utf8')
    .replace(/^import .*\n/gm, '').replace("await import('/assets/runtime/core.js')", 'globalThis.__api');
  for (const valid of [true, false]) {
    const h = fixture(), messages: any[] = [];
    h.module.FS = { writeFile() {} };
    h.module._SherpaOnnxCreateKeywordStream = () => valid ? 22 : 11;
    h.module._SherpaOnnxDestroyOnlineStream = () => {};
    const reset = h.engine.reset.bind(h.engine);
    h.engine.reset = () => { h.module._SherpaOnnxCreateKeywordStream(10); h.module._SherpaOnnxDestroyOnlineStream(11); reset(); };
    const self = { onmessage: undefined as any, postMessage: (v: any) => messages.push(structuredClone(v)), close() {} };
    const ctx = vm.createContext({ self, prepareLiveWarm, createWasmProfiler, PcmDetector, SpikeError, PcmTrace, measurePcm, SignalTotals,
      Float32Array, Uint8Array, ArrayBuffer, performance,
      console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
      __api: { initKWSModule: async () => h.module, createKeywordSpotter: () => h.engine } });
    vm.runInContext(source, ctx);
    await self.onmessage({ data: { type: 'init', warm: true, threshold: .25, keywords: [['atlas']],
      files: Object.fromEntries(['encoder.onnx','decoder.onnx','joiner.onnx','tokens.txt'].map(n => ['model/' + n, new ArrayBuffer(1)])) } });
    assert.equal(messages[0].type, 'warmup-start');
    if (valid) {
      assert.equal(messages[1].type, 'ready'); assert.equal(messages[1].preparation.newStreamVerified, true);
      assert.equal(messages.some(m => m.type === 'processing'), false);
      const port = { onmessage: undefined as any, start() {}, close() {}, postMessage(v: any, transfer: Transferable[]) { structuredClone(v, { transfer }); } };
      await self.onmessage({ data: { type: 'connect', port } });
      port.onmessage({ data: { type: 'pcm', pcm: new Float32Array(1600).fill(.25).buffer, sequence: 0, sampleRate: 16000, channels: 1, outstanding: 1 } });
      const result = messages.find(m => m.type === 'processed');
      assert.equal(result.diagnostics.completed, 1); assert.equal(result.diagnostics.rawHits, 1);
      assert.equal(result.diagnostics.wasmProfile.firstDecode.sequence, 0);
      await self.onmessage({ data: { type: 'stop' } });
    } else {
      assert.equal(messages.at(-1).code, 'WARMUP_RESET_FAILED'); assert.equal(messages.some(m => m.type === 'ready'), false);
    }
    assert.equal(h.counts().disposed, 1); assert.ok(h.module.HEAPU8.every((v: number) => v === 0));
  }
});
