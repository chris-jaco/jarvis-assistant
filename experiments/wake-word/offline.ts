import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { decodeWav } from './wav.js';
import { SpikeError } from './core.js';
import type { Manifest } from './core.js';

export async function waitOfflineResult(worker: Pick<Worker, 'on' | 'once' | 'off'>, warm: boolean, totalMs = 120000, preparationMs = 10000) {
  let timeout: ReturnType<typeof setTimeout> | undefined, warmupTimeout: ReturnType<typeof setTimeout> | undefined;
  let messageHandler: any, errorHandler: any, exitHandler: any;
  try {
    return await new Promise<unknown>((resolve, reject) => {
      timeout = setTimeout(() => reject(new SpikeError('OFFLINE_TIMEOUT')), totalMs);
      let preparing = false, prepared = false;
      messageHandler = (message: any) => {
        if (message.phase === 'WARMUP_START') {
          if (!warm || preparing || prepared) { reject(new SpikeError('OFFLINE_ENGINE_FAILED')); return; }
          preparing = true;
          warmupTimeout = setTimeout(() => reject(new SpikeError('WARMUP_TIMEOUT')), preparationMs); return;
        }
        if (message.phase === 'WARMUP_END') {
          if (!preparing) { reject(new SpikeError('OFFLINE_ENGINE_FAILED')); return; }
          clearTimeout(warmupTimeout); preparing = false; prepared = true; return;
        }
        if (message.ok && (!warm || prepared)) resolve(message.result);
        else {
          const code = ['WARMUP_UNSUPPORTED', 'WARMUP_LIMIT', 'WARMUP_TIMEOUT', 'WARMUP_RESET_FAILED'].includes(message.code) ? message.code : 'OFFLINE_ENGINE_FAILED';
          reject(new SpikeError(code));
        }
      };
      errorHandler = () => reject(new SpikeError('OFFLINE_ENGINE_FAILED'));
      exitHandler = () => reject(new SpikeError('OFFLINE_ENGINE_EXITED'));
      worker.on('message', messageHandler); worker.once('error', errorHandler); worker.once('exit', exitHandler);
    });
  } finally {
    clearTimeout(timeout); clearTimeout(warmupTimeout);
    worker.off('message', messageHandler); worker.off('error', errorHandler); worker.off('exit', exitHandler);
  }
}

