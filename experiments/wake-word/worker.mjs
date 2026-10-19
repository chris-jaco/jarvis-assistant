import { PcmDetector, SpikeError } from './core.js';

let detector, module;
function noNetwork() { throw new SpikeError('NETWORK_DISABLED'); }
// Suppress third-party native/JS diagnostic text. Only closed error codes leave this worker.
for (const key of ['log', 'info', 'warn', 'error', 'debug']) console[key] = () => {};
function blockNetwork() {
  for (const key of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'RTCPeerConnection']) {
    Object.defineProperty(globalThis, key, { value: noNetwork, configurable: false, writable: false });
  }
}
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      if (module) throw new SpikeError('ALREADY_INITIALIZED');
      const api = await import('/assets/runtime/core.js');
      module = await api.initKWSModule();
      for (const name of ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt']) {
        const bytes = new Uint8Array(data.files[`model/${name}`]);
        module.FS.writeFile(`/${name}`, bytes); bytes.fill(0);
      }
      blockNetwork();
      const spotter = api.createKeywordSpotter(module, {
        model: { encoder: '/encoder.onnx', decoder: '/decoder.onnx', joiner: '/joiner.onnx', tokens: '/tokens.txt' },
        keywords: [{ label: 'Atlas', matches: data.keywords.map(tokens => ({ tokens })), score: 1, threshold: data.threshold }]
      });
      detector = new PcmDetector(spotter);
      self.postMessage({ type: 'ready', wasmHeapBytes: module.HEAPU8.byteLength });
    } else if (data.type === 'pcm') {
      if (!detector) throw new SpikeError('NOT_INITIALIZED');
      const result = detector.process(new Float32Array(data.pcm), 16000);
      self.postMessage({ type: 'processed', ...result, deliveredAt: data.deliveredAt, wasmHeapBytes: module.HEAPU8.byteLength });
    } else if (data.type === 'stop') {
      detector?.stop(); detector = undefined;
      module?.HEAPU8.fill(0); module = undefined;
      self.postMessage({ type: 'stopped' }); self.close();
    }
  } catch (error) {
    self.postMessage({ type: 'error', code: error instanceof SpikeError ? error.code : 'ENGINE_INITIALIZATION_FAILED' });
  }
};
