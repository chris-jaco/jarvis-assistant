import { SpikeError } from './core.js';
export class PcmTrace {
  private hash = 2166136261;
  private samples = 0;
  private blocks = 0;
  private start = 0;
  private events: { block: number; sampleOffset: number; sampleEnd: number; rawHits: number }[] = [];
  samplesIn(pcm: Float32Array, sequence: number) {
    if (sequence !== this.blocks) throw new SpikeError('AUDIO_SEQUENCE_ERROR');
    this.start = this.samples;
    const view = new DataView(new ArrayBuffer(4));
    // Input float32 bits are encoded LE explicitly for a stable diagnostic fingerprint.
    for (let i = 0; i < pcm.length; i++) {
      view.setFloat32(0, pcm[i]!, true);
      const word = view.getUint32(0, true);
      for (let j = 0; j < 4; j++) this.hash = Math.imul(this.hash ^ ((word >>> (8 * j)) & 255), 16777619) >>> 0;
    }
    this.samples += pcm.length; this.blocks++;
  }
  hits(rawHits: number) {
    if (rawHits) {
      if (this.events.length >= 1000) throw new SpikeError('EVENT_LIMIT');
      this.events.push({ block: this.blocks - 1, sampleOffset: this.start, sampleEnd: this.samples, rawHits });
    }
  }
  snapshot() { return { processedSamples: this.samples, blocks: this.blocks,
    pcmFnv1a32: this.hash.toString(16).padStart(8, '0'), events: this.events.map(e => ({ ...e })) }; }
}
export function canonicalBytes(pcm: Float32Array) {
  const bytes = new Uint8Array(pcm.length * 4), view = new DataView(bytes.buffer);
  pcm.forEach((v, i) => view.setFloat32(i * 4, v, true)); return bytes;
}
export function matchWindows(events: { sampleOffset: number; sampleEnd: number; rawHits: number }[], windows: number[][]) {
  if (windows.length > 100 || windows.some(w => w.length !== 2 || !w.every(Number.isFinite) || w[0]! < 0 || w[1]! <= w[0]!)) throw new SpikeError('ANNOTATION_INVALID');
  if (events.length > 1000 || events.some(e => !Number.isSafeInteger(e.rawHits) || e.rawHits < 1 || e.rawHits > 1000
    || !Number.isSafeInteger(e.sampleOffset) || !Number.isSafeInteger(e.sampleEnd) || e.sampleOffset < 0 || e.sampleEnd <= e.sampleOffset)) throw new SpikeError('ANNOTATION_INVALID');
  const matched = new Set<number>(); let duplicate = 0, outside = 0, ambiguous = 0;
  for (const event of events) {
    // Detection is localized to its input block, not the acoustic word itself.
    const candidates = windows.map((w, i) => ({ w, i })).filter(({ w }) => event.sampleEnd / 16000 >= w[0]! && event.sampleOffset / 16000 <= w[1]!);
    for (let n = 0; n < event.rawHits; n++) {
      if (!candidates.length) outside++;
      else if (candidates.length !== 1) ambiguous++;
      else if (matched.has(candidates[0]!.i)) duplicate++;
      else matched.add(candidates[0]!.i);
    }
  }
  return { annotatedWindows: windows.length, matchedWindows: [...matched].sort((a,b) => a-b),
    missedWindows: windows.map((_, i) => i).filter(i => !matched.has(i)), duplicate, outside, ambiguous,
    interpretation: 'PROVISIONAL_BLOCK_TIME_MATCH_REQUIRES_HUMAN_REVIEW' };
}
export function compareRuns(current: any, offline: any) {
  const c = current.configuration, o = offline?.configuration;
  const settings = (v: any) => JSON.stringify({ model: { repository: v?.model?.repository, revision: v?.model?.revision, license: v?.model?.license }, keywords: v?.keywords, threshold: v?.threshold,
    score: v?.score, maxActivePaths: v?.maxActivePaths, cooldownMs: v?.cooldownMs,
    hashes: v?.modelHashes?.map((x: any) => [x.name, x.sha256]).sort() });
  const r = offline?.result, t = current.trace;
  if (!r || !o || !c || !Array.isArray(r.events) || r.events.length > 1000
    || typeof o.threshold !== 'number' || !Number.isFinite(o.threshold) || !Array.isArray(o.keywords)
    || !o.model || !/^[a-f0-9]{40}$/.test(o.model.revision)) throw new SpikeError('OFFLINE_REPORT_INVALID');
  return { sameConfiguration: settings(c) === settings(o), sameWavSha256: current.wavSha256 === offline.wavSha256,
    sameSourcePcmSha256: current.pcmSha256 === offline.pcmSha256,
    sameSamples: t.processedSamples === r.processedSamples, sameBlocks: t.blocks === r.blocks,
    sameFingerprint: r.pcmFnv1a32 ? t.pcmFnv1a32 === r.pcmFnv1a32 : null,
    rawHitsLive: current.rawHits, rawHitsOffline: r.rawHits,
    sameHitBlocks: JSON.stringify(t.events.map((e: any) => [e.sampleOffset, e.rawHits])) === JSON.stringify(r.events.map((e: any) => [e.sampleOffset, e.rawHits])),
    rmsDifference: typeof r.signal?.rms === 'number' && typeof current.signal?.rms === 'number' ? current.signal.rms - r.signal.rms : null,
    peakDifference: typeof r.signal?.peak === 'number' && typeof current.signal?.peak === 'number' ? current.signal.peak - r.signal.peak : null,
    note: 'FNV_IS_DIAGNOSTIC_NOT_CRYPTOGRAPHIC; COMPARE_RAW_HITS_BEFORE_COOLDOWN' };
}
