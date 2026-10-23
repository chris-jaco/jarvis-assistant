import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { PcmDetector, SpikeError } from '../../experiments/wake-word/core.js';
import { PcmTrace, canonicalBytes, compareRuns, matchWindows } from '../../experiments/wake-word/trace.js';
import { measurePcm, SignalTotals, compareSignalLevels } from '../../experiments/wake-word/signal.js';
import { replayPcm } from '../../experiments/wake-word/replay.js';

function sourceHarness(pcm?: Float32Array) {
  let Processor: any;
  const controls: any[] = [], queue: any[] = [];
  const context = vm.createContext({ createWasmProfiler: () => ({ wrapEngine: (e: any) => e, snapshot: () => ({}), restore() {} }), Float32Array, ArrayBuffer, sampleRate: 16000,
    AudioWorkletProcessor: class { port = { onmessage: undefined, postMessage: (v: unknown) => controls.push(structuredClone(v)) }; },
    registerProcessor: (_name: string, p: any) => { Processor = p; }
  });
  vm.runInContext(readFileSync(new URL('../../experiments/wake-word/pcm-worklet.js', import.meta.url), 'utf8'), context);
  const p = new Processor();
  const port = { onmessage: undefined as any, start() {}, close() {},
    postMessage(v: any, transfer: Transferable[]) { queue.push(structuredClone(v, { transfer })); } };
  p.port.onmessage({ data: { type: 'connect', port } });
  if (pcm) { p.port.onmessage({ data: structuredClone({ type: 'wav-source', pcm: pcm.buffer }, { transfer: [pcm.buffer] }) }); p.port.onmessage({ data: 'wav-start' }); }
  return { p, port, controls, queue };
}
const engine = () => ({ processAudio: (pcm: Float32Array) => pcm.some(v => v === .25) ? [{ label: 'Atlas' }] : [], dispose() {} });
async function workerHarness(h: ReturnType<typeof sourceHarness>) {
  const messages: any[] = [];
  const source = readFileSync(new URL('../../experiments/wake-word/worker.mjs', import.meta.url), 'utf8')
    .replace(/^import .*\n/gm, '').replace("await import('/assets/runtime/core.js')", 'globalThis.__api');
  const self = { onmessage: undefined as any, postMessage: (v: unknown) => messages.push(structuredClone(v)), close() {} };
  let port: any;
  const context = vm.createContext({ createWasmProfiler: () => ({ wrapEngine: (e: any) => e, snapshot: () => ({}), restore() {} }), self, Float32Array, Uint8Array, ArrayBuffer, performance, PcmDetector, SpikeError, PcmTrace, measurePcm, SignalTotals,
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    __api: { initKWSModule: async () => ({ HEAPU8: new Uint8Array(16), FS: { writeFile() {} } }), createKeywordSpotter: engine }
  });
  vm.runInContext(source, context);
  await self.onmessage({ data: { type: 'init', files: Object.fromEntries(['encoder.onnx','decoder.onnx','joiner.onnx','tokens.txt'].map(n => ['model/' + n, new ArrayBuffer(1)])), keywords: [['▁a','t','la','s']], threshold: .05 } });
  port = { onmessage: undefined as any, start() {}, close() {}, postMessage(v: any, transfer: Transferable[]) { h.port.onmessage({ data: structuredClone(v, { transfer }) }); } };
  await self.onmessage({ data: { type: 'connect', port, mode: 'wav-test' } });
  return { messages, drain() { while (h.queue.length) port.onmessage({ data: h.queue.shift() }); }, stop: () => self.onmessage({ data: { type: 'stop' } }) };
}

test('same 20.65s synthetic PCM traverses real Worklet/Worker protocol with 207 blocks, exact tail and identical offline raw hit positions', async () => {
  // Injected deterministic engine validates transport only; it is not acoustic acceptance.
  const pcm = new Float32Array(330400).fill(.01);
  for (const i of [4000, 50000, 96000, 145000, 200000, 280000]) pcm[i] = .25;
  const offline = replayPcm(pcm.slice(), engine());
  const h = sourceHarness(pcm.slice()), owned = h.p.wav;
  const w = await workerHarness(h);
  for (let i = 0; i < 3000 && h.p.active; i++) { h.p.process([], [[new Float32Array(128)]]); w.drain(); }
  const processed = w.messages.filter(m => m.type === 'processed');
  const last = processed.at(-1).diagnostics;
  assert.equal(processed.length, 207); assert.equal(last.signal.lastBlock.blockLength, 800);
  assert.equal(last.rawHits, 6); assert.equal(last.trace.processedSamples, 330400);
  assert.equal(last.trace.pcmFnv1a32, offline.pcmFnv1a32);
  assert.deepEqual(last.trace.events, offline.events); assert.equal(last.signal.aggregate.rms, offline.signal.rms);
  assert.equal(last.signal.aggregate.peak, offline.signal.peak);
  assert.equal(h.controls.filter(m => m.type === 'wav-complete').length, 1);
  assert.equal(h.controls.at(-1).diagnostics.outstanding, 0);
  assert.ok(owned.every((v: number) => v === 0)); assert.equal(h.p.active, false);
  assert.ok(!h.controls.some(m => m.type === 'overrun')); await w.stop();
});

