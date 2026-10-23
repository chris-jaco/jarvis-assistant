import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { checkManifest, verifyBytes, PcmDetector, ResourceScope, requiredAssets } from '../../experiments/wake-word/core.js';
import { decodeWav } from '../../experiments/wake-word/wav.js';
import { canonicalBytes, compareRuns, matchWindows } from '../../experiments/wake-word/trace.js';
import { PcmTrace } from '../../experiments/wake-word/trace.js';
import { measurePcm, SignalTotals, compareSignalLevels } from '../../experiments/wake-word/signal.js';
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
  assert.deepEqual(d.process(input), { detected: true, rawHits: 1, suppressedHits: 0, engineMs: 0, pcmMs: .125 });
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
    .replace(/^import .*\n/gm, '')
    .replace("await import('/assets/runtime/core.js')", 'globalThis.__api');
  const messages: unknown[] = []; let network = 0, disposed = 0, closed = false;
  const heap = new Uint8Array([1, 2, 3]);
  let appliedConfig: any, engineCalls = 0;
  const self: { onmessage?: (e: unknown) => Promise<void>; postMessage(v: unknown): void; close(): void } = {
    postMessage: v => messages.push(v), close: () => { closed = true; }
  };
  const { SpikeError } = await import('../../experiments/wake-word/core.js');
  const context = vm.createContext({ createWasmProfiler: () => ({ wrapEngine: (e: any) => e, snapshot: () => ({}), restore() {} }),
    self, console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    PcmDetector, SpikeError, PcmTrace, measurePcm, SignalTotals, Uint8Array, Float32Array, ArrayBuffer, performance,
    fetch() { network++; },
    __api: {
      initKWSModule: async () => ({ HEAPU8: heap, FS: { writeFile() {} } }),
      createKeywordSpotter: (_module: unknown, config: any) => { appliedConfig = config; return { processAudio: () => engineCalls++ % 2 === 0 ? [{ label: 'Atlas' }] : [], dispose() { disposed++; } }; }
    }
  });
  vm.runInContext(source, context);
  await self.onmessage!({ data: { type: 'init', keywords: [['A']], threshold: .05, files: Object.fromEntries(['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'].map(n => [`model/${n}`, new ArrayBuffer(1)])) } });
  assert.equal((messages[0] as { type: string }).type, 'ready');
  assert.equal(appliedConfig.keywords[0].threshold, .05); assert.equal(appliedConfig.keywords[0].score, 1);
  assert.equal(appliedConfig.maxActivePaths, 4);
  assert.equal((messages[0] as any).config.threshold, .05);
  for (const expression of ["fetch('https://outside.invalid')", 'new XMLHttpRequest()', 'new WebSocket("wss://outside.invalid")']) {
    assert.throws(() => vm.runInContext(expression, context), /NETWORK_DISABLED/);
  }
  assert.equal(network, 0);
  const h = workletHarness();
  const directPort = { onmessage: undefined as any, start() {}, close() {},
    postMessage(block: any) {
      assert.ok(new Float32Array(block.pcm).every(v => v === 0));
      h.recycle(structuredClone(block, { transfer: [block.pcm] }));
    }
  };
  await self.onmessage!({ data: { type: 'connect', port: directPort } });
  for (let i = 0; i < 4; i++) h.processor.process([[new Float32Array(1600).fill(.3)]]);
  // Worker drains a burst and recycles directly, without any page acknowledgement.
  for (const block of h.sent) directPort.onmessage({ data: block });
  assert.equal(h.processor.pending.size, 0);
  assert.equal(messages.filter((m: any) => m.type === 'processed').length, 4);
  const stats = (messages.filter((m: any) => m.type === 'processed').at(-1) as any).diagnostics;
  assert.equal(stats.rawHits, 2); assert.equal(stats.withHits.blocks, 2); assert.equal(stats.withoutHits.blocks, 2);
  assert.ok(stats.beforeRecycleMaxMs >= stats.engineMaxMs);
  assert.doesNotMatch(JSON.stringify(stats), /pcm|tokens|private|credential|https:/i);
  directPort.onmessage({ data: { type: 'pcm', sequence: 99, pcm: new ArrayBuffer(6400) } });
  assert.equal((messages.at(-1) as any).code, 'AUDIO_PROCESSING_FAILED');
  await self.onmessage!({ data: { type: 'stop' } });
  assert.equal(disposed, 1); assert.equal(closed, true); assert.deepEqual([...heap], [0, 0, 0]);
});

