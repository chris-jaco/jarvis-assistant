import { prepareWarm } from './warmup.js';
import type { ResettableEngine } from './warmup.js';
import { SpikeError } from './core.js';

// Observe only the public reset operation. Handles stay local and are never reported.
export function verifyNewStream(module: any, reset: () => void) {
  const names = ['_SherpaOnnxCreateKeywordStream', '_SherpaOnnxDestroyOnlineStream'];
  const descriptors = names.map(name => Object.getOwnPropertyDescriptor(module, name));
  if (descriptors.some(d => !d || !d.writable || typeof d.value !== 'function')) throw new SpikeError('WARMUP_RESET_FAILED');
  let created = 0, destroyed = 0, newHandle: unknown, oldHandle: unknown;
  try {
    names.forEach((name, i) => Object.defineProperty(module, name, { ...descriptors[i], value: function(this: any, ...args: any[]) {
      const result = Reflect.apply(descriptors[i]!.value, this, args);
      if (i === 0) { created++; newHandle = result; } else { destroyed++; oldHandle = args[0]; }
      return result;
    } }));
    reset();
    if (created !== 1 || destroyed !== 1 || !Number.isSafeInteger(newHandle) || (newHandle as number) <= 0
      || !Number.isSafeInteger(oldHandle) || (oldHandle as number) <= 0 || newHandle === oldHandle) throw new SpikeError('WARMUP_RESET_FAILED');
  } finally { names.forEach((name, i) => Object.defineProperty(module, name, descriptors[i]!)); }
}

export function prepareLiveWarm(module: any, engine: ResettableEngine) {
  const preparation = prepareWarm(module, {
    processAudio: (pcm, rate) => engine.processAudio(pcm, rate),
    dispose: () => engine.dispose(),
    reset: () => verifyNewStream(module, () => engine.reset())
  });
  return { ...preparation, newStreamVerified: true };
}