test('WAV completion waits for all recycled buffers; no silence padding or early success', () => {
  const h = sourceHarness(new Float32Array(1700).fill(.2));
  for (let i = 0; i < 20; i++) h.p.process([], [[new Float32Array(128)]]);
  assert.deepEqual(h.queue.map(m => m.validSamples), [1600, 100]);
  assert.equal(h.controls.some(m => m.type === 'wav-complete'), false);
  for (const m of h.queue) h.port.onmessage({ data: { type: 'recycle', sequence: m.sequence, pcm: m.pcm } });
  assert.equal(h.controls.at(-1).type, 'wav-complete'); assert.equal(h.controls.at(-1).samples, 1700);
});

test('WAV mode pauses its cursor with a full pool; microphone keeps overrun and partial-block policies', () => {
  const h = sourceHarness(new Float32Array(16000));
  for (let i = 0; i < 70 && h.p.active; i++) h.p.process([], [[new Float32Array(128)]]);
  assert.equal(h.p.active, true); assert.equal(h.p.pending.size, 4);
  assert.equal(h.p.wavOffset, 6400); assert.ok(h.p.snapshot().wavBackpressure.waitQuanta > 0);
  const owned = h.p.wav; h.p.port.onmessage({ data: 'stop' }); assert.ok(owned.every((v: number) => v === 0));
  assert.equal(h.controls.some(m => m.type === 'wav-complete'), false);
  const mic = sourceHarness(); mic.p.process([[new Float32Array(1700)]]);
  assert.equal(mic.queue.length, 1); assert.equal(mic.p.offset, 100);
  mic.p.port.onmessage({ data: 'stop' }); assert.equal(mic.queue.length, 1);
  const busyMic = sourceHarness();
  for (let i = 0; i < 5; i++) busyMic.p.process([[new Float32Array(1600)]]);
  assert.equal(busyMic.controls.at(-1).code, 'AUDIO_OVERRUN'); assert.equal(busyMic.p.active, false);
});

test('trace fingerprint is independent of segmentation and preserves float32 LE sample identity', () => {
  const pcm = new Float32Array([0, -0, .1, -.5, 1]);
  const a = new PcmTrace(), b = new PcmTrace(); a.samplesIn(pcm, 0);
  b.samplesIn(pcm.subarray(0, 2), 0); b.samplesIn(pcm.subarray(2), 1);
  assert.equal(a.snapshot().pcmFnv1a32, b.snapshot().pcmFnv1a32);
  assert.equal(new DataView(canonicalBytes(pcm).buffer).getFloat32(12, true), -.5);
  assert.throws(() => a.samplesIn(pcm, 99), /AUDIO_SEQUENCE_ERROR/);
});

test('six raw hits do not imply six matched pronunciations: duplicates, ambiguity and out-of-window events stay separate', () => {
  const duplicate = matchWindows([{ sampleOffset: 0, sampleEnd: 1600, rawHits: 6 }], [[0,1],[2,3],[4,5],[6,7],[8,9],[10,11],[12,13],[14,15]]);
  assert.equal(duplicate.matchedWindows.length, 1); assert.equal(duplicate.duplicate, 5); assert.equal(duplicate.missedWindows.length, 7);
  const ambiguous = matchWindows([{ sampleOffset: 0, sampleEnd: 1600, rawHits: 1 }], [[0,1],[0,.5]]);
  assert.equal(ambiguous.ambiguous, 1); assert.equal(ambiguous.matchedWindows.length, 0);
  assert.equal(matchWindows([{ sampleOffset: 0, sampleEnd: 1600, rawHits: 1 }], [[2,3]]).outside, 1);
});

