import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { replayPcm } from './replay.ts';
// All third-party logs stay in this worker and are drained without display by its parent.
for (const key of ['log', 'info', 'warn', 'error', 'debug']) console[key] = () => {};
let module, engine;
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
  const ownedEngine = engine; engine = undefined;
  const result = replayPcm(new Float32Array(workerData.pcm), ownedEngine);
  parentPort.postMessage({ ok: true, result });
} catch { parentPort.postMessage({ ok: false, code: 'OFFLINE_ENGINE_FAILED' }); }
finally {
  try { engine?.dispose(); } catch { }
  if (workerData.pcm.byteLength) new Uint8Array(workerData.pcm).fill(0);
  module?.HEAPU8.fill(0); parentPort.close();
}
