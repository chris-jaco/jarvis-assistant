import { PcmDetector, SpikeError } from './core.js';
import { measurePcm, SignalTotals } from './signal.js';
import { PcmTrace } from './trace.js';

let detector, module, audioPort, nextSequence = 0;
let wavTest = false;
const trace = new PcmTrace();
const signalTotals = new SignalTotals();
const diagnostics = { completed: 0, rawHits: 0, suppressedHits: 0, engineMaxMs: 0, recyclePostMaxMs: 0,
  beforeRecycleMaxMs: 0, withHits: { blocks: 0, maxMs: 0 }, withoutHits: { blocks: 0, maxMs: 0 }, recent: [] };
let currentTiming;
const timingHistory = [];
const timingState = { lastReceived: null, lastStarted: null, lastCompleted: null };
function stamp() {
  const localMs = performance.now(), origin = performance.timeOrigin;
  return { localMs, epochMs: Number.isFinite(origin) ? origin + localMs : null };
}
function stage(code) {
  const time = stamp();
  timingHistory.push({ sequence: currentTiming?.sequence ?? null, stage: code, ...time });
  if (timingHistory.length > 64) timingHistory.shift();
  diagnostics.timing = { ...timingState, clock: 'LOCAL_PERFORMANCE; CROSS_CONTEXT_ONLY_WHEN_BOTH_EPOCH_AVAILABLE',
    current: currentTiming ? { ...currentTiming } : null, history: timingHistory.slice() };
  return time;
}
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
      detector = new PcmDetector({
        processAudio(samples, rate) {
          timingState.lastStarted = currentTiming.sequence;
          currentTiming.inferenceStart = stamp(); stage(2);
          self.postMessage({ type: 'inference-start', sequence: currentTiming.sequence, timing: diagnostics.timing });
          try { return spotter.processAudio(samples, rate); }
          finally { currentTiming.inferenceEnd = stamp(); stage(3); }
        },
        dispose() { spotter.dispose(); }
      });
      self.postMessage({ type: 'ready', wasmHeapBytes: module.HEAPU8.byteLength,
        config: { threshold: data.threshold, score: 1, maxActivePaths: 4, cooldownMs: 1000, keywords: data.keywords } });
    } else if (data.type === 'connect') {
      if (!detector || audioPort) throw new SpikeError('AUDIO_PROTOCOL_ERROR');
      wavTest = data.mode === 'wav-test';
      audioPort = data.port;
      audioPort.onmessage = ({ data: block }) => {
        const receivedAt = stamp(), started = receivedAt.localMs;
        currentTiming = undefined;
        try {
          if (block.type !== 'pcm' || block.sequence !== nextSequence++
            || !(block.pcm instanceof ArrayBuffer) || block.pcm.byteLength !== 6400) { diagnostics.sequenceError = true; throw new SpikeError('AUDIO_PROTOCOL_ERROR'); }
          const received = receivedAt;
          const sentEpoch = typeof block.timing?.epochMs === 'number' && Number.isFinite(block.timing.epochMs) ? block.timing.epochMs : null;
          currentTiming = { sequence: block.sequence, received, sentEpochMs: sentEpoch,
            deliveryMs: received.epochMs !== null && sentEpoch !== null ? received.epochMs - sentEpoch : null };
          timingState.lastReceived = block.sequence; stage(1);
          self.postMessage({ type: 'processing', sequence: block.sequence, startedAt: performance.timeOrigin + started });
          const validSamples = wavTest ? block.validSamples : 1600;
          if (!Number.isInteger(validSamples) || validSamples < 1 || validSamples > 1600) throw new SpikeError('AUDIO_PROTOCOL_ERROR');
          const pcm = new Float32Array(block.pcm, 0, validSamples);
          if (wavTest) trace.samplesIn(pcm, block.sequence);
          const signal = measurePcm(pcm, block.sampleRate, block.channels);
          signalTotals.add(signal);
          diagnostics.signal = { lastBlock: signal, aggregate: signalTotals.snapshot(), sequence: block.sequence,
            sequenceOrdered: true, inferenceRate: 16000, inferenceChannels: 1 };
          const result = detector.process(pcm, 16000);
          if (wavTest) { trace.hits(result.rawHits); diagnostics.trace = trace.snapshot(); }
          // Recycle immediately on the direct port, before sending optional UI telemetry.
          const beforeRecycleMs = performance.now() - started, recycleStart = performance.now();
          currentTiming.recyclePost = stamp();
          audioPort.postMessage({ type: 'recycle', pcm: block.pcm, sequence: block.sequence,
            timing: { recycleEpochMs: currentTiming.recyclePost.epochMs } }, [block.pcm]);
          const recyclePostMs = performance.now() - recycleStart;
          timingState.lastCompleted = block.sequence; stage(4);
          diagnostics.completed++; diagnostics.rawHits += result.rawHits; diagnostics.suppressedHits += result.suppressedHits;
          diagnostics.engineMaxMs = Math.max(diagnostics.engineMaxMs, result.engineMs);
          diagnostics.beforeRecycleMaxMs = Math.max(diagnostics.beforeRecycleMaxMs, beforeRecycleMs);
          diagnostics.recyclePostMaxMs = Math.max(diagnostics.recyclePostMaxMs, recyclePostMs);
          const group = result.rawHits ? diagnostics.withHits : diagnostics.withoutHits;
          group.blocks++; group.maxMs = Math.max(group.maxMs, result.engineMs);
          diagnostics.recent.push({ timing: { ...currentTiming }, sequence: block.sequence, engineMs: result.engineMs, beforeRecycleMs, recyclePostMs,
            rawHits: result.rawHits, suppressedHits: result.suppressedHits, outstandingAtSend: block.outstanding, signal });
          if (diagnostics.recent.length > 16) diagnostics.recent.shift();
          self.postMessage({ type: 'processed', ...result, sequence: block.sequence, outstanding: block.outstanding,
            workerMs: performance.now() - started, wasmHeapBytes: module.HEAPU8.byteLength, diagnostics });
        } catch {
          stage(5);
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
