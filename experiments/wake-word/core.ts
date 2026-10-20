// Experimental only. Nothing in Atlas production imports this module.
export interface Asset { name: string; sha256: string; bytes: number }
export interface Manifest {
  schema: 1;
  model: { repository: string; revision: string; license: string };
  runtime: { package: string; version: string };
  files: Asset[];
  keywords: string[][];
}
export const requiredAssets = [
  'model/encoder.onnx', 'model/decoder.onnx', 'model/joiner.onnx', 'model/tokens.txt',
  'runtime/core.js', 'runtime/wasm-CP0rq9dg.js', 'runtime/prebuilt/kws.wasm'
] as const;
export class SpikeError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export function checkManifest(value: unknown): asserts value is Manifest {
  const m = value as Manifest;
  if (!m || m.schema !== 1 || !/^[a-f0-9]{40}$/.test(m.model?.revision ?? '')
    || m.model.repository !== 'jguerrisi/sherpa-onnx-kws-zipformer-es-3M-2026-08-08'
    || m.model.license !== 'UNVERIFIED_PERSONAL_EVALUATION_ONLY'
    || m.runtime?.package !== '@sherpaw/kws' || m.runtime.version !== '0.3.0'
    || !Array.isArray(m.files) || m.files.length > 20) throw new SpikeError('MANIFEST_INVALID');
  const names = new Set<string>();
  for (const file of m.files) {
    if (!file || !/^(model|runtime)\/[a-zA-Z0-9._/-]+$/.test(file.name)
      || file.name.includes('..') || names.has(file.name) || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 100_000_000) throw new SpikeError('MANIFEST_INVALID');
    names.add(file.name);
  }
  if (requiredAssets.some(name => !names.has(name))) throw new SpikeError('MODEL_MISSING');
  if (!Array.isArray(m.keywords) || !m.keywords.length || m.keywords.length > 2
    || m.keywords.some(parts => !Array.isArray(parts) || !parts.length || parts.length > 32
      || parts.some(p => typeof p !== 'string' || !p || /\s|[@:#]/u.test(p)))) throw new SpikeError('KEYWORDS_INVALID');
}
export async function verifyBytes(asset: Asset, bytes: Uint8Array, digest = (data: Uint8Array) => crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>)) {
  if (bytes.length !== asset.bytes) throw new SpikeError('ASSET_CORRUPT');
  const actual = [...new Uint8Array(await digest(bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
  if (actual !== asset.sha256) throw new SpikeError('ASSET_CORRUPT');
  if (asset.name.endsWith('.wasm') && (bytes[0] !== 0 || bytes[1] !== 97 || bytes[2] !== 115 || bytes[3] !== 109)) throw new SpikeError('WASM_INVALID');
}
export interface Engine {
  processAudio(samples: Float32Array, sampleRate: number): { label: string }[];
  dispose(): void;
}
export class PcmDetector {
  private live = true;
  private lastHit = -Infinity;
  constructor(private engine: Engine, private now = () => performance.now(), private cooldownMs = 1000) {}
  process(samples: Float32Array, sampleRate = 16000) {
    try {
      if (!this.live) throw new SpikeError('DETECTOR_STOPPED');
      if (!(samples instanceof Float32Array) || samples.length < 1 || samples.length > 16000 || sampleRate !== 16000
        || samples.some(v => !Number.isFinite(v) || Math.abs(v) > 1)) throw new SpikeError('AUDIO_INVALID');
      const start = this.now();
      const hits = this.engine.processAudio(samples, sampleRate);
      const engineMs = Math.max(0, this.now() - start);
      let detected = false, rawHits = 0, suppressedHits = 0;
      for (const hit of hits) if (hit.label === 'Atlas') {
        rawHits++;
        if (this.now() - this.lastHit >= this.cooldownMs) { detected = true; this.lastHit = this.now(); }
        else suppressedHits++;
      }
      return { detected, rawHits, suppressedHits, engineMs, pcmMs: samples.length / 16 };
    } catch (error) {
      if (error instanceof SpikeError) throw error;
      throw new SpikeError('ENGINE_FAILED');
    } finally { if (samples instanceof Float32Array) samples.fill(0); }
  }
  stop() {
    if (!this.live) return;
    this.live = false;
    try { this.engine.dispose(); } catch { throw new SpikeError('RELEASE_FAILED'); }
  }
}
export class ResourceScope {
  private stopped = false;
  private releases: Array<() => void | Promise<void>> = [];
  add(release: () => void | Promise<void>) {
    if (this.stopped) { void Promise.resolve().then(release).catch(() => {}); return false; }
    this.releases.push(release); return true;
  }
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    let failed = false;
    for (const release of this.releases.reverse()) try { await release(); } catch { failed = true; }
    this.releases = [];
    if (failed) throw new SpikeError('RELEASE_FAILED');
  }
}