function workletHarness(clock?: { now(): number }) {
  let Processor: any;
  const control: any[] = [], sent: any[] = [];
  const context = vm.createContext({ createWasmProfiler: () => ({ wrapEngine: (e: any) => e, snapshot: () => ({}), restore() {} }),
    Float32Array, ArrayBuffer, performance: clock,
    AudioWorkletProcessor: class { port = { onmessage: undefined, postMessage: (v: unknown) => control.push(v) }; },
    registerProcessor: (_name: string, processor: unknown) => { Processor = processor; }
  });
  vm.runInContext(readFileSync(resolve(import.meta.dirname, '../../experiments/wake-word/pcm-worklet.js'), 'utf8'), context);
  const processor = new Processor();
  const port = { onmessage: undefined as any, start() {}, closed: false,
    close() { this.closed = true; },
    postMessage(v: any, transfer: Transferable[]) { sent.push(structuredClone(v, { transfer })); }
  };
  processor.port.onmessage({ data: { type: 'connect', port } });
  return { processor, port, control, sent,
    recycle(block: any) { new Float32Array(block.pcm).fill(0); port.onmessage({ data: { type: 'recycle', pcm: block.pcm, sequence: block.sequence } }); }
  };
}

test('continuous 128-frame rendering preserves sample order across block boundaries without PCM growth', () => {
  const h = workletHarness(); let acknowledged = 0, sample = 0, expected = 0;
  for (let quantum = 0; quantum < 1250; quantum++) {
    const input = Float32Array.from({ length: 128 }, () => (sample++ % 100) / 100);
    assert.equal(h.processor.process([[input]]), true);
    while (acknowledged < h.sent.length) {
      const block = h.sent[acknowledged++];
      assert.equal(block.sequence, acknowledged - 1);
      for (const value of new Float32Array(block.pcm)) assert.equal(value, Math.fround((expected++ % 100) / 100));
      h.recycle(block);
    }
    assert.ok(h.processor.free.length + (h.processor.buffer ? 1 : 0) + h.processor.pending.size === 4);
  }
  assert.equal(h.sent.length, 100); assert.equal(expected, 160000);
  h.processor.port.onmessage({ data: 'stop' });
  assert.equal(h.port.closed, true); assert.equal(h.processor.free.length, 0);
});

test('four-block burst tolerates a temporarily busy worker; credits arrive without UI participation', () => {
  const h = workletHarness();
  // No acknowledgements between callbacks reproduces a render-ahead/scheduling burst.
  for (let i = 0; i < 4; i++) assert.equal(h.processor.process([[new Float32Array(1600).fill(.25)]]), true);
  assert.equal(h.processor.pending.size, 4); assert.equal(h.sent.length, 4);
  for (const block of h.sent.slice()) h.recycle(block);
  assert.equal(h.processor.pending.size, 0);
  assert.equal(h.processor.process([[new Float32Array(1600)]]), true);
  assert.equal(h.sent[4].sequence, 4);
  assert.deepEqual(h.control.map(v => v.type), ['connected']);
});

test('exhausted bounded pool reports overrun instead of discarding audio, then releases owned buffers', () => {
  const h = workletHarness();
  for (let i = 0; i < 4; i++) h.processor.process([[new Float32Array(1600)]]);
  assert.equal(h.processor.process([[new Float32Array(128)]]), false);
  assert.equal(h.control.at(-1).code, 'AUDIO_OVERRUN');
  assert.equal(h.control.at(-1).diagnostics.highWater, 4);
  assert.equal(h.control.at(-1).diagnostics.outstanding, 4);
  assert.equal(h.processor.active, false); assert.equal(h.port.closed, true);
  assert.equal(h.processor.buffer, null); assert.equal(h.processor.free.length, 0);
  assert.equal(h.processor.process([[new Float32Array(1600)]]), false);
  h.recycle(h.sent[0]); assert.equal(h.processor.free.length, 0);
});

test('duplicate buffer acknowledgement fails explicitly and cannot expand the pool', () => {
  const h = workletHarness(); h.processor.process([[new Float32Array(1600)]]);
  h.recycle(h.sent[0]); h.recycle(h.sent[0]);
  assert.equal(h.processor.active, false); assert.equal(h.control[1].code, 'AUDIO_PROTOCOL_ERROR');
});

