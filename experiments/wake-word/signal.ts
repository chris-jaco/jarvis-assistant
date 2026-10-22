// Scalar measurements only; this module never retains sample arrays.
export interface Signal {
  samples: number; finiteSamples: number; sumSquares: number; rms: number | null;
  peak: number | null; nearZeroSamples: number; nearZeroPercent: number;
  clippedSamples: number; invalidSamples: number;
  sampleRate: number; channels: number; blockLength: number;
  indicators: string[];
}
export function measurePcm(samples: Float32Array, sampleRate: number, channels: number): Signal {
  let sumSquares = 0, peak = 0, nearZeroSamples = 0, clippedSamples = 0, invalidSamples = 0, finiteSamples = 0;
  for (const value of samples) {
    if (!Number.isFinite(value)) { invalidSamples++; continue; }
    finiteSamples++; sumSquares += value * value; peak = Math.max(peak, Math.abs(value));
    if (Math.abs(value) <= 1e-5) nearZeroSamples++;
    if (Math.abs(value) >= .999) clippedSamples++;
    if (Math.abs(value) > 1) invalidSamples++;
  }
  const rms = finiteSamples ? Math.sqrt(sumSquares / finiteSamples) : null;
  const indicators: string[] = [];
  if (!samples.length) indicators.push('EMPTY');
  if (rms === 0) indicators.push('DIGITAL_SILENCE');
  else if (rms !== null && rms < .001) indicators.push('LOW_LEVEL');
  if (clippedSamples) indicators.push('NEAR_FULL_SCALE');
  if (invalidSamples) indicators.push('INVALID_PCM');
  if (sampleRate !== 16000) indicators.push('UNEXPECTED_SAMPLE_RATE');
  if (channels !== 1) indicators.push('UNEXPECTED_CHANNELS');
  if (samples.length !== 1600) indicators.push('INCOMPLETE_BLOCK');
  return { samples: samples.length, finiteSamples, sumSquares, rms, peak: finiteSamples ? peak : null,
    nearZeroSamples, nearZeroPercent: samples.length ? 100 * nearZeroSamples / samples.length : 0,
    clippedSamples, invalidSamples, sampleRate, channels, blockLength: samples.length, indicators };
}
export class SignalTotals {
  blocks = 0; samples = 0; finiteSamples = 0; sumSquares = 0; peak = 0;
  nearZeroSamples = 0; clippedSamples = 0; invalidSamples = 0;
  add(s: Signal) {
    this.blocks++; this.samples += s.samples; this.finiteSamples += s.finiteSamples;
    this.sumSquares += s.sumSquares; this.peak = Math.max(this.peak, s.peak ?? 0);
    this.nearZeroSamples += s.nearZeroSamples; this.clippedSamples += s.clippedSamples; this.invalidSamples += s.invalidSamples;
  }
  snapshot() {
    return { blocks: this.blocks, samples: this.samples,
      rms: this.finiteSamples ? Math.sqrt(this.sumSquares / this.finiteSamples) : null,
      peak: this.finiteSamples ? this.peak : null,
      nearZeroPercent: this.samples ? 100 * this.nearZeroSamples / this.samples : 0,
      clippedSamples: this.clippedSamples, invalidSamples: this.invalidSamples };
  }
}
