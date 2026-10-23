import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { replayPcm } from './replay.ts';
import { createWasmProfiler } from './profile.ts';
import { prepareWarm } from './warmup.ts';
import { SpikeError } from './core.ts';
// All third-party logs stay in this worker and are drained without display by its parent.
for (const key of ['log', 'info', 'warn', 'error', 'debug']) console[key] = () => {};
let module, engine, profiler;
try {
  const api = await import(pathToFileURL(workerData.runtimePath).href);
  module = await api.initKWSModule();
  for (const [name, data] of Object.entries(workerData.models)) {
    const bytes = new Uint8Array(data); module.FS.writeFile('/' + name, bytes); bytes.fill(0);
  }
  // Emscripten loaded local WASM via the Node filesystem. Inference has no downloader.
  function noNetwork() { throw Error('NETWORK_DISABLED'); }
  for (const key of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport']) Object.defineProperty(globalThis, key, { value: noNetwork, configurable: false });
  engine = api.createKeywordSpotter(module, {
    model: { encoder: '/encoder.onnx', decoder: '/decoder.onnx', joiner: '/joiner.onnx', tokens: '/tokens.txt' },
    keywords: [{ label: 'Atlas', matches: workerData.keywords.map(tokens => ({ tokens })), score: 1, threshold: workerData.threshold }], maxActivePaths: 4
  });
  let preparation = { state: 'NOT_REQUESTED' };
  if (workerData.warm) {
    if (workerData.threshold !== .25) throw new SpikeError('ARGUMENT_INVALID');
    parentPort.postMessage({ phase: 'WARMUP_START' });
    preparation = prepareWarm(module, engine);
    parentPort.postMessage({ phase: 'WARMUP_END' });
  }
  profiler = createWasmProfiler(module, undefined, undefined, 3000); engine = profiler.wrapEngine(engine);
  const ownedEngine = engine; engine = undefined;
  const result = replayPcm(new Float32Array(workerData.pcm), ownedEngine);
  parentPort.postMessage({ ok: true, result: { ...result, experimentMode: workerData.warm ? 'WARM' : 'COLD', preparation, wasmProfile: profiler.snapshot() } });
} catch (error) {
  const allowed = ['WARMUP_UNSUPPORTED', 'WARMUP_LIMIT', 'WARMUP_TIMEOUT', 'WARMUP_RESET_FAILED'];
  parentPort.postMessage({ ok: false, code: error instanceof SpikeError && allowed.includes(error.code) ? error.code : 'OFFLINE_ENGINE_FAILED' });
}
finally {
  try { engine?.dispose(); } catch { }
  if (workerData.pcm.byteLength) new Uint8Array(workerData.pcm).fill(0);
  profiler?.restore();
  module?.HEAPU8.fill(0); parentPort.close();
}
