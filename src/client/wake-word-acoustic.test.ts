import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { measurePcm, SignalTotals } from '../../experiments/wake-word/signal.js';
import { decodeWav } from '../../experiments/wake-word/wav.js';
import { replayPcm } from '../../experiments/wake-word/replay.js';
import { SpikeError } from '../../experiments/wake-word/core.js';

function wav(samples: number[], rate = 16000, channels = 1, kind = 1) {
  const width = kind === 1 ? 2 : 4, bytes = Buffer.alloc(44 + samples.length * width);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(kind, 20);
  bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * channels * width, 28); bytes.writeUInt16LE(channels * width, 32); bytes.writeUInt16LE(width * 8, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples.length * width, 40);
  samples.forEach((value, i) => kind === 1 ? bytes.writeInt16LE(value, 44 + i * width) : bytes.writeFloatLE(value, 44 + i * width));
  return bytes;
}
test('silence and low-level PCM produce scalar indicators without modifying the samples', () => {
  const silence = measurePcm(new Float32Array(1600), 16000, 1);
  assert.equal(silence.rms, 0); assert.equal(silence.nearZeroPercent, 100); assert.ok(silence.indicators.includes('DIGITAL_SILENCE'));
  const pcm = new Float32Array(1600).fill(.0001), before = pcm.slice();
  const low = measurePcm(pcm, 16000, 1);
  assert.ok(low.indicators.includes('LOW_LEVEL')); assert.deepEqual(pcm, before);
});
test('RMS aggregates sample energy with proper weighting, not mean block RMS', () => {
  const totals = new SignalTotals(); totals.add(measurePcm(new Float32Array([0, 0]), 16000, 1));
  totals.add(measurePcm(new Float32Array([1, 1, 1, 1, 1, 1]), 16000, 1));
  assert.equal(totals.snapshot().rms, Math.sqrt(6 / 8)); assert.equal(totals.snapshot().peak, 1);
  assert.equal(totals.snapshot().nearZeroPercent, 25);
});
test('clipping proximity and invalid PCM are distinguishable diagnostics, not exceptions or repairs', () => {
  const s = measurePcm(new Float32Array([1, -1, .2, NaN, Infinity, 2]), 16000, 1);
  assert.equal(s.clippedSamples, 3); assert.equal(s.invalidSamples, 3);
  assert.ok(s.indicators.includes('NEAR_FULL_SCALE')); assert.ok(s.indicators.includes('INVALID_PCM'));
});
test('incomplete blocks, unexpected sample rate and channels are observable without a format-changing fallback', () => {
  const s = measurePcm(new Float32Array(128), 48000, 2);
  assert.equal(s.blockLength, 128); assert.equal(s.sampleRate, 48000); assert.equal(s.channels, 2);
  assert.deepEqual(s.indicators.filter(x => x !== 'DIGITAL_SILENCE'), ['UNEXPECTED_SAMPLE_RATE', 'UNEXPECTED_CHANNELS', 'INCOMPLETE_BLOCK']);
});
test('canonical PCM16 WAV maps explicitly into float32 without peak normalization', () => {
  const d = decodeWav(wav([-32768, 0, 16384, 32767]));
  assert.deepEqual([...d.pcm], [-1, 0, .5, 32767 / 32768]); assert.equal(d.conversion.resampled, false);
});
test('WAV rejects truncated, corrupt, duplicated and unsupported chunks before inference', () => {
  assert.throws(() => decodeWav(new Uint8Array(44)), /WAV_INVALID/);
  const truncated = wav([0, 0]); assert.throws(() => decodeWav(truncated.subarray(0, 45)), /WAV_INVALID/);
  const alignment = wav([0, 0]); alignment.writeUInt16LE(4, 32); assert.throws(() => decodeWav(alignment), /WAV_INVALID/);
  const format = wav([0]); format.writeUInt16LE(65534, 20); assert.throws(() => decodeWav(format), /WAV_INVALID/);
  const duplicate = Buffer.concat([wav([0]), Buffer.from('data'), Buffer.from([2, 0, 0, 0, 0, 0])]); duplicate.writeUInt32LE(duplicate.length - 8, 4);
  assert.throws(() => decodeWav(duplicate), /WAV_INVALID/);
  assert.throws(() => decodeWav(wav([NaN], 16000, 1, 3)), /WAV_INVALID_PCM/);
});
test('noncanonical WAV requires explicit conversion, averaging channels without gain compensation', () => {
  assert.throws(() => decodeWav(wav([0, 16384, 0, 16384], 16000, 2)), /WAV_CONVERSION_REQUIRED/);
  const d = decodeWav(wav([0, 16384, 0, 16384], 16000, 2), true);
  assert.deepEqual([...d.pcm], [.25, .25]); assert.equal(d.conversion.downmix, true);
  assert.deepEqual([...decodeWav(wav([16384, -16384], 16000, 2), true).pcm], [0]);
});
test('explicit rate conversion is deterministic, preserves duration and attenuates out-of-band energy', () => {
  const make = (hz: number) => wav(Array.from({ length: 4800 }, (_, i) => Math.round(12000 * Math.sin(2 * Math.PI * hz * i / 48000))), 48000);
  assert.throws(() => decodeWav(make(1000)), /WAV_CONVERSION_REQUIRED/);
  const low = decodeWav(make(1000), true), high = decodeWav(make(12000), true);
  assert.equal(low.pcm.length, 1600); assert.deepEqual(low.pcm, decodeWav(make(1000), true).pcm);
  assert.ok(measurePcm(high.pcm.subarray(100, 1500), 16000, 1).rms! < measurePcm(low.pcm.subarray(100, 1500), 16000, 1).rms! / 20);
});
test('deterministic replay preserves partial tail, counts raw hits and releases engine and PCM', () => {
  const seen: number[] = []; let freed = 0;
  const pcm = new Float32Array(3300).fill(.5);
  const r = replayPcm(pcm, { processAudio: p => { seen.push(p.length); return [{ label: 'Atlas' }]; }, dispose() { freed++; } });
  assert.deepEqual(seen, [1600, 1600, 100]); assert.equal(r.processedSamples, 3300);
  assert.equal(r.rawHits, 3); assert.equal(r.detections, 1); assert.equal(r.suppressedHits, 2);
  assert.equal(r.appendedSilenceSamples, 0); assert.ok(pcm.every(x => x === 0)); assert.equal(freed, 1);
});
test('replay wipes audio and releases engine after inference errors', () => {
  let freed = 0; const pcm = new Float32Array(1600).fill(.2);
  assert.throws(() => replayPcm(pcm, { processAudio() { throw Error('private-native-message'); }, dispose() { freed++; } }), /ENGINE_FAILED/);
  assert.ok(pcm.every(x => x === 0)); assert.equal(freed, 1);
});
test('keyword audit reports incompatibility without changing caller keywords or claiming reference validation', async () => {
  const { auditTokens } = await import(new URL('../../experiments/wake-word/audit-tokens.mjs', import.meta.url).href);
  const piece = Buffer.from([10, 5, ...Buffer.from('atlas'), 21, 0, 0, 128, 63]);
  const model = Buffer.concat([Buffer.from([10, piece.length]), piece]);
  const keywords = [['atlas']]; const before = JSON.stringify(keywords);
  const ok = auditTokens(model, 'atlas 1', keywords);
  assert.equal(ok.state, 'STRUCTURALLY_CONSISTENT_REFERENCE_PENDING'); assert.equal(ok.officialSentencePieceCompared, false);
  assert.equal(JSON.stringify(keywords), before);
  assert.equal(auditTokens(model, 'atlas 1', [['missing']]).state, 'INCOMPATIBLE');
  assert.equal(auditTokens(model, 'atlas 1\nother 1', keywords).state, 'AUDIT_INVALID');
  assert.equal(auditTokens(new Uint8Array([0]), 'atlas 1', keywords).state, 'AUDIT_INVALID');
});
test('offline inference and acoustic measurements have no persistence/upload or microphone APIs', () => {
  for (const name of ['signal.ts', 'wav.ts', 'replay.ts', 'offline.ts', 'offline-worker.mjs']) {
    const code = readFileSync(new URL('../../experiments/wake-word/' + name, import.meta.url), 'utf8');
    assert.doesNotMatch(code.replace(/\.FS\.writeFile/g, 'MEMORY_FS'), /writeFile|appendFile|createWriteStream|localStorage|indexedDB|MediaRecorder|sendBeacon|getUserMedia|https:\/\//);
  }
  const code = readFileSync(new URL('../../experiments/wake-word/offline-worker.mjs', import.meta.url), 'utf8');
  assert.match(code, /NETWORK_DISABLED/); assert.match(code, /replayPcm/);
  assert.match(readFileSync(new URL('../../experiments/wake-word/offline.ts', import.meta.url), 'utf8'), /await worker\.terminate\(\)/);
});

test('offline worker blocks network, reports sanitized failures and closes all owned resources', async () => {
  const vm = await import('node:vm');
  const source = readFileSync(new URL('../../experiments/wake-word/offline-worker.mjs', import.meta.url), 'utf8')
    .replace(/^import .*\n/gm, '').replace('await import(pathToFileURL(workerData.runtimePath).href)', 'globalThis.__api');
  for (const fail of [false, true]) {
    let requests = 0, freed = 0, closed = false;
    const messages: any[] = [], heap = new Uint8Array([1, 2, 3]);
    const pcm = new Float32Array(1600).fill(.1);
    let context: any;
    context = vm.createContext({ createWasmProfiler: () => ({ wrapEngine: (e: any) => e, snapshot: () => ({}), restore() {} }),
      SpikeError, replayPcm, Float32Array, Uint8Array,
      console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
      parentPort: { postMessage: (v: unknown) => messages.push(structuredClone(v)), close() { closed = true; } },
      workerData: { runtimePath: 'private-path', models: {}, keywords: [['▁a', 't', 'la', 's']], threshold: .05, pcm: pcm.buffer },
      fetch() { requests++; },
      __api: {
        initKWSModule: async () => ({ HEAPU8: heap, FS: { writeFile() { assert.fail('No PCM may be written to MEMFS'); } } }),
        createKeywordSpotter: () => ({ processAudio() {
          assert.throws(() => context.fetch(), /NETWORK_DISABLED/);
          if (fail) throw Error('private-native-error'); return [{ label: 'Atlas' }];
        }, dispose() { freed++; } })
      }
    });
    await vm.runInContext('(async () => {' + source + '})()', context);
    assert.equal(requests, 0); assert.equal(freed, 1); assert.equal(closed, true);
    assert.ok(pcm.every(v => v === 0)); assert.ok(heap.every(v => v === 0));
    assert.equal(messages[0].ok, !fail);
    assert.doesNotMatch(JSON.stringify(messages), /private-path|private-native-error|credential/);
    if (!fail) assert.equal(messages[0].result.rawHits, 1);
  }
});

test('reference keyword text matches WASM syntax and preserves Spanish token sequence and settings', async () => {
  const { keywordText } = await import(new URL('../../experiments/wake-word/reference.mjs', import.meta.url).href);
  assert.equal(keywordText([['▁a', 't', 'la', 's']], .05), '▁a t la s :1 #0.05 @sherpaw_0');
  const source = readFileSync(new URL('../../experiments/wake-word/reference-kws.cc', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /s->InputFinished\(|AcceptWaveform\([^\n]*padding/);
  assert.match(source, /config\.num_trailing_blanks = 1/);
});
