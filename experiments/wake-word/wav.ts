import { SpikeError } from './core.js';
// Strict RIFF/WAVE reader: PCM16 LE or IEEE Float32, no compressed/extensible formats.
export function decodeWav(bytes: Uint8Array, convert = false) {
  const fail = () => { throw new SpikeError('WAV_INVALID'); };
  if (bytes.length < 44 || bytes.length > 32 * 1024 * 1024) fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (p: number) => String.fromCharCode(...bytes.subarray(p, p + 4));
  if (text(0) !== 'RIFF' || text(8) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.length) fail();
  let format: { kind: number; channels: number; rate: number; bits: number; align: number } | undefined;
  let data: Uint8Array | undefined;
  let p = 12;
  while (p < bytes.length) {
    if (p + 8 > bytes.length) fail();
    const n = view.getUint32(p + 4, true), start = p + 8, end = start + n;
    if (end > bytes.length) fail();
    if (text(p) === 'fmt ') {
      if (format || n < 16) fail();
      format = { kind: view.getUint16(start, true), channels: view.getUint16(start + 2, true),
        rate: view.getUint32(start + 4, true), align: view.getUint16(start + 12, true), bits: view.getUint16(start + 14, true) };
      if (!((format.kind === 1 && format.bits === 16) || (format.kind === 3 && format.bits === 32))
        || format.channels < 1 || format.channels > 8 || format.rate < 8000 || format.rate > 96000
        || format.align !== format.channels * format.bits / 8 || view.getUint32(start + 8, true) !== format.rate * format.align) fail();
    } else if (text(p) === 'data') { if (data) fail(); data = bytes.subarray(start, end); }
    p = end + (n % 2); if (p > bytes.length) fail();
  }
  if (!format || !data || !data.length || data.length % format.align) fail();
  const f = format!, audio = data!;
  const frames = audio.length / f.align;
  if (frames / f.rate > 300) throw new SpikeError('WAV_TOO_LONG');
  if (!convert && (f.channels !== 1 || f.rate !== 16000)) throw new SpikeError('WAV_CONVERSION_REQUIRED');
  const input = new DataView(audio.buffer, audio.byteOffset, audio.byteLength), mono = new Float32Array(frames);
  try {
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < f.channels; c++) {
        const at = i * f.align + c * f.bits / 8;
        const value = f.kind === 1 ? input.getInt16(at, true) / 32768 : input.getFloat32(at, true);
        if (!Number.isFinite(value) || Math.abs(value) > 1) throw new SpikeError('WAV_INVALID_PCM');
        sum += value;
      }
      mono[i] = sum / f.channels;
    }
    const pcm = f.rate === 16000 ? mono : resample(mono, f.rate);
    if (pcm !== mono) mono.fill(0);
    return { pcm, source: { sampleRate: f.rate, channels: f.channels, bits: f.bits, format: f.kind, frames },
      conversion: { downmix: f.channels !== 1, resampled: f.rate !== 16000, outputRate: 16000,
        method: f.rate === 16000 ? 'NONE' : 'HANN_SINC_64', gainNormalization: false } };
  } catch (error) { mono.fill(0); throw error; }
}
function resample(input: Float32Array, rate: number) {
  const output = new Float32Array(Math.round(input.length * 16000 / rate));
  const cutoff = .475 * Math.min(1, 16000 / rate), radius = 32;
  for (let i = 0; i < output.length; i++) {
    const position = i * rate / 16000, start = Math.floor(position) - radius + 1;
    let sum = 0, weights = 0;
    for (let j = start; j < start + 64; j++) {
      const d = position - j;
      if (Math.abs(d) >= radius) continue;
      const x = 2 * cutoff * d;
      const w = 2 * cutoff * (Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * (.5 + .5 * Math.cos(Math.PI * d / radius));
      weights += w; if (j >= 0 && j < input.length) sum += input[j]! * w;
    }
    output[i] = sum / weights;
    if (!Number.isFinite(output[i]) || Math.abs(output[i]!) > 1) { output.fill(0); throw new SpikeError('WAV_CONVERSION_RANGE'); }
  }
  return output;
}
