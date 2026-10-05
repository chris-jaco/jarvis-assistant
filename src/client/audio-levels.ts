// Passive stream taps. Never request capture, stop tracks, connect to destination,
// change playback, or feed any signal back into WebRTC/VAD.
export interface AudioRuntime {
  context(): AudioContext;
  frame(callback: FrameRequestCallback): number;
  cancel(id: number): void;
}
interface Tap { source: MediaStreamAudioSourceNode; analyser: AnalyserNode; samples: Float32Array<ArrayBuffer> }
export function normalizedEnergy(samples: Float32Array): number {
  let squares = 0; for (const value of samples) squares += value * value;
  const rms = Math.sqrt(squares / Math.max(1, samples.length));
  if (!Number.isFinite(rms)) return 0;
  return Math.min(1, Math.sqrt(Math.max(0, rms - 0.003) / 0.2));
}
export function smoothEnergy(previous: number, next: number, seconds: number): number {
  return previous + (next - previous) * (1 - Math.exp(-Math.max(0, Math.min(seconds, 0.1)) * (next > previous ? 24 : 8)));
}
export class AudioLevels {
  private context?: AudioContext;
  private microphone?: Tap;
  private playback?: Tap;
  private output?: MediaStream;
  private frameId?: number;
  private previous = 0;
  private inputLevel = 0;
  private outputLevel = 0;
  private generation = 0;
  constructor(private readonly audio: HTMLAudioElement, private readonly levels: (input: number, output: number) => void, private readonly runtime: AudioRuntime = { context: () => new AudioContext(), frame: callback => requestAnimationFrame(callback), cancel: id => cancelAnimationFrame(id) }) {}
  // Called from the connect click after provider.connect() performs its synchronous
  // disconnect. Prime the context inside user activation (not a capture request).
  prepare(): void { this.stop(); try { this.context = this.runtime.context(); this.resume(); } catch { this.stop(); } }
  start(stream: MediaStream): void {
    if (!this.context || this.microphone) this.stop();
    try {
      this.context ??= this.runtime.context(); this.microphone = this.tap(stream);
      this.audio.addEventListener('loadedmetadata', this.syncOutput); this.syncOutput();
      this.resume(); this.schedule();
    } catch { this.stop(); } // Visualization availability must never break voice.
  }
  resume(): void { try { void this.context?.resume().catch(() => {}); } catch { /* No effect on playback. */ } }
  private tap(stream: MediaStream): Tap {
    const source = this.context!.createMediaStreamSource(stream);
    const analyser = this.context!.createAnalyser(); analyser.fftSize = 512;
    source.connect(analyser); return { source, analyser, samples: new Float32Array(analyser.fftSize) };
  }
  private syncOutput = (): void => {
    const value = this.audio.srcObject;
    const stream = value && 'getAudioTracks' in value ? value as MediaStream : undefined;
    if (stream === this.output) return;
    this.release(this.playback); this.playback = undefined; this.output = stream;
    try { if (stream?.getAudioTracks().length && this.context) this.playback = this.tap(stream); } catch { /* Continue microphone visualization. */ }
  };
  private read(tap?: Tap): number { if (!tap) return 0; tap.analyser.getFloatTimeDomainData(tap.samples); return normalizedEnergy(tap.samples); }
  private schedule(): void { const generation = this.generation; this.frameId = this.runtime.frame(time => { if (generation === this.generation) this.tick(time); }); }
  private tick = (time: number): void => {
    if (!this.context) return;
    try {
      this.syncOutput(); const seconds = this.previous ? (time - this.previous) / 1000 : 1 / 60; this.previous = time;
      this.inputLevel = smoothEnergy(this.inputLevel, this.read(this.microphone), seconds);
      // A suspended/muted/paused player is not audible assistant speech.
      const audible = !this.audio.paused && !this.audio.muted && this.audio.volume > 0;
      this.outputLevel = smoothEnergy(this.outputLevel, audible ? this.read(this.playback) * this.audio.volume : 0, seconds);
      this.levels(this.inputLevel, this.outputLevel); this.schedule();
    } catch { this.stop(); }
  };
  private release(tap?: Tap): void { try { tap?.source.disconnect(); } catch {} try { tap?.analyser.disconnect(); } catch {} }
  stop(): void {
    ++this.generation; if (this.frameId !== undefined) this.runtime.cancel(this.frameId); this.frameId = undefined;
    this.audio.removeEventListener('loadedmetadata', this.syncOutput);
    this.release(this.microphone); this.release(this.playback); this.microphone = this.playback = undefined; this.output = undefined;
    const context = this.context; this.context = undefined; try { void context?.close().catch(() => {}); } catch {}
    this.previous = this.inputLevel = this.outputLevel = 0; this.levels(0, 0);
  }
}
