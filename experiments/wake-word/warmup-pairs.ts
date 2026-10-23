import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOffline } from './offline.js';
import { SpikeError } from './core.js';

const expectedBlocks = [27, 46, 91];
const closedErrors = ['MODEL_ASSETS_UNAVAILABLE', 'AUDIO_LOCATION_NOT_ALLOWED', 'TOKEN_AUDIT_BLOCKED',
  'WAV_TOO_LONG', 'WAV_INVALID', 'WAV_INVALID_PCM', 'WAV_CONVERSION_REQUIRED', 'OFFLINE_TIMEOUT',
  'OFFLINE_ENGINE_FAILED', 'OFFLINE_ENGINE_EXITED', 'WARMUP_UNSUPPORTED', 'WARMUP_LIMIT', 'WARMUP_TIMEOUT', 'WARMUP_RESET_FAILED'];
function compact(report: any) {
  const r = report.result, p = r?.wasmProfile, c = report.configuration;
  if (!r || !p?.firstDecode || !Array.isArray(p.recent) || !Array.isArray(r.events)
    || c?.threshold !== .25 || c?.score !== 1 || c?.maxActivePaths !== 4 || c?.cooldownMs !== 1000
    || (report.conversion?.downmix || report.conversion?.resampled || report.conversion?.gainNormalization) || report.mode !== 'LOCAL_WAV_WASM') throw new SpikeError('EXPERIMENT_REPORT_INVALID');
  const profile = {
    firstDecode: p.firstDecode, subsequentDecode: p.subsequentDecode,
    maxBlockWallMs: p.maxBlockWallMs, totalWallMs: p.totalWallMs,
    withoutDecode: p.withoutDecode, decodeCalls: p.stages[3].calls,
    blocks: p.recent.map((b: any) => ({ sequence: b.sequence, wallMs: b.wallMs, decodeCalls: b.decodeCalls,
      decodeWallMs: b.decodeWallMs, decodeMaxWallMs: b.decodeMaxWallMs, rawHits: b.rawHits,
      heapBefore: b.heapBefore, heapAfter: b.heapAfter, status: b.status }))
  };
  if (profile.blocks.length !== r.blocks || profile.blocks.some((b: any, i: number) => b.sequence !== i || b.status !== 'COMPLETED')
    || !Number.isSafeInteger(r.processedSamples) || r.processedSamples <= 0 || r.blocks !== Math.ceil(r.processedSamples / 1600) || r.appendedSilenceSamples !== 0) throw new SpikeError('EXPERIMENT_REPORT_INVALID');
  return { mode: r.experimentMode, preparation: r.preparation, configuration: c,
    wavSha256: report.wavSha256, pcmSha256: report.pcmSha256, pcmFnv1a32: r.pcmFnv1a32,
    samples: r.processedSamples, blocks: r.blocks, rawHits: r.rawHits, detections: r.detections,
    suppressedHits: r.suppressedHits,
    events: r.events.map((e: any) => ({ block: e.block, sampleOffset: e.sampleOffset, sampleEnd: e.sampleEnd, rawHits: e.rawHits })),
    processingWallMs: r.processingTiming.totalProcessingWallMs,
    wallRTF: r.processingTiming.totalProcessingWallMs / (r.processedSamples / 16), profile };
}
function identity(r: any) {
  return JSON.stringify([r.configuration, r.wavSha256, r.pcmSha256, r.pcmFnv1a32, r.samples, r.blocks,
    r.rawHits, r.detections, r.suppressedHits, r.events]);
}
const median = (v: number[]) => [...v].sort((a,b) => a-b)[Math.floor(v.length / 2)]!;
export async function runWarmupPairs(path: string, run: (path: string, warm: boolean) => Promise<any> =
  (path, warm) => runOffline(path, .25, false, undefined, false, warm)) {
  const pairs: any[] = [];
  try {
    // runOffline awaits Worker termination in finally before the next independent invocation.
    for (let pair = 0; pair < 5; pair++) {
      const cold = compact(await run(path, false));
      if (cold.mode !== 'COLD') throw new SpikeError('EXPERIMENT_REPORT_INVALID');
      const warm = compact(await run(path, true));
      if (warm.mode !== 'WARM' || warm.preparation?.state !== 'COMPLETED' || warm.preparation.decodeCalls < 2)
        throw new SpikeError('EXPERIMENT_REPORT_INVALID');
      pairs.push({ pair: pair + 1, equivalent: identity(cold) === identity(warm), cold, warm });
    }
    const all = pairs.flatMap(p => [p.cold, p.warm]), warm = pairs.map(p => p.warm);
    const equivalent = all.every(r => identity(r) === identity(all[0]));
    const expectedHits = all.every(r => r.rawHits === 3 && r.detections === 3 && r.suppressedHits === 0
      && JSON.stringify(r.events.map((e: any) => e.block)) === JSON.stringify(expectedBlocks));
    const coldFirstMedianMs = median(pairs.map(p => p.cold.profile.firstDecode.wallMs));
    const warmFirstMedianMs = median(warm.map(r => r.profile.firstDecode.wallMs));
    const improvement = coldFirstMedianMs > 0 ? 1 - warmFirstMedianMs / coldFirstMedianMs : null;
    const bounded = warm.every(r => Number.isFinite(r.profile.firstDecode.wallMs) && r.profile.firstDecode.wallMs < 200
      && Number.isFinite(r.profile.subsequentDecode.maxWallMs) && r.profile.subsequentDecode.maxWallMs < 200
      && Number.isFinite(r.profile.maxBlockWallMs) && r.profile.maxBlockWallMs < 200
      && Number.isFinite(r.wallRTF) && r.wallRTF < .7);
    return { state: 'COMPLETED', measurement: 'WALL_CLOCK_NOT_CPU', pairs,
      checks: { equivalent, expectedHits, bounded, coldFirstMedianMs, warmFirstMedianMs, improvement },
      criteria: { minimumMedianReduction: .5, maxWarmFirstDecodeMsExclusive: 200, maxWarmLaterDecodeMsExclusive: 200,
        maxWarmBlockMsExclusive: 200, maxWarmRTFExclusive: .7, expectedHitBlocks: expectedBlocks },
      verdict: equivalent && expectedHits && bounded && improvement !== null && improvement >= .5 ? 'GO_FOR_EXPERIMENTAL_LIVE_TEST_ONLY' : 'NO_GO',
      limitation: 'FIVE_PAIRS_DO_NOT_PROVE_SUSTAINED_LIVE_SAFETY_OR_RESET_INTERNAL_EQUIVALENCE' };
  } catch (error) {
    const allowed = [...closedErrors, 'EXPERIMENT_REPORT_INVALID'];
    return { state: 'FAILED', verdict: 'NO_GO', completedPairs: pairs.length, pairs,
      code: error instanceof SpikeError && allowed.includes(error.code) ? error.code : 'WARMUP_EXPERIMENT_FAILED' };
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0]!.startsWith('-')) { console.error('ARGUMENT_INVALID'); process.exitCode = 2; }
  else {
    const report = await runWarmupPairs(args[0]!);
    console.log(JSON.stringify(report)); // Explicit caller redirection only; never writes audio or reports itself.
    process.exitCode = report.verdict === 'GO_FOR_EXPERIMENTAL_LIVE_TEST_ONLY' ? 0 : 2;
  }
}
