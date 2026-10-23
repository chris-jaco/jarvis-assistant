import { SpikeError } from './core.js';
import type { Engine } from './core.js';

// Boundaries of the pinned @sherpaw/kws 0.3.0 wrapper. Never edit verified assets.
export const profileExports = ['_SherpaOnnxOnlineStreamAcceptWaveform', '_SherpaOnnxIsKeywordStreamReady',
  '_SherpaOnnxDecodeKeywordStream', '_SherpaOnnxGetKeywordResult', '_SherpaOnnxDestroyKeywordResult',
  '_SherpaOnnxResetKeywordStream'] as const;
type Metric = { calls: number; wallMs: number; maxWallMs: number };
const metric = (): Metric => ({ calls: 0, wallMs: 0, maxWallMs: 0 });
const stages = () => Array.from({ length: 6 }, metric);
export function createWasmProfiler(module: any, progress?: (event: any) => void, now = () => performance.now(), retainedBlocks = 16) {
  if (!Number.isInteger(retainedBlocks) || retainedBlocks < 1 || retainedBlocks > 3000) throw new SpikeError('WASM_PROFILE_LIMIT');
  const descriptors = profileExports.map(name => Object.getOwnPropertyDescriptor(module, name));
  if (descriptors.some(d => !d || typeof d.value !== 'function' || !d.writable)) throw new SpikeError('WASM_PROFILE_UNAVAILABLE');
  let current: any, queryStart: number | undefined, queryReset = 0, preparationStart: number | undefined;
  let nextSequence = 0, restored = false, disposed = false, firstBlock: any = null, firstDecode: any = null;
  const blocks: any[] = [], totals = stages();
  const subsequentDecode = metric(), decodingBlocks = metric(), nonDecodingBlocks = metric();
  let totalWallMs = 0, maxBlockWallMs = 0, withoutDecode = 0, notifications = 0;
  function event(stage: number, phase: number, time: number) {
    const origin = globalThis.performance?.timeOrigin;
    const e = { sequence: current.sequence, stage, phase, localMs: time,
      epochMs: Number.isFinite(origin) ? origin! + time : null };
    if (current.events.length < 64) current.events.push(e); else current.eventsTruncated = true;
    // Bound observer overhead even if the native ready/decode loop is unexpectedly large.
    if (notifications < 64) progress?.({ ...e, observationLimitReached: notifications === 63 });
    else current.notificationsTruncated = true;
    notifications++;
  }
  function add(stage: number, start: number, end: number, excluded = 0) {
    const ms = Math.max(0, end - start - excluded), m = current.stages[stage - 1];
    m.calls++; m.wallMs += ms; m.maxWallMs = Math.max(m.maxWallMs, ms);
    if (stage === 4) {
      if (firstDecode === null) firstDecode = { sequence: current.sequence, wallMs: ms };
      else { subsequentDecode.calls++; subsequentDecode.wallMs += ms; subsequentDecode.maxWallMs = Math.max(subsequentDecode.maxWallMs, ms); }
    }
  }
  function finishPreparation(time: number) {
    if (preparationStart !== undefined) { add(1, preparationStart, time); event(1, 1, time); preparationStart = undefined; }
  }
  function finishQuery(time: number) {
    if (queryStart !== undefined) { add(5, queryStart, time, queryReset); event(5, 1, time); queryStart = undefined; }
  }
  const codes = [2, 3, 4, 5, 5, 6];
  profileExports.forEach((name, index) => {
    const original = descriptors[index]!.value;
    Object.defineProperty(module, name, { ...descriptors[index], value: function(this: any, ...args: any[]) {
      if (!current) return Reflect.apply(original, this, args);
      const start = now(), code = codes[index]!;
      if (index === 0) { finishPreparation(start); current.preparationReachedAccept = true; }
      if (index === 3) { queryStart = start; queryReset = 0; }
      if (index !== 4) event(code, 0, start);
      try { return Reflect.apply(original, this, args); }
      finally {
        const end = now();
        if (index === 4) finishQuery(end);
        else if (index !== 3) {
          add(code, start, end); event(code, 1, end);
          if (code === 6 && queryStart !== undefined) queryReset += end - start;
        }
      }
    } });
  });
  function restore() {
    if (restored) return; restored = true;
    profileExports.forEach((name, i) => Object.defineProperty(module, name, descriptors[i]!));
  }
  function heap() { return typeof module.HEAPU8?.byteLength === 'number' ? module.HEAPU8.byteLength : null; }
  return {
    restore,
    wrapEngine(engine: Engine): Engine {
      return {
        processAudio(samples, rate) {
          if (restored || current) throw new SpikeError('WASM_PROFILE_STATE');
          const start = now(); notifications = 0;
          current = { sequence: nextSequence++, stages: stages(), events: [], heapBefore: heap(),
            preparationReachedAccept: false, status: 'FAILED', rawHits: 0 };
          preparationStart = start; queryStart = undefined; event(1, 0, start);
          try {
            const hits = engine.processAudio(samples, rate);
            current.rawHits = hits.filter(h => h.label === 'Atlas').length; current.status = 'COMPLETED';
            return hits;
          } finally {
            const end = now(); finishPreparation(end); finishQuery(end);
            current.heapAfter = heap(); current.wallMs = Math.max(0, end - start);
            totalWallMs += current.wallMs; maxBlockWallMs = Math.max(maxBlockWallMs, current.wallMs);
            current.decodeCalls = current.stages[3].calls; current.decodeWallMs = current.stages[3].wallMs;
            current.decodeMaxWallMs = current.stages[3].maxWallMs;
            if (!current.decodeCalls) withoutDecode++;
            const group = current.decodeCalls ? decodingBlocks : nonDecodingBlocks;
            group.calls++; group.wallMs += current.wallMs; group.maxWallMs = Math.max(group.maxWallMs, current.wallMs);
            current.stages.forEach((m: Metric, i: number) => { const t = totals[i]!;
              t.calls += m.calls; t.wallMs += m.wallMs; t.maxWallMs = Math.max(t.maxWallMs, m.maxWallMs); });
            firstBlock ??= { sequence: current.sequence, wallMs: current.wallMs };
            blocks.push(current); if (blocks.length > retainedBlocks) blocks.shift(); current = undefined;
          }
        },
        dispose() { if (disposed) return; disposed = true; try { engine.dispose(); } finally { restore(); } }
      };
    },
    snapshot() {
      // Only bounded, owned numerical data and closed labels, never arguments/native results.
      return structuredClone({ measurement: 'WALL_CLOCK_NOT_CPU', stages: totals,
        attemptedBlocks: nextSequence, totalWallMs, maxBlockWallMs, withoutDecode, firstBlock, firstDecode, subsequentDecode, decodingBlocks, nonDecodingBlocks,
        recent: blocks, detailLimit: retainedBlocks, preparationMeaning: 'VALIDATION_ALLOCATION_COPY_AND_WRAPPER_PREFIX',
        resultsMeaning: 'GET_RESULT_TO_DESTROY_INCLUDING_JS_READS_EXCLUDING_RESET' });
    }
  };
}
