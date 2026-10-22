import { PcmDetector, SpikeError } from './core.js';
import type { Engine } from './core.js';
import { measurePcm, SignalTotals } from './signal.js';
import { PcmTrace } from './trace.js';
// No timers, microphone, disk, network, appended silence or input gain changes.
// Cooldown uses sample position for reproducibility; rawHits is the reference comparison authority.
export function replayPcm(pcm: Float32Array, engine: Engine) {
  let position = 0, blocks = 0, rawHits = 0, suppressedHits = 0, detections = 0;
  const detector = new PcmDetector(engine, () => position / 16), totals = new SignalTotals();
  const trace = new PcmTrace();
  try {
    if (!pcm.length || pcm.length > 16000 * 300) throw new SpikeError('AUDIO_INVALID');
    while (position < pcm.length) {
      // The last partial block is sent at its real length: never silently pad or drop PCM.
      const block = pcm.slice(position, position + 1600);
      trace.samplesIn(block, blocks);
      const signal = measurePcm(block, 16000, 1); totals.add(signal);
      const result = detector.process(block, 16000);
      rawHits += result.rawHits; suppressedHits += result.suppressedHits; detections += Number(result.detected);
      trace.hits(result.rawHits);
      position += block.length; blocks++;
    }
    return { ...trace.snapshot(), rawHits, suppressedHits, detections,
      signal: totals.snapshot(), cooldownClock: 'AUDIO_SAMPLE_POSITION', cooldownMs: 1000,
      appendedSilenceSamples: 0, partialFinalBlock: pcm.length % 1600, sampleRate: 16000 };
  } finally { pcm.fill(0); detector.stop(); }
}