test('comparison reports config, PCM, amplitude and hit differences without adjusting input or parameters', () => {
  const configuration = { threshold: .05, keywords: [['▁a','t','la','s']], model: { revision: 'a'.repeat(40) }, score: 1, maxActivePaths: 4, cooldownMs: 1000 };
  const current = { configuration, wavSha256: 'b'.repeat(64), pcmSha256: 'c'.repeat(64), rawHits: 1, signal: { rms: .1, peak: .5 }, trace: { processedSamples: 1600, blocks: 1, pcmFnv1a32: '12345678', events: [{ sampleOffset: 0, rawHits: 1 }] } };
  const offline = { configuration, wavSha256: current.wavSha256, pcmSha256: current.pcmSha256, result: { ...current.trace, rawHits: 1, signal: current.signal } };
  assert.equal(compareRuns(current, offline).sameConfiguration, true);
  assert.equal(compareRuns(current, offline).sameFingerprint, true);
  assert.equal(compareRuns(current, { ...offline, configuration: { ...configuration, threshold: .25 } }).sameConfiguration, false);
  assert.equal(compareRuns(current, { ...offline, result: { ...offline.result, signal: { rms: .01, peak: .05 } } }).rmsDifference, .1 - .01);
  assert.throws(() => compareRuns(current, {}), /OFFLINE_REPORT_INVALID/);
});


test('delayed and burst recycling resumes exact WAV sample cursor without loss, duplicates or padded silence', async () => {
  const pcm = new Float32Array(330411);
  for (let i = 0; i < pcm.length; i++) pcm[i] = (i % 313) / 1000;
  const offline = replayPcm(pcm.slice(), engine());
  const h = sourceHarness(pcm.slice()), w = await workerHarness(h);
  // Simulate an occupied Worker, including pauses mid-render-quantum. Drain in bursts.
  for (let i = 0; i < 14000 && h.p.active; i++) {
    h.p.process([], [[new Float32Array(128)]]);
    if (i % 200 === 199) w.drain();
  }
  w.drain();
  const results = w.messages.filter(m => m.type === 'processed');
  const last = results.at(-1).diagnostics;
  assert.equal(results.length, 207); assert.equal(last.trace.processedSamples, pcm.length);
  assert.equal(last.signal.lastBlock.blockLength, 811);
  assert.equal(last.trace.pcmFnv1a32, offline.pcmFnv1a32);
  assert.equal(last.signal.aggregate.rms, offline.signal.rms);
  assert.equal(last.signal.aggregate.peak, offline.signal.peak);
  assert.deepEqual(last.trace.events, offline.events);
  assert.equal(h.controls.filter(m => m.type === 'wav-complete').length, 1);
  assert.ok(h.p.snapshot().wavBackpressure.waitQuanta > 0);
  assert.equal(h.p.highWater, 4); assert.equal(h.p.returned, 207);
  assert.ok(!h.controls.some(m => m.type === 'overrun')); await w.stop();
});

test('channel diagnostics reveal silent selected channel without changing PCM or retaining channel arrays', () => {
  const h = sourceHarness();
  const left = new Float32Array(1600), right = new Float32Array(1600).fill(.1);
  h.p.process([[left, right]]);
  const stats = h.p.snapshot().inputChannels;
  assert.equal(stats.length, 2); assert.equal(stats[0].rms, 0); assert.equal(stats[0].nearZeroPercent, 100);
  assert.ok(Math.abs(stats[1].rms - .1) < 1e-7); assert.equal(stats[1].nearZeroPercent, 0);
  assert.ok(new Float32Array(h.queue[0].pcm).every(v => v === 0), 'selected channel stays zero');
  assert.equal(h.queue[0].channels, 2); assert.ok(right.every(v => v > 0));
  assert.doesNotMatch(JSON.stringify(stats), /deviceId|groupId|label|pcm/);
  h.p.port.onmessage({ data: 'stop' });
});

test('channel metrics bound channel count, expose clipping and invalid samples without raw data', () => {
  const h = sourceHarness();
  h.p.process([[new Float32Array([0, 1, -1, NaN]), ...Array.from({ length: 9 }, () => new Float32Array(4))]]);
  const stats = h.p.snapshot();
  assert.equal(stats.channelsTruncated, true); assert.equal(stats.inputChannels.length, 8);
  assert.equal(stats.inputChannels[0].clippedSamples, 2); assert.equal(stats.inputChannels[0].invalidSamples, 1);
  assert.equal(stats.inputChannels[0].nearZeroPercent, 25);
  h.p.port.onmessage({ data: 'stop' });
});

test('signal comparison returns only finite scalar whitelisted fields, not private report content', () => {
  const result = compareSignalLevels({ rms: .01, peak: .2, nearZeroPercent: 80, clippedSamples: 1, invalidSamples: 0 },
    { rms: .02, peak: .4, deviceId: 'private-device', pcm: 'private-audio', nearZeroPercent: 30 });
  assert.equal(result.rmsRatio, .5); assert.equal(result.peakRatio, .5);
  assert.equal(result.live.nearZeroPercent, 80); assert.equal(result.reference.nearZeroPercent, 30);
  assert.doesNotMatch(JSON.stringify(result), /private|deviceId|pcm/);
  assert.equal(compareSignalLevels({ rms: Infinity }, { rms: 0 }).rmsRatio, null);
});