async function browserHarness(options: { deferMicrophone?: boolean; deferClose?: boolean; deferWarm?: boolean; failWarm?: boolean; badReset?: boolean } = {}) {
  const { transform } = await import('esbuild');
  const source = readFileSync(resolve(import.meta.dirname, '../../experiments/wake-word/browser.ts'), 'utf8');
  const js = (await transform(source, { loader: 'ts', format: 'esm' })).code.replace(/^import .*\n/gm, '');
  const elements = new Map<string, any>();
  for (const id of ['load', 'listen', 'stop', 'status', 'metrics', 'events', 'diagnostics', 'threshold', 'accent', 'distance', 'noise', 'wav-test', 'wav-file', 'wav-convert', 'offline-report', 'word-windows', 'live-mode']) elements.set(id, { disabled: false, textContent: '', value: id === 'threshold' ? '.25' : id === 'live-mode' ? 'COLD' : 'test' });
  let workers = 0, requests = 0, closedContexts = 0, terminated = 0, connected = 0;
  let node: any, currentWorker: any, resolveWarm: () => void, expireWarm: () => void;
  let resolveMicrophone!: (v: unknown) => void, resolveClose!: () => void;
  const track = { getSettings: () => ({ sampleRate: 48000, channelCount: 2, echoCancellation: false, noiseSuppression: false, autoGainControl: false, deviceId: 'private-device', groupId: 'private-group' }), readyState: 'live', stop() { this.readyState = 'ended'; }, addEventListener() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const closeGate = options.deferClose ? new Promise<void>(r => { resolveClose = r; }) : Promise.resolve();
  const microphone = options.deferMicrophone ? new Promise(r => { resolveMicrophone = r; }) : Promise.resolve(stream);
  const makeNode = () => ({ connect() { connected++; }, disconnect() {}, gain: { value: 0 } });
  class Context {
    state = 'running'; sampleRate = 16000; destination = {};
    audioWorklet = { addModule: async () => {} };
    async resume() {}
    async close() { await closeGate; this.state = 'closed'; closedContexts++; }
    createMediaStreamSource() { return makeNode(); }
    createGain() { return makeNode(); }
  }
  class Worklet {
    port = { onmessage: undefined as any, close() {}, postMessage: (v: any) => { if (v?.type === 'connect') queueMicrotask(() => this.port.onmessage({ data: { type: 'connected' } })); if (v?.type === 'wav-source') { this.wavSamples = v.pcm.byteLength / 4; queueMicrotask(() => this.port.onmessage({ data: { type: 'wav-ready' } })); } } };
    constructor() { node = this; }
    wavSamples = 0;
    connect() {
      connected++;
      if (this.wavSamples) queueMicrotask(() => {
        this.port.onmessage({ data: { type: 'wav-complete', samples: this.wavSamples, diagnostics: { outstanding: 0 } } });
        assert.equal(terminated, 0, 'EOF must not terminate before final worker telemetry');
        for (let i = 0; i < Math.ceil(this.wavSamples / 1600); i++) {
          const samples = Math.min(this.wavSamples, (i + 1) * 1600);
          currentWorker.onmessage({ data: { type: 'processed', sequence: i, outstanding: 1, engineMs: 0, workerMs: 0, pcmMs: Math.min(1600, this.wavSamples - i * 1600) / 16,
            diagnostics: { rawHits: 0, signal: { aggregate: { rms: .1, peak: .1 } }, trace: { processedSamples: samples, blocks: i + 1, pcmFnv1a32: '12345678', events: [] } } } });
        }
      });
    } disconnect() {}
  }
  class Worker {
    onmessage: any; onerror: any;
    constructor() { workers++; currentWorker = this; }
    terminate() { terminated++; }
    postMessage(v: any) {
      if (v.type === 'init') queueMicrotask(() => {
        const ready = () => this.onmessage({ data: { type: 'ready', wasmHeapBytes: 1024,
          config: { threshold: v.threshold, score: 1, maxActivePaths: 4, cooldownMs: 1000, keywords: v.keywords },
          preparation: v.warm ? { mode: 'WARM', state: 'COMPLETED', decodeCalls: 2, newStreamVerified: !options.badReset, wallMs: 12, resetWallMs: 1 }
            : { mode: 'COLD', state: 'NOT_REQUESTED' } } });
        if (v.warm) {
          this.onmessage({ data: { type: 'warmup-start' } });
          if (options.failWarm) this.onmessage({ data: { type: 'error', code: 'WARMUP_RESET_FAILED' } });
          else if (options.deferWarm) resolveWarm = ready;
          else ready();
        } else ready();
      });
      if (v.type === 'connect') queueMicrotask(() => this.onmessage({ data: { type: 'capture-ready' } }));
    }
  }
  const context = vm.createContext({ createWasmProfiler: () => ({ wrapEngine: (e: any) => e, snapshot: () => ({}), restore() {} }),
    document: { getElementById: (id: string) => elements.get(id), addEventListener() {}, hidden: false },
    window: { addEventListener() {} },
    navigator: { mediaDevices: { getUserMedia() { requests++; return microphone; }, addEventListener() {} } },
    AudioContext: Context, AudioWorkletNode: Worklet, Worker,
    MessageChannel: class { port1 = { close() {} }; port2 = { close() {} }; },
    fetch: async (url: string) => ({ ok: true, json: async () => fixture(), arrayBuffer: async () => new ArrayBuffer(1) }),
    checkManifest, verifyBytes: async () => {}, ResourceScope, compareSignalLevels, decodeWav, canonicalBytes, compareRuns, matchWindows, crypto,
    SpikeError: (await import('../../experiments/wake-word/core.js')).SpikeError,
    AbortController, Uint8Array, ArrayBuffer, Promise, setTimeout: (fn: () => void, ms: number) => { if (ms === 10000) expireWarm = fn; return setTimeout(fn, ms); }, clearTimeout, performance
  });
  vm.runInContext(js, context);
  return { elements, track,
    load: () => elements.get('load').onclick(), wav: () => elements.get('wav-test').onclick(), listen: () => elements.get('listen').onclick(),
    stop: () => vm.runInContext('stop()', context) as Promise<void>,
    workerMessage: (data: any) => currentWorker.onmessage({ data }),
    overrun: () => node.port.onmessage({ data: { type: 'overrun', code: 'AUDIO_OVERRUN', produced: 4, outstanding: 4 } }),
    warmReady: () => resolveWarm(), warmTimeout: () => expireWarm(),
    microphoneReady: () => resolveMicrophone(stream), closeReady: () => resolveClose(),
    counts: () => ({ workers, requests, closedContexts, terminated, connected })
  };
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test('browser overrun releases microphone, graph, context and worker; repeated stop cannot create overlapping sessions', async () => {
  const h = await browserHarness({ deferClose: true });
  await Promise.all([h.load(), h.load()]);
  await Promise.all([h.listen(), h.listen()]);
  assert.equal(h.counts().workers, 1); assert.equal(h.counts().requests, 1);
  assert.equal(h.counts().connected, 3);
  h.overrun();
  const stopped = h.stop();
  assert.equal(h.track.readyState, 'ended');
  await h.load(); assert.equal(h.counts().workers, 1);
  h.closeReady(); await stopped;
  assert.equal(h.counts().closedContexts, 1); assert.equal(h.counts().terminated, 1);
  assert.match(h.elements.get('status').textContent, /AUDIO_OVERRUN.*tracks terminados: true/);
  assert.equal(h.elements.get('load').disabled, false);
});

test('cancelled capture stops a late microphone stream without opening a second capture or connecting it', async () => {
  const h = await browserHarness({ deferMicrophone: true }); await h.load();
  const starting = h.listen(); await tick();
  await h.listen(); assert.equal(h.counts().requests, 1);
  await h.stop(); h.microphoneReady(); await starting;
  assert.equal(h.track.readyState, 'ended'); assert.equal(h.counts().connected, 0);
  assert.equal(h.counts().closedContexts, 1); assert.equal(h.counts().terminated, 1);
});


test('accepted runtime hits and cooldown suppression remain observable without changing acceptance', () => {
  let clock = 0;
  const d = new PcmDetector({ processAudio: () => [{ label: 'Atlas' }, { label: 'Atlas' }], dispose() {} }, () => clock);
  const first = d.process(new Float32Array([0]));
  assert.equal(first.rawHits, 2); assert.equal(first.suppressedHits, 1); assert.equal(first.detected, true);
  clock = 500;
  const second = d.process(new Float32Array([0]));
  assert.equal(second.rawHits, 2); assert.equal(second.suppressedHits, 2); assert.equal(second.detected, false);
  clock = 1500; assert.equal(d.process(new Float32Array([0])).detected, true); d.stop();
});

test('transport diagnostics distinguish audio-clock and wall-clock circulation, preserve peaks and bound history', () => {
  let time = 0;
  const h = workletHarness({ now: () => time });
  for (let i = 0; i < 4; i++) h.processor.process([[new Float32Array(1600)]]);
  time = 250; h.recycle(h.sent[0]);
  let stats = h.processor.snapshot();
  assert.equal(stats.returnAudioMaxMs, 300); assert.equal(stats.returnWallMaxMs, 250);
  assert.equal(stats.highWater, 4);
  for (const block of h.sent.slice(1)) h.recycle(block);
  for (let i = 0; i < 30; i++) { h.processor.process([[new Float32Array(1600)]]); h.recycle(h.sent.at(-1)); }
  stats = h.processor.snapshot();
  assert.equal(stats.recent.length, 16); assert.equal(stats.returnWallMaxMs, 250);
  assert.equal(stats.produced, 34); assert.equal(stats.returned, 34);
  assert.doesNotMatch(JSON.stringify(stats), /pcm|tokens|command|secret|https:/i);
  const noWallClock = workletHarness();
  noWallClock.processor.process([[new Float32Array(1600)]]); noWallClock.recycle(noWallClock.sent[0]);
  assert.equal(noWallClock.processor.snapshot().returnWallMaxMs, null);
});


test('browser WAV source opens no microphone, prevents double starts and waits across EOF/worker message ordering', async () => {
  const h = await browserHarness();
  const bytes = Buffer.alloc(44 + 1700 * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(3400, 40);
  h.elements.get('wav-file').files = [{ size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }];
  h.elements.get('word-windows').value = '';
  await h.load(); await Promise.all([h.wav(), h.wav()]); await tick();
  assert.equal(h.counts().requests, 0); assert.equal(h.counts().workers, 1);
  assert.equal(h.counts().closedContexts, 1); assert.equal(h.counts().terminated, 1);
  assert.match(h.elements.get('status').textContent, /WAV_COMPLETO.*tracks terminados: true/);
  assert.match(h.elements.get('diagnostics').textContent, /"state": "COMPLETED"/);
});


test('microphone diagnostics expose reported rate conversion and DSP without device identifiers or changing requested channel', async () => {
  const h = await browserHarness(); await h.load(); await h.listen();
  const data = JSON.parse(h.elements.get('diagnostics').textContent);
  assert.equal(data.capture.contextSampleRate, 16000);
  assert.equal(data.capture.trackSampleRate, 48000); assert.equal(data.capture.trackChannels, 2);
  assert.equal(data.capture.selectedInputChannel, 0);
  assert.equal(data.capture.resampling, 'BROWSER_RATE_CONVERSION_EXPECTED');
  assert.equal(data.capture.hardwareRateVerified, false);
  assert.equal(data.capture.autoGainControl, false);
  assert.doesNotMatch(JSON.stringify(data), /private-device|private-group|deviceId|groupId/);
  await h.stop(); assert.equal(h.track.readyState, 'ended');
});


test('stop during optional reference loading never opens a late microphone or context', async () => {
  const h = await browserHarness(); await h.load();
  let finish!: (s: string) => void;
  h.elements.get('offline-report').files = [{ size: 2, text: () => new Promise<string>(r => { finish = r; }) }];
  const starting = h.listen(); await h.stop(); finish('{}'); await starting;
  assert.equal(h.counts().requests, 0); assert.equal(h.counts().closedContexts, 0);
  assert.equal(h.counts().terminated, 1);
});


test('pending inference observation survives overrun and cleanup without asserting unavailable fault clock', async () => {
  const h = await browserHarness(); await h.load(); await h.listen();
  const epochMs = performance.timeOrigin + performance.now() - 302;
  h.workerMessage({ type: 'processing', sequence: 4, startedAt: epochMs });
  h.workerMessage({ type: 'inference-start', sequence: 4, timing: { current: { inferenceStart: { epochMs } } } });
  h.overrun(); await tick();
  const report = JSON.parse(h.elements.get('diagnostics').textContent);
  assert.equal(report.failure.lastStartedSequence, 4);
  assert.ok(report.failure.inferencePendingObservedMs >= 302);
  assert.equal(report.failure.inferencePendingAtFaultMs, null);
  assert.equal(h.track.readyState, 'ended'); assert.equal(h.counts().terminated, 1);
  assert.equal(h.counts().closedContexts, 1);
});


test('Warm Live does not request microphone or permit duplicate starts until reset acknowledgement; diagnostics start fresh', async () => {
  const h = await browserHarness({ deferWarm: true }); h.elements.get('live-mode').value = 'WARM';
  const loading = h.load(); await tick(); await tick();
  await h.listen(); await h.load();
  assert.equal(h.counts().requests, 0); assert.equal(h.counts().connected, 0); assert.equal(h.counts().workers, 1);
  assert.equal(h.elements.get('live-mode').disabled, true);
  h.warmReady(); await loading; assert.equal(h.counts().requests, 0);
  assert.equal(h.elements.get('listen').disabled, false); assert.equal(h.elements.get('wav-test').disabled, true);
  await Promise.all([h.listen(), h.listen()]); assert.equal(h.counts().requests, 1);
  h.workerMessage({ type: 'processed', sequence: 0, outstanding: 1, engineMs: 42, workerMs: 43, pcmMs: 100,
    diagnostics: { wasmProfile: { firstDecode: { sequence: 0, wallMs: 41.28 }, maxBlockWallMs: 85.57 } } });
  let report = JSON.parse(h.elements.get('diagnostics').textContent);
  assert.equal(report.preparation.newStreamVerified, true); assert.equal(report.liveTrial.mode, 'WARM');
  h.overrun(); await tick(); report = JSON.parse(h.elements.get('diagnostics').textContent);
  assert.equal(report.liveTrial.processedBlocks, 1); assert.equal(report.liveTrial.processedSamples, 1600);
  assert.equal(report.liveTrial.firstDecode.wallMs, 41.28); assert.equal(report.liveTrial.overruns, 1);
  assert.equal(report.liveTrial.maxEngineBlockWallMs, 85.57);
  assert.equal(report.release.cleanupCompleted, true); assert.equal(report.release.tracksEnded, true);
  assert.equal(report.release.audioContextClosed, true);
  assert.equal(h.counts().terminated, 1); assert.equal(h.elements.get('live-mode').disabled, false);
});

test('Warm failures, unverified reset and watchdog never open microphone', async () => {
  for (const options of [{ failWarm: true }, { badReset: true }, { deferWarm: true }]) {
    const h = await browserHarness(options); h.elements.get('live-mode').value = 'WARM';
    const loading = h.load(); await tick(); await tick();
    if (options.deferWarm) h.warmTimeout();
    await loading;
    assert.equal(h.counts().requests, 0); assert.equal(h.counts().connected, 0); assert.equal(h.counts().terminated, 1);
    const report = JSON.parse(h.elements.get('diagnostics').textContent);
    assert.equal(report.preparation.state, 'FAILED'); assert.match(report.preparation.code, /WARMUP_/);
    assert.equal(h.elements.get('listen').disabled, true);
  }
});

test('Stop during Warm ignores late readiness and preserves closed microphone', async () => {
  const h = await browserHarness({ deferWarm: true }); h.elements.get('live-mode').value = 'WARM';
  const loading = h.load(); await tick(); await tick(); await h.stop(); h.warmReady(); await loading;
  await h.listen(); assert.equal(h.counts().requests, 0); assert.equal(h.counts().terminated, 1);
});

test('Cold and Warm Live retain exact parameters; Live rejects a loaded threshold other than .25', async () => {
  for (const mode of ['COLD', 'WARM']) {
    const h = await browserHarness(); h.elements.get('live-mode').value = mode; await h.load();
    const r = JSON.parse(h.elements.get('diagnostics').textContent);
    assert.equal(r.configuration.threshold, .25); assert.equal(r.configuration.score, 1);
    assert.equal(r.configuration.maxActivePaths, 4); assert.equal(r.configuration.cooldownMs, 1000);
    await h.listen(); await h.stop(); assert.equal(h.track.readyState, 'ended');
  }
  for (const mode of ['COLD', 'WARM']) {
    const h = await browserHarness(); h.elements.get('live-mode').value = mode; h.elements.get('threshold').value = '.05';
    await h.load(); await h.listen(); assert.equal(h.counts().requests, 0); await h.stop();
  }
});
