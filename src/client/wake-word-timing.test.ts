import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { PcmDetector, SpikeError } from '../../experiments/wake-word/core.js';
import { PcmTrace } from '../../experiments/wake-word/trace.js';
import { measurePcm, SignalTotals } from '../../experiments/wake-word/signal.js';

async function harness(infer: (h: any) => void = () => {}, wall = true) {
  let time = 0, Processor: any, disposed = 0;
  const clock = { now: () => time, timeOrigin: 1000 };
  const outgoing: any[] = [], returns: any[] = [], ui: any[] = [], controls: any[] = [];
  const awContext = vm.createContext({ createWasmProfiler: () => ({ wrapEngine: (e: any) => e, snapshot: () => ({}), restore() {} }), Float32Array, ArrayBuffer, sampleRate: 16000,
    currentFrame: 0, currentTime: 0, performance: wall ? clock : undefined,
    AudioWorkletProcessor: class { port = { onmessage: undefined, postMessage: (v: any) => controls.push(structuredClone(v)) }; },
    registerProcessor: (_name: string, p: any) => { Processor = p; } });
  vm.runInContext(readFileSync(new URL('../../experiments/wake-word/pcm-worklet.js', import.meta.url), 'utf8'), awContext);
  const aw = new Processor();
  const awPort = { onmessage: undefined as any, start() {}, close() {},
    postMessage(v: any, transfer: Transferable[]) { outgoing.push(structuredClone(v, { transfer })); } };
  aw.port.onmessage({ data: { type: 'connect', port: awPort } });
  const self = { onmessage: undefined as any, postMessage: (v: any) => ui.push(structuredClone(v)), close() {} };
  const port = { onmessage: undefined as any, start() {}, close() {},
    postMessage(v: any, transfer: Transferable[]) { returns.push(structuredClone(v, { transfer })); } };
  let h: any;
  const ctx = vm.createContext({ createWasmProfiler: () => ({ wrapEngine: (e: any) => e, snapshot: () => ({}), restore() {} }), self, performance: clock, Float32Array, Uint8Array, ArrayBuffer,
    PcmDetector: class extends PcmDetector { constructor(engine: any) { super(engine, clock.now); } }, SpikeError, PcmTrace, measurePcm, SignalTotals,
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    __api: { initKWSModule: async () => ({ HEAPU8: new Uint8Array(8), FS: { writeFile() {} } }),
      createKeywordSpotter: () => ({ processAudio() { infer(h); return []; }, dispose() { disposed++; } }) } });
  const code = readFileSync(new URL('../../experiments/wake-word/worker.mjs', import.meta.url), 'utf8')
    .replace(/^import .*\n/gm, '').replace("await import('/assets/runtime/core.js')", 'globalThis.__api');
  vm.runInContext(code, ctx);
  await self.onmessage({ data: { type: 'init', threshold: .25, keywords: [['▁a','t','la','s']],
    files: Object.fromEntries(['encoder.onnx','decoder.onnx','joiner.onnx','tokens.txt'].map(n => ['model/' + n, new ArrayBuffer(1)])) } });
  await self.onmessage({ data: { type: 'connect', port } });
  h = { aw, outgoing, returns, ui, controls,
    advance(ms: number) { time += ms; },
    produce(samples = 1600) {
      aw.process([[new Float32Array(samples)]]);
      awContext.currentFrame += samples; awContext.currentTime += samples / 16000;
    },
    receive() { port.onmessage({ data: outgoing.shift() }); },
    recycle(index = 0) { awPort.onmessage({ data: returns.splice(index, 1)[0] }); },
    disposed: () => disposed, stop: () => self.onmessage({ data: { type: 'stop' } }) };
  return h;
}

test('slow inference publishes its start before synchronous work and preserves all six timing boundaries', async () => {
  const h = await harness(h => {
    assert.equal(h.ui.at(-1).type, 'inference-start'); h.advance(302);
  });
  h.produce(); h.receive(); h.recycle();
  const stats = h.ui.at(-1).diagnostics;
  assert.equal(stats.engineMaxMs, 302);
  assert.deepEqual(stats.timing.history.map((e: any) => e.stage), [1,2,3,4]);
  assert.equal(stats.timing.lastReceived, 0); assert.equal(stats.timing.lastStarted, 0); assert.equal(stats.timing.lastCompleted, 0);
  const timeline = stats.recent[0].timing;
  assert.equal(timeline.received.epochMs, 1000); assert.equal(timeline.inferenceStart.epochMs, 1000);
  assert.equal(timeline.inferenceEnd.epochMs, 1302); assert.equal(timeline.recyclePost.epochMs, 1302);
  const events = h.aw.snapshot().recent;
  assert.equal(events[0].sent.epochMs, 1000); assert.equal(events[1].received.epochMs, 1302);
  assert.equal(events[1].returnDeliveryMs, 0); await h.stop();
});

