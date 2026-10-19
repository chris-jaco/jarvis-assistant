import { checkManifest, verifyBytes, ResourceScope, SpikeError } from './core.js';
import type { Manifest } from './core.js';

const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
const load = button('load'), listen = button('listen'), stopButton = button('stop');
const status = document.getElementById('status')!, metrics = document.getElementById('metrics')!, events = document.getElementById('events')!;
let scope: ResourceScope | undefined, worker: Worker | undefined, worklet: AudioWorkletNode | undefined;
let stream: MediaStream | undefined, generation = 0, live = false, preparing = false;
let count = 0, processedMs = 0, pcmMs = 0, blocks = 0;
const engineTimes: number[] = [], deliveries: number[] = [];
const originalFetch = globalThis.fetch;
let restoreNetwork: (() => void) | undefined;
function blockNetwork() {
  const names = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'RTCPeerConnection'];
  const descriptors = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  function denyNetwork() { throw new SpikeError('NETWORK_DISABLED'); }
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: denyNetwork });
  return () => { for (const [name, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); };
}
async function stop(code = 'DETENIDO') {
  ++generation; live = false; preparing = false;
  listen.disabled = true; stopButton.disabled = true;
  stream?.getTracks().forEach(track => track.stop());
  const released = !stream || stream.getTracks().every(track => track.readyState === 'ended'); stream = undefined;
  worklet?.port.postMessage('stop'); worklet = undefined;
  worker?.postMessage({ type: 'stop' });
  const release = scope; scope = undefined;
  try { await release?.stop(); status.textContent = `${code} — tracks terminados: ${released}`; }
  catch { status.textContent = 'RELEASE_FAILED'; }
  restoreNetwork?.(); restoreNetwork = undefined; worker = undefined;
  load.disabled = false;
}
function render(wasmHeapBytes = 0) {
  const percentile = (values: number[]) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1]!.toFixed(1) : '—';
  metrics.textContent = `Detecciones: ${count}; bloques: ${blocks}\nInferencia p95: ${percentile(engineTimes)} ms; entrega de bloque p95: ${percentile(deliveries)} ms\nTrabajo inferencia/audio: ${pcmMs ? (100 * processedMs / pcmMs).toFixed(1) : '—'} % (no CPU OS)\nHeap WASM reservado: ${(wasmHeapBytes / 1048576).toFixed(1)} MiB`;
}
load.onclick = async () => {
  if (scope || preparing) return;
  preparing = true; load.disabled = true; stopButton.disabled = false;
  const current = ++generation, resources = new ResourceScope(); scope = resources;
  status.textContent = 'PREPARANDO — micrófono cerrado';
  try {
    const abort = new AbortController(); resources.add(() => abort.abort());
    const response = await originalFetch('/manifest.json', { signal: abort.signal });
    if (!response.ok) throw new SpikeError('MODEL_MISSING');
    const manifest: unknown = await response.json(); checkManifest(manifest);
    const data: Record<string, ArrayBuffer> = {};
    for (const asset of manifest.files) {
      const r = await originalFetch(`/assets/${asset.name}`, { signal: abort.signal });
      if (!r.ok) throw new SpikeError('MODEL_MISSING');
      const bytes = new Uint8Array(await r.arrayBuffer()); await verifyBytes(asset, bytes);
      if (asset.name.startsWith('model/') && !asset.name.endsWith('README.md') && !asset.name.endsWith('bpe.model')) data[asset.name] = bytes.buffer;
      else bytes.fill(0);
    }
    if (current !== generation) { Object.values(data).forEach(b => new Uint8Array(b).fill(0)); return; }
    worker = new Worker('/worker.mjs', { type: 'module' });
    const engineWorker = worker; resources.add(() => engineWorker.terminate());
    const threshold = Number((document.getElementById('threshold') as HTMLInputElement).value);
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) throw new SpikeError('THRESHOLD_INVALID');
    let timeout: ReturnType<typeof setTimeout>;
    const ready = new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new SpikeError('INITIALIZATION_TIMEOUT')), 60_000);
      resources.add(() => { clearTimeout(timeout); reject(new SpikeError('CANCELLED')); });
      engineWorker.onmessage = ({ data: message }) => {
        if (current !== generation) return;
        if (message.type === 'ready') { render(message.wasmHeapBytes); resolve(); }
        if (message.type === 'error') reject(new SpikeError('ENGINE_INITIALIZATION_FAILED'));
      };
      engineWorker.onerror = () => reject(new SpikeError('ENGINE_INITIALIZATION_FAILED'));
    });
    engineWorker.postMessage({ type: 'init', files: data, keywords: (manifest as Manifest).keywords, threshold }, Object.values(data));
    try { await ready; } finally { clearTimeout(timeout!); }
    if (current !== generation) return;
    preparing = false; listen.disabled = false; status.textContent = 'LISTO — micrófono cerrado';
  } catch { if (current === generation) await stop('INITIALIZATION_FAILED'); }
};
listen.onclick = async () => {
  if (!worker || live || preparing || !scope) return;
  listen.disabled = true; preparing = true;
  const current = generation, resources = scope, engineWorker = worker;
  try {
    const context = new AudioContext({ sampleRate: 16000 });
    resources.add(() => context.close()); await context.resume();
    context.onstatechange = () => { if (live && context.state !== 'running') void stop('AUDIO_CONTEXT_SUSPENDED'); };
    if (current !== generation) return;
    if (context.sampleRate !== 16000 || context.state !== 'running') throw new SpikeError('AUDIO_CONTEXT_UNAVAILABLE');
    await context.audioWorklet.addModule('/pcm-worklet.js');
    if (current !== generation) return;
    const capture = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    if (current !== generation) { capture.getTracks().forEach(t => t.stop()); return; }
    stream = capture; resources.add(() => capture.getTracks().forEach(track => track.stop()));
    const source = context.createMediaStreamSource(capture);
    const node = new AudioWorkletNode(context, 'atlas-pcm', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] }); worklet = node;
    const mute = context.createGain(); mute.gain.value = 0;
    source.connect(node); node.connect(mute); mute.connect(context.destination);
    resources.add(() => { source.disconnect(); node.disconnect(); mute.disconnect(); node.port.close(); });
    capture.getAudioTracks().forEach(track => track.addEventListener('ended', () => { if (live) void stop('MICROPHONE_LOST'); }));
    node.port.onmessage = ({ data }) => {
      if (!live || current !== generation) return;
      if (data.type === 'overrun') { void stop('AUDIO_OVERRUN'); return; }
      engineWorker.postMessage({ type: 'pcm', pcm: data.pcm, deliveredAt: performance.now() }, [data.pcm]);
    };
    engineWorker.onmessage = ({ data }) => {
      if (!live || current !== generation) return;
      if (data.type === 'error') { void stop('ENGINE_FAILED'); return; }
      if (data.type !== 'processed') return;
      node.port.postMessage('credit'); blocks++; processedMs += data.engineMs; pcmMs += data.pcmMs;
      // Bounded scalar telemetry only. Never retain audio or transcripts.
      engineTimes.push(data.engineMs); deliveries.push(Math.max(0, performance.now() - data.deliveredAt));
      if (engineTimes.length > 1000) engineTimes.shift(); if (deliveries.length > 1000) deliveries.shift();
      if (data.detected) {
        count++;
        const scenario = ['accent', 'distance', 'noise'].map(id => (document.getElementById(id) as HTMLSelectElement).value).join(' / ');
        events.textContent = `Atlas #${count} — ${scenario}\n` + events.textContent!.split('\n').slice(0, 19).join('\n');
      }
      render(data.wasmHeapBytes);
    };
    engineWorker.onerror = () => { if (current === generation) void stop('ENGINE_FAILED'); };
    restoreNetwork = blockNetwork(); live = true; preparing = false;
    status.textContent = 'ESCUCHA LOCAL — sin OpenAI, sin grabación';
  } catch { if (current === generation) await stop('AUDIO_START_FAILED'); }
};
stopButton.onclick = () => { void stop(); };
window.addEventListener('pagehide', () => { void stop(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) void stop('SUSPENDIDO'); });
navigator.mediaDevices?.addEventListener('devicechange', () => { if (live) void stop('DEVICE_CHANGED'); });
