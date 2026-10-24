import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { SpikeError } from './core.js';
import { decodeWav } from './wav.js';
import { canonicalBytes } from './trace.js';

export const configuration = { threshold: .25, score: 1, maxActivePaths: 4, cooldownMs: 1000,
  sampleRate: 16000, channels: 1, blockSamples: 1600, numTrailingBlanks: 1, featureDim: 80 };
export const expectedPcm = 'ddd500ae3b79de9fa1f9af82c04142dfd1b06dd2fca5237008f0cd3af3b5138b';
export const sdkHashes: Record<string, string> = {
  'sherpa-onnx-c-api.dll': '949e720ba4282d1097025d1f469317e16c06c69820d0384acd648cd12fcba983',
  'onnxruntime.dll': '422d776ab0e3218260f7f628fcb84606aaa5c21116f720c8619a6da5e0b2e0f9',
  'onnxruntime_providers_shared.dll': '0190137dee4933261c065c5d030c3568a68c7aa43cad942b4726a07011738bc2'
};
export const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export async function localPath(path: string) {
  const root = await realpath(resolve(import.meta.dirname, '../../.local')), full = await realpath(path), rel = relative(root, full);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new SpikeError('LOCAL_PATH_REQUIRED');
  return full;
}
export async function input(path: string) {
  const { loadAssets, defaultRoot } = await import(new URL('./server.mjs', import.meta.url).href);
  const assets = await loadAssets().catch(() => { throw new SpikeError('MODEL_ASSETS_UNAVAILABLE'); });
  const wavPath = await localPath(path), bytes = await readFile(wavPath);
  const wavSha256 = sha(bytes); let pcm: Float32Array | undefined;
  try {
    const decoded = decodeWav(bytes, false); pcm = decoded.pcm;
    if (decoded.source.format !== 1 || decoded.source.bits !== 16 || pcm.length !== 330411) throw new SpikeError('WAV_FORMAT_REQUIRED');
    const canonical = canonicalBytes(pcm), pcmSha256 = sha(canonical); canonical.fill(0);
    if (pcmSha256 !== expectedPcm) throw new SpikeError('PCM_HASH_MISMATCH');
    const modelHashes: Record<string, string> = {};
    for (const name of ['encoder.onnx','decoder.onnx','joiner.onnx','tokens.txt']) modelHashes[name] = sha(assets.files.get('/assets/model/' + name));
    const { keywordText } = await import(new URL('./reference.mjs', import.meta.url).href);
    const keyword = keywordText(assets.manifest.keywords, .25);
    return { pcm, assets, root: defaultRoot, wavPath, wavSha256, pcmSha256, modelHashes, keyword, keywordSha256: sha(keyword) };
  } catch (e) { pcm?.fill(0); throw e; } finally { bytes.fill(0); }
}
const stable = (value: any): string => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+stable(value[k])).join(',') + '}' : JSON.stringify(value);
export function validateTrial(r: any, expected: any, backend: string, mode: string) {
  const fail = () => { throw new SpikeError('BENCHMARK_EQUIVALENCE_FAILED'); };
  if (r?.schema !== 1 || r.state !== 'COMPLETED' || r.backend !== backend || r.mode !== mode
    || stable(r.configuration) !== stable(configuration) || r.wavSha256 !== expected.wavSha256 || r.pcmSha256 !== expectedPcm
    || stable(r.modelHashes) !== stable(expected.modelHashes) || r.keywordSha256 !== expected.keywordSha256
    || r.processedSamples !== 330411 || r.blocks !== 207 || r.appendedSilenceSamples !== 0
    || r.rawHits !== 3 || r.detections !== 3 || r.suppressedHits !== 0 || r.cleanupCompleted !== true
    || r.preparation?.newStream !== true || (mode === 'WARM' && r.preparation?.decodeCalls < 2)) fail();
  if (!Array.isArray(r.events) || stable(r.events) !== stable([27,46,91].map(block => ({ block, sampleOffset: block*1600, sampleEnd: Math.min(330411,(block+1)*1600), rawHits: 1 })))) fail();
  const finite = (v: any) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!Array.isArray(r.decodes) || !r.decodes.length || r.decodes.length > 10000 || !Array.isArray(r.blockMetrics) || r.blockMetrics.length !== 207) fail();
  if (r.decodes.some((d: any) => !Number.isInteger(d.block) || d.block<0 || d.block>=207 || !finite(d.wallMs) || !(d.threadCpuMs === null || finite(d.threadCpuMs)))) fail();
  if (r.blockMetrics.some((b: any, i: number) => b.sequence !== i || !finite(b.wallMs) || !(b.threadCpuMs === null || finite(b.threadCpuMs))
    || b.decodeCalls !== r.decodes.filter((d: any) => d.block === i).length || b.rawHits !== Number([27,46,91].includes(i)))) fail();
  if (!finite(r.processing?.wallMs) || !finite(r.processing?.rtf) || !finite(r.processing?.maxBlockWallMs)
    || !(r.processing.threadCpuMs === null || finite(r.processing.threadCpuMs))) fail();
  if (backend === 'NATIVE' && (r.runtime?.version !== '2.0.0' || !r.runtime?.git?.startsWith('8abb7c8f')
    || !Array.isArray(r.runtime.dlls) || r.runtime.dlls.length !== 2
    || ['sherpa-onnx-c-api.dll','onnxruntime.dll'].some(n => !r.runtime.dlls.some((d: any) => d.name===n && d.sha256===sdkHashes[n])))) fail();
  if (!Array.isArray(r.hitPositions) || r.hitPositions.length!==3 || r.hitPositions.some((p:any,i:number)=>p.block!==[27,46,91][i]
    || !finite(p.startTimeSec) || !Array.isArray(p.timestampsSec) || !p.timestampsSec.length || p.timestampsSec.length>32 || p.timestampsSec.some((v:any)=>!finite(v)))) fail();
  if (backend === 'WASM' && (r.runtime?.version !== '@sherpaw/kws 0.3.0' || !finite(r.moduleLoadWallMs))) fail();
  if (backend === 'NATIVE' && !/^[a-f0-9]{8,40}$/.test(r.runtime.git)) fail();
  for (const v of [r.initializationWallMs,r.preparation.wallMs,r.preparation.resetWallMs]) if (!finite(v)) fail();
  if (!Number.isInteger(r.preparation.syntheticBlocks) || !Number.isInteger(r.preparation.decodeCalls)
    || r.preparation.syntheticBlocks < 0 || r.preparation.syntheticBlocks > 30 || r.preparation.decodeCalls < 0
    || (mode === 'COLD' && (r.preparation.syntheticBlocks !== 0 || r.preparation.decodeCalls !== 0))
    || (mode === 'WARM' && (r.preparation.syntheticBlocks === 0 || r.preparation.wallMs >= 10000))) fail();
  for (const k of ['residentStartBytes','residentEndBytes','residentPeakBytes','wasmHeapBytes'])
    if (!(r.memory?.[k] === null || finite(r.memory?.[k]))) fail();
  if (r.memory.peakKind !== (backend === 'NATIVE' ? 'OS_PEAK' : 'SAMPLED_PROCESS_RSS')) fail();
  if (r.decodes.some((d: any,i: number) => i && d.block < r.decodes[i-1].block)) fail();
  if (Math.abs(r.processing.rtf-r.processing.wallMs/(330411/16)) > 1e-8
    || r.processing.maxBlockWallMs !== Math.max(...r.blockMetrics.map((b: any) => b.wallMs))) fail();
  // Build an allowlisted report; arbitrary fields from a child never reach the output.
  return { schema:1,state:'COMPLETED',backend,mode,configuration:{...configuration},
    runtime: backend === 'NATIVE' ? {version:'2.0.0',git:r.runtime.git,dlls:r.runtime.dlls.map((d: any)=>({name:d.name,sha256:d.sha256}))} : {version:r.runtime.version},
    wavSha256:expected.wavSha256,pcmSha256:expectedPcm,modelHashes:{...expected.modelHashes},keywordSha256:expected.keywordSha256,
    processedSamples:330411,blocks:207,rawHits:3,detections:3,suppressedHits:0,appendedSilenceSamples:0,
    events:r.events.map((e: any)=>({block:e.block,sampleOffset:e.sampleOffset,sampleEnd:e.sampleEnd,rawHits:e.rawHits})),
    hitPositions:r.hitPositions.map((p:any)=>({block:p.block,startTimeSec:p.startTimeSec,timestampsSec:[...p.timestampsSec]})),
    moduleLoadWallMs:backend==='WASM'?r.moduleLoadWallMs:null,
    initializationWallMs:r.initializationWallMs,
    preparation:{syntheticBlocks:r.preparation.syntheticBlocks,decodeCalls:r.preparation.decodeCalls,wallMs:r.preparation.wallMs,resetWallMs:r.preparation.resetWallMs,newStream:true},
    processing:{wallMs:r.processing.wallMs,threadCpuMs:r.processing.threadCpuMs,rtf:r.processing.rtf,maxBlockWallMs:r.processing.maxBlockWallMs},
    decodes:r.decodes.map((d: any)=>({block:d.block,wallMs:d.wallMs,threadCpuMs:d.threadCpuMs})),
    blockMetrics:r.blockMetrics.map((b: any)=>({sequence:b.sequence,wallMs:b.wallMs,threadCpuMs:b.threadCpuMs,decodeCalls:b.decodeCalls,rawHits:b.rawHits})),
    memory:{residentStartBytes:r.memory.residentStartBytes,residentEndBytes:r.memory.residentEndBytes,residentPeakBytes:r.memory.residentPeakBytes,
      peakKind:r.memory.peakKind,wasmHeapBytes:r.memory.wasmHeapBytes},cleanupCompleted:true };

}
export function distribution(values: number[]) {
  if (!values.length || values.some(v => !Number.isFinite(v) || v<0)) throw new SpikeError('METRICS_INVALID');
  const sorted = [...values].sort((a,b) => a-b), n=sorted.length;
  return { n, median: n%2 ? sorted[(n-1)/2] : (sorted[n/2-1]!+sorted[n/2]!)/2, p95: sorted[Math.ceil(n*.95)-1], max: sorted[n-1] };
}
export function summarize(trials: any[]) {
  const wall = (fn: (r: any) => number) => distribution(trials.map(fn));
  const cpu = trials.map(r => r.processing.threadCpuMs);
  return { firstDecodeWallMs: wall(r => r.decodes[0].wallMs),
    maxSubsequentDecodeWallMs: wall(r => Math.max(0,...r.decodes.slice(1).map((d: any) => d.wallMs))),
    maxBlockWallMs: wall(r => r.processing.maxBlockWallMs), processingWallMs: wall(r => r.processing.wallMs), rtf: wall(r => r.processing.rtf),
    moduleLoadWallMs: trials.every(r=>typeof r.moduleLoadWallMs==='number') ? wall(r=>r.moduleLoadWallMs) : null,
    initializationWallMs: wall(r => r.initializationWallMs), preparationWallMs: wall(r => r.preparation.wallMs), resetWallMs: wall(r => r.preparation.resetWallMs),
    decodeCalls: wall(r => r.decodes.length),
    firstDecodeThreadCpuMs: trials.every(r => r.decodes[0].threadCpuMs !== null) ? wall(r => r.decodes[0].threadCpuMs) : null,
    maxSubsequentDecodeThreadCpuMs: trials.every(r => r.decodes.every((d: any)=>d.threadCpuMs !== null))
      ? wall(r => Math.max(0,...r.decodes.slice(1).map((d: any)=>d.threadCpuMs))) : null,
    wasmHeapBytes: trials.every(r => typeof r.memory.wasmHeapBytes === 'number') ? wall(r => r.memory.wasmHeapBytes) : null,
    processingThreadCpuMs: cpu.every(v => typeof v==='number') ? distribution(cpu) : null,
    cpuCoverage: cpu.filter(v => typeof v==='number').length,
    residentPeakBytes: trials.every(r => typeof r.memory?.residentPeakBytes==='number') ? wall(r => r.memory.residentPeakBytes) : null,
    memoryPeakKind: [...new Set(trials.map(r => r.memory.peakKind))] };
}
