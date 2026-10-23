import test from 'node:test';
import assert from 'node:assert/strict';
import { createWasmProfiler, profileExports } from '../../experiments/wake-word/profile.js';
import { replayPcm } from '../../experiments/wake-word/replay.js';

function fixture(fail?: string) {
  let time = 0, ready = true, disposed = 0;
  const problem = Error('private-native-message');
  const cost = [3, 1, 5, 1, 1, 2];
  const module: any = { HEAPU8: new Uint8Array(32) };
  profileExports.forEach((name, i) => { module[name] = (...args: any[]) => {
    time += cost[i]!;
    if (name === fail) throw problem;
    if (i === 1) { const value = ready; ready = false; return Number(value); }
    return i === 3 ? 123 : undefined;
  }; });
  const hits = [{ label: 'Atlas' }, { label: 'Other' }];
  const engine = { processAudio(samples: Float32Array, rate: number) {
    assert.equal(rate, 16000); assert.ok(samples.every(Number.isFinite)); time += 2; ready = true;
    module[profileExports[0]](1, rate, 8, samples.length);
    while (module[profileExports[1]](1, 2)) {
      module[profileExports[2]](1, 2);
      const result = module[profileExports[3]](1, 2); assert.equal(result, 123);
      time += 2; // JS result reading, never copied into diagnostics.
      module[profileExports[5]](1, 2);
      module[profileExports[4]](result);
    }
    return hits;
  }, dispose() { disposed++; } };
  return { module, engine, hits, problem, now: () => time, disposed: () => disposed };
}

test('profiler preserves native calls, returns and PCM; separates all six boundaries and excludes reset from result reading', () => {
  const h = fixture(), events: any[] = [], originals = profileExports.map(n => h.module[n]);
  const p = createWasmProfiler(h.module, e => events.push(e), h.now), engine = p.wrapEngine(h.engine);
  const pcm = new Float32Array([.1, .2]); const before = pcm.slice();
  assert.equal(engine.processAudio(pcm, 16000), h.hits); assert.deepEqual(pcm, before);
  const s = p.snapshot(), block = s.recent[0];
  assert.deepEqual(s.stages.map(m => [m.calls, m.wallMs]), [[1,2],[1,3],[2,2],[1,5],[1,4],[1,2]]);
  assert.equal(block.wallMs, 18); assert.equal(block.decodeCalls, 1); assert.equal(block.decodeMaxWallMs, 5);
  assert.equal(block.heapBefore, 32); assert.equal(block.heapAfter, 32); assert.equal(block.rawHits, 1);
  assert.equal(s.firstDecode.sequence, 0); assert.equal(s.measurement, 'WALL_CLOCK_NOT_CPU');
  assert.equal(events.filter(e => e.stage === 4 && e.phase === 0).length, 1);
  engine.dispose(); p.restore(); assert.equal(h.disposed(), 1);
  profileExports.forEach((n, i) => assert.equal(h.module[n], originals[i]));
});

test('offline wall timing advances independently of sample cooldown while preserving raw hits, positions and PCM fingerprint', t => {
  const baseline = fixture(), measured = fixture();
  const pcm = new Float32Array(4800).fill(.01);
  const expected = replayPcm(pcm.slice(), baseline.engine);
  t.mock.method(performance, 'now', measured.now);
  const p = createWasmProfiler(measured.module), engine = p.wrapEngine(measured.engine);
  const result = replayPcm(pcm.slice(), engine), s = p.snapshot();
  assert.equal(result.rawHits, expected.rawHits); assert.equal(result.detections, expected.detections);
  assert.equal(result.suppressedHits, expected.suppressedHits);
  assert.deepEqual(result.events, expected.events); assert.equal(result.pcmFnv1a32, expected.pcmFnv1a32);
  assert.equal(result.processingTiming.totalProcessingWallMs, 54); assert.equal(s.totalWallMs, 54);
  assert.equal(s.subsequentDecode.calls, 2); assert.equal(s.subsequentDecode.wallMs, 10);
  assert.equal(s.firstBlock.sequence, 0); assert.equal(s.firstDecode.wallMs, 5);
  assert.equal(result.cooldownClock, 'AUDIO_SAMPLE_POSITION'); assert.equal(result.cooldownMs, 1000);
});

test('every native failure retains original exception semantics and adapter cleanup restores exports without leaking private errors', () => {
  for (const name of profileExports) {
    const h = fixture(name), originals = profileExports.map(n => h.module[n]);
    const p = createWasmProfiler(h.module, undefined, h.now), engine = p.wrapEngine(h.engine);
    assert.throws(() => engine.processAudio(new Float32Array(1600), 16000), error => error === h.problem);
    const s = p.snapshot(); assert.equal(s.recent[0].status, 'FAILED');
    assert.doesNotMatch(JSON.stringify(s), /private-native-message|deviceId|transcript|samples|command/i);
    engine.dispose(); profileExports.forEach((n, i) => assert.equal(h.module[n], originals[i]));
  }
});

test('readonly or missing exports reject profiling before touching the module; dispose failure still restores descriptors', () => {
  const h = fixture(), original = h.module[profileExports[0]];
  Object.defineProperty(h.module, profileExports[2], { writable: false });
  assert.throws(() => createWasmProfiler(h.module), /WASM_PROFILE_UNAVAILABLE/);
  assert.equal(h.module[profileExports[0]], original);
  assert.throws(() => createWasmProfiler({}), /WASM_PROFILE_UNAVAILABLE/);
  const good = fixture(), p = createWasmProfiler(good.module, undefined, good.now);
  const engine = p.wrapEngine({ ...good.engine, dispose() { throw Error('dispose'); } });
  assert.throws(() => engine.dispose(), /dispose/);
  assert.equal(good.module[profileExports[0]].name, original.name);
  assert.throws(() => engine.processAudio(new Float32Array(1), 16000), /WASM_PROFILE_STATE/);
});

test('bounded details preserve cumulative maxima and counts; no-decode blocks and heap growth remain observable', () => {
  const h = fixture(), p = createWasmProfiler(h.module, undefined, h.now);
  const engine = p.wrapEngine({ processAudio() { h.module.HEAPU8 = new Uint8Array(64); return []; }, dispose() {} });
  for (let i = 0; i < 30; i++) engine.processAudio(new Float32Array(1), 16000);
  const s = p.snapshot(); assert.equal(s.recent.length, 16); assert.equal(s.attemptedBlocks, 30);
  assert.equal(s.withoutDecode, 30); assert.equal(s.nonDecodingBlocks.calls, 30); assert.equal(s.firstDecode, null);
  assert.equal(s.recent[0].sequence, 14); assert.equal(s.recent.at(-1).heapAfter, 64);
  engine.dispose();
});


test('all decode calls are measured while events and progress notifications remain bounded', () => {
  const h = fixture(), progress: any[] = [];
  const p = createWasmProfiler(h.module, e => progress.push(e), h.now);
  const engine = p.wrapEngine({ processAudio() {
    h.module[profileExports[0]]();
    for (let i = 0; i < 100; i++) h.module[profileExports[2]]();
    return [];
  }, dispose() {} });
  engine.processAudio(new Float32Array(1600), 16000);
  const block = p.snapshot().recent[0];
  assert.equal(block.decodeCalls, 100); assert.equal(block.decodeWallMs, 500); assert.equal(block.decodeMaxWallMs, 5);
  assert.equal(block.events.length, 64); assert.equal(progress.length, 64);
  assert.equal(progress.at(-1).observationLimitReached, true);
  assert.equal(block.eventsTruncated, true); assert.equal(block.notificationsTruncated, true);
  engine.dispose();
});