export async function runOffline(wavPath: string | undefined, threshold = .25, convert = false, referenceExe?: string, silenceControl = false, warm = false) {
  if (warm && (threshold !== .25 || convert || referenceExe || silenceControl || !wavPath)) throw new SpikeError('ARGUMENT_INVALID');
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) throw new SpikeError('THRESHOLD_INVALID');
  const { loadAssets, defaultRoot } = await import(new URL('./server.mjs', import.meta.url).href);
  const { auditTokens } = await import(new URL('./audit-tokens.mjs', import.meta.url).href);
  const assets = await loadAssets().catch(() => { throw new SpikeError('MODEL_ASSETS_UNAVAILABLE'); });
  const manifest: Manifest = assets.manifest;
  const audit = auditTokens(assets.files.get('/assets/model/bpe.model'), assets.files.get('/assets/model/tokens.txt').toString('utf8'), manifest.keywords);
  const configuration = { model: manifest.model, keywords: manifest.keywords,
    threshold, score: 1, maxActivePaths: 4, cooldownMs: 1000, modelHashes: manifest.files.filter(f => f.name.startsWith('model/')).map(f => ({ name: f.name, sha256: f.sha256 })) };
  if (!wavPath) return { mode: 'TOKEN_AUDIT_ONLY', configuration, audit };
  if (audit.state === 'INCOMPATIBLE' || audit.state === 'AUDIT_INVALID') throw new SpikeError('TOKEN_AUDIT_BLOCKED');
  const path = await realpath(wavPath), repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const ignoredRoot = await realpath(resolve(repoRoot, '.local'));
  const localPath = relative(ignoredRoot, path);
  if (!localPath || localPath === '..' || localPath.startsWith('..' + sep) || isAbsolute(localPath)) throw new SpikeError('AUDIO_LOCATION_NOT_ALLOWED');
  if ((await stat(path)).size > 32 * 1024 * 1024) throw new SpikeError('WAV_TOO_LONG');
  const bytes = await readFile(path);
  const wavSha256 = createHash('sha256').update(bytes).digest('hex');
  let decoded: ReturnType<typeof decodeWav>;
  try { decoded = decodeWav(bytes, convert); } finally { bytes.fill(0); }
  if (referenceExe && (decoded.source.sampleRate !== 16000 || decoded.source.channels !== 1 || decoded.source.format !== 1)) {
    decoded.pcm.fill(0); throw new SpikeError('REFERENCE_REQUIRES_CANONICAL_PCM16');
  }
  if (silenceControl && referenceExe) { decoded.pcm.fill(0); throw new SpikeError('ARGUMENT_INVALID'); }
  // Explicit synthetic control uses the authorized WAV only as a duration/format template.
  if (silenceControl) decoded.pcm.fill(0);
  // Hash canonical float32 LE samples before transfer, without exporting audio.
  const canonical = Buffer.alloc(decoded.pcm.length * 4);
  decoded.pcm.forEach((value, i) => canonical.writeFloatLE(value, i * 4));
  const pcmSha256 = createHash('sha256').update(canonical).digest('hex'); canonical.fill(0);
  const models: Record<string, ArrayBuffer> = {};
  for (const name of ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt']) {
    const buffer = assets.files.get('/assets/model/' + name)!;
    models[name] = Uint8Array.from(buffer).buffer;
  }
  let worker: Worker | undefined;
  try {
    worker = new Worker(new URL('./offline-worker.mjs', import.meta.url), {
      workerData: { runtimePath: resolve(defaultRoot, 'runtime/core.js'), models, keywords: manifest.keywords, threshold, warm, pcm: decoded.pcm.buffer },
      transferList: [decoded.pcm.buffer, ...Object.values(models)], stdout: true, stderr: true
    });
    worker.stdout?.resume(); worker.stderr?.resume();
    const result = await waitOfflineResult(worker, warm);
    const reference = referenceExe ? await (await import(new URL('./reference.mjs', import.meta.url).href))
      .runReference(referenceExe, path, defaultRoot, manifest.keywords, threshold, decoded.source.frames)
      : { state: 'NOT_CONFIGURED' };
    return { mode: silenceControl ? 'SYNTHETIC_SILENCE_CONTROL' : 'LOCAL_WAV_WASM', configuration, audit, source: decoded.source, conversion: decoded.conversion, wavSha256, pcmSha256, result, reference };
  } finally {
    if (worker) await worker.terminate();
    if (decoded.pcm.byteLength) decoded.pcm.fill(0);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let path: string | undefined, threshold = .25, convert = false, reference: string | undefined, auditOnly = false, silenceControl = false, warm = false;
    for (let i = 2; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg === '--warm') warm = true;
      else if (arg === '--silence-control') silenceControl = true;
      else if (arg === '--threshold') threshold = Number(process.argv[++i]);
      else if (arg === '--convert') convert = true;
      else if (arg === '--reference-exe') { reference = process.argv[++i]; if (!reference) throw new SpikeError('ARGUMENT_INVALID'); }
      else if (arg === '--audit-only') auditOnly = true;
      else if (arg?.startsWith('-') || path) throw new SpikeError('ARGUMENT_INVALID');
      else path = arg;
    }
    if ((silenceControl && (!path || reference)) || (auditOnly && (path || reference || convert || silenceControl))) throw new SpikeError('ARGUMENT_INVALID');
    console.log(JSON.stringify(await runOffline(path, threshold, convert, reference, silenceControl, warm), null, 2));
  } catch (error) {
    // Never print native messages, filenames, transcripts or input data.
    const codes = ['WARMUP_UNSUPPORTED', 'WARMUP_LIMIT', 'WARMUP_TIMEOUT', 'WARMUP_RESET_FAILED', 'MODEL_ASSETS_UNAVAILABLE', 'THRESHOLD_INVALID', 'AUDIO_LOCATION_NOT_ALLOWED', 'TOKEN_AUDIT_BLOCKED', 'WAV_TOO_LONG', 'WAV_INVALID', 'WAV_INVALID_PCM', 'WAV_CONVERSION_REQUIRED', 'WAV_CONVERSION_RANGE', 'OFFLINE_TIMEOUT', 'ARGUMENT_INVALID', 'REFERENCE_REQUIRES_CANONICAL_PCM16'];
    console.error(error instanceof SpikeError && codes.includes(error.code) ? error.code : 'OFFLINE_CHECK_FAILED'); process.exitCode = 1;
  }
}
