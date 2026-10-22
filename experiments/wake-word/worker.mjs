import { PcmDetector, SpikeError } from './core.js';
import { measurePcm, SignalTotals } from './signal.js';

let detector, module, audioPort, nextSequence = 0;
const signalTotals = new SignalTotals();
const diagnostics = { completed: 0, rawHits: 0, suppressedHits: 0, engineMaxMs: 0, recyclePostMaxMs: 0,
  beforeRecycleMaxMs: 0, withHits: { blocks: 0, maxMs: 0 }, withoutHits: { blocks: 0, maxMs: 0 }, recent: [] };
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
        model: { encoder: '/encoder.onnx', decoder: '/decoder.onnx', joiner: '/joiner.onnx', tokens: '/tokens.txt' }, maxActivePaths: 4,
        keywords: [{ label: 'Atlas', matches: data.keywords.map(tokens => ({ tokens })), score: 1, threshold: data.threshold }]
      });
      detector = new PcmDetector(spotter);
      self.postMessage({ type: 'ready', wasmHeapBytes: module.HEAPU8.byteLength,
        config: { threshold: data.threshold, score: 1, maxActivePaths: 4, cooldownMs: 1000, keywords: data.keywords } });
    } else if (data.type === 'connect') {
      if (!detector || audioPort) throw new SpikeError('AUDIO_PROTOCOL_ERROR');
      audioPort = data.port;
      audioPort.onmessage = ({ data: block }) => {
        const started = performance.now();
        try {
          if (block.type !== 'pcm' || block.sequence !== nextSequence++
            || !(block.pcm instanceof ArrayBuffer) || block.pcm.byteLength !== 6400) { diagnostics.sequenceError = true; throw new SpikeError('AUDIO_PROTOCOL_ERROR'); }
          self.postMessage({ type: 'processing', sequence: block.sequence, startedAt: performance.timeOrigin + started });
          const signal = measurePcm(new Float32Array(block.pcm), block.sampleRate, block.channels);
          signalTotals.add(signal);
          diagnostics.signal = { lastBlock: signal, aggregate: signalTotals.snapshot(), sequence: block.sequence,
            sequenceOrdered: true, inferenceRate: 16000, inferenceChannels: 1 };
          const result = detector.process(new Float32Array(block.pcm), 16000);
          // Recycle immediately on the direct port, before sending optional UI telemetry.
          const beforeRecycleMs = performance.now() - started, recycleStart = performance.now();
          audioPort.postMessage({ type: 'recycle', pcm: block.pcm, sequence: block.sequence }, [block.pcm]);
          const recyclePostMs = performance.now() - recycleStart;
          diagnostics.completed++; diagnostics.rawHits += result.rawHits; diagnostics.suppressedHits += result.suppressedHits;
          diagnostics.engineMaxMs = Math.max(diagnostics.engineMaxMs, result.engineMs);
          diagnostics.beforeRecycleMaxMs = Math.max(diagnostics.beforeRecycleMaxMs, beforeRecycleMs);
          diagnostics.recyclePostMaxMs = Math.max(diagnostics.recyclePostMaxMs, recyclePostMs);
          const group = result.rawHits ? diagnostics.withHits : diagnostics.withoutHits;
          group.blocks++; group.maxMs = Math.max(group.maxMs, result.engineMs);
          diagnostics.recent.push({ sequence: block.sequence, engineMs: result.engineMs, beforeRecycleMs, recyclePostMs,
            rawHits: result.rawHits, suppressedHits: result.suppressedHits, outstandingAtSend: block.outstanding, signal });
          if (diagnostics.recent.length > 16) diagnostics.recent.shift();
          self.postMessage({ type: 'processed', ...result, sequence: block.sequence, outstanding: block.outstanding,
            workerMs: performance.now() - started, wasmHeapBytes: module.HEAPU8.byteLength, diagnostics });
        } catch {
          if (block.pcm instanceof ArrayBuffer && block.pcm.byteLength) new Uint8Array(block.pcm).fill(0);
          audioPort.close(); self.postMessage({ type: 'error', code: 'AUDIO_PROCESSING_FAILED', diagnostics });
        }
      };
      audioPort.start(); self.postMessage({ type: 'capture-ready' });
    } else if (data.type === 'stop') {
      audioPort?.close(); audioPort = undefined;
      detector?.stop(); detector = undefined;
      module?.HEAPU8.fill(0); module = undefined;
      self.postMessage({ type: 'stopped' }); self.close();
    }
  } catch (error) {
    self.postMessage({ type: 'error', code: error instanceof SpikeError ? error.code : 'ENGINE_INITIALIZATION_FAILED' });
  }
};
