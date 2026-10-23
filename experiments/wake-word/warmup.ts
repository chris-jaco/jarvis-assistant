import { SpikeError } from './core.js';
import type { Engine } from './core.js';
import { createWasmProfiler } from './profile.js';

export type ResettableEngine = Engine & { reset(): void };
// Synthetic input belongs only to this preparation stream. Never pass real WAV PCM here.
export function prepareWarm(module: any, engine: ResettableEngine, now = () => performance.now()) {
  if (typeof engine.reset !== 'function') throw new SpikeError('WARMUP_UNSUPPORTED');
  const profiler = createWasmProfiler(module, undefined, now), measured = profiler.wrapEngine(engine);
  const started = now(); let blocks = 0;
  try {
    while (blocks < 30) {
      if (now() - started >= 10000) throw new SpikeError('WARMUP_TIMEOUT');
      const silence = new Float32Array(1600);
      try { measured.processAudio(silence, 16000); } finally { silence.fill(0); }
      blocks++;
      if (now() - started >= 10000) throw new SpikeError('WARMUP_TIMEOUT');
      const profile = profiler.snapshot();
      if (profile.stages[3]!.calls >= 2) {
        // Restore measurement hooks, not model/session parameters. reset creates a new stream.
        profiler.restore();
        const resetStart = now();
        try { engine.reset(); } catch { throw new SpikeError('WARMUP_RESET_FAILED'); }
        if (now() - started >= 10000) throw new SpikeError('WARMUP_TIMEOUT');
        return { state: 'COMPLETED', syntheticBlocks: blocks, syntheticSamples: blocks * 1600,
          decodeCalls: profile.stages[3]!.calls, firstDecode: profile.firstDecode,
          wallMs: now() - started, resetWallMs: now() - resetStart,
          limits: { blocks: 30, wallMs: 10000 }, measurement: 'WALL_CLOCK_NOT_CPU' };
      }
    }
    throw new SpikeError('WARMUP_LIMIT');
  } finally { profiler.restore(); }
}