test('worker starvation leaves sent sequences pending without inventing receive or inference events', async () => {
  const h = await harness();
  for (let i = 0; i < 4; i++) h.produce();
  h.advance(302); h.produce(128);
  const failure = h.controls.at(-1);
  assert.equal(failure.code, 'AUDIO_OVERRUN');
  assert.deepEqual(failure.diagnostics.timing.pending.map((p: any) => p.sequence), [0,1,2,3]);
  assert.equal(failure.diagnostics.timing.producedMinusReturned, 4);
  assert.equal(h.ui.some((m: any) => m.type === 'inference-start'), false); await h.stop();
});

test('message delivery delay is separate from inference and recycle call cost', async () => {
  const h = await harness(h => h.advance(2));
  h.produce(); h.advance(200); h.receive(); h.advance(100); h.recycle();
  assert.equal(h.ui.at(-1).diagnostics.recent[0].timing.deliveryMs, 200);
  assert.equal(h.ui.at(-1).engineMs, 2);
  assert.equal(h.aw.snapshot().recent.at(-1).returnDeliveryMs, 100); await h.stop();
});

test('render bursts advance audio clock without implying wall-clock elapsed time', async () => {
  const h = await harness();
  for (let i = 0; i < 4; i++) h.produce();
  const s = h.aw.snapshot().timing;
  assert.equal(s.consumedSamples, 6400); assert.equal(s.producedSamples, 6400);
  assert.equal(s.observed.renderTimeMs, 400); assert.equal(s.observed.localMs, 0);
  assert.equal(s.renderQuanta, 4); await h.stop();
});

test('out-of-order returned buffers retain sequence timing without changing credit semantics', async () => {
  const h = await harness();
  for (let i = 0; i < 4; i++) h.produce();
  for (let i = 0; i < 4; i++) h.receive();
  while (h.returns.length) h.recycle(h.returns.length - 1);
  assert.deepEqual(Array.from(h.aw.snapshot().recent.filter((e: any) => e.event === 'recycle'), (e: any) => e.sequence), [3,2,1,0]);
  assert.equal(h.aw.free.length, 4); assert.equal(h.aw.pending.size, 0); assert.equal(h.aw.active, true); await h.stop();
});

test('inference failure records end and error, returns no false success, wipes PCM and allows cleanup', async () => {
  const h = await harness(h => { h.advance(20); throw Error('private-engine-data'); });
  h.produce(); const owned = h.outgoing[0].pcm; h.receive();
  assert.equal(h.ui.at(-1).code, 'AUDIO_PROCESSING_FAILED'); assert.equal(h.returns.length, 0);
  assert.deepEqual(h.ui.at(-1).diagnostics.timing.history.map((e: any) => e.stage), [1,2,3,5]);
  assert.equal(h.ui.at(-1).diagnostics.timing.lastCompleted, null);
  assert.ok(new Float32Array(owned).every(v => v === 0));
  assert.doesNotMatch(JSON.stringify(h.ui), /private-engine-data/);
  await h.stop(); assert.equal(h.disposed(), 1);
});

test('unavailable worklet wall clock stays null; numeric histories remain bounded without PCM', async () => {
  const h = await harness(undefined, false);
  for (let i = 0; i < 30; i++) { h.produce(); h.receive(); h.recycle(); }
  const s = h.aw.snapshot(), stats = h.ui.at(-1).diagnostics;
  assert.equal(s.timing.observed.epochMs, null); assert.equal(s.recent.at(-1).returnDeliveryMs, null);
  assert.equal(stats.recent.at(-1).timing.deliveryMs, null);
  assert.equal(stats.timing.history.length, 64); assert.equal(s.recent.length, 16);
  assert.doesNotMatch(JSON.stringify(stats.timing), /pcm|device|transcript|secret/i);
  assert.equal(h.aw.free.length, 4); await h.stop();
});
