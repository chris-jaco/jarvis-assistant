import { PcmDetector, SpikeError } from './core.js';
import type { Engine } from './core.js';
import { measurePcm, SignalTotals } from './signal.js';
// No timers, microphone, disk, network, appended silence or input gain changes.
// Cooldown uses sample position for reproducibility; rawHits is the reference comparison authority.
export function replayPcm(pcm: Float32Array, engine: Engine) {
  let position = 0, blocks = 0, rawHits = 0, suppressedHits = 0, detections = 0;
  const detector = new PcmDetector(engine, () => position / 16), totals = new SignalTotals();
  const events: { block: number; sampleOffset: number; rawHits: number }[] = [];
  try {
    if (!pcm.length || pcm.length > 16000 * 300) throw new SpikeError('AUDIO_INVALID');
    while (position < pcm.length) {
      // The last partial block is sent at its real length: never silently pad or drop PCM.
      const block = pcm.slice(position, position + 1600);
      const signal = measurePcm(block, 16000, 1); totals.add(signal);
      const result = detector.process(block, 16000);
      rawHits += result.rawHits; suppressedHits += result.suppressedHits; detections += Number(result.detected);
      if (result.rawHits) { events.push({ block: blocks, sampleOffset: position, rawHits: result.rawHits }); if (events.length > 1000) throw new SpikeError('EVENT_LIMIT'); }
      position += block.length; blocks++;
    }
    return { blocks, processedSamples: position, rawHits, suppressedHits, detections, events,
      signal: totals.snapshot(), cooldownClock: 'AUDIO_SAMPLE_POSITION', cooldownMs: 1000,
      appendedSilenceSamples: 0, partialFinalBlock: pcm.length % 1600, sampleRate: 16000 };
  } finally { pcm.fill(0); detector.stop(); }
}
