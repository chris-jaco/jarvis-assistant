// Four reusable 100 ms blocks: at most 400 ms / 25,600 bytes of PCM.
// The rendering thread never waits for a UI-thread acknowledgement.
class AtlasPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.free = Array.from({ length: 4 }, () => new Float32Array(1600));
    this.buffer = null; this.offset = 0; this.sequence = 0; this.pending = new Map(); this.active = true;
    this.frames = 0; this.returned = 0; this.highWater = 0; this.returnAudioMaxMs = 0; this.returnWallMaxMs = null; this.recent = [];
    this.wavWaitQuanta = 0; this.wavWaitFrames = 0; this.channelTotals = []; this.channelsTruncated = false;
    this.observedChannels = 0; this.blockChannels = new Set();
    this.wavMode = false; this.wavDone = false; this.wavOffset = 0; this.wav = null; this.wavArmed = false;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'wav-source') {
        if (this.frames || this.wavMode || !(data.pcm instanceof ArrayBuffer) || data.pcm.byteLength < 4
          || data.pcm.byteLength % 4 || data.pcm.byteLength > 16000 * 300 * 4) { this.fail('AUDIO_PROTOCOL_ERROR'); return; }
        this.wavMode = true; this.wav = new Float32Array(data.pcm);
        this.port.postMessage({ type: 'wav-ready' });
      }
      if (data?.type === 'connect' && !this.audioPort) {
        this.audioPort = data.port;
        this.audioPort.onmessage = ({ data: returned }) => {
          if (!this.active) return;
          const sent = this.pending.get(returned.sequence);
          if (returned.type !== 'recycle' || !sent
            || !(returned.pcm instanceof ArrayBuffer) || returned.pcm.byteLength !== 6400) {
            this.fail('AUDIO_PROTOCOL_ERROR'); return;
          }
          this.pending.delete(returned.sequence); this.returned++;
          const audioMs = (this.frames - sent.frame) / 16, wall = this.wallNow();
          const wallMs = wall === null || sent.wall === null ? null : Math.max(0, wall - sent.wall);
          this.returnAudioMaxMs = Math.max(this.returnAudioMaxMs, audioMs);
          if (wallMs !== null) this.returnWallMaxMs = Math.max(this.returnWallMaxMs ?? 0, wallMs);
          const buffer = new Float32Array(returned.pcm); buffer.fill(0); this.free.push(buffer);
          this.record({ event: 'recycle', sequence: returned.sequence, pending: this.pending.size, audioMs, wallMs });
          if (this.returned % 10 === 0) this.port.postMessage({ type: 'transport', diagnostics: this.snapshot() });
          this.finishWav();
        };
        this.audioPort.start(); this.port.postMessage({ type: 'connected' });
      }
      if (data === 'stop') this.release();
      if (data === 'wav-start' && this.wavMode && !this.wavDone) this.wavArmed = true;
    };
  }
  wallNow() { return typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : null; }
  record(event) { this.recent.push(event); if (this.recent.length > 16) this.recent.shift(); }
  snapshot() {
    const oldest = this.pending.values().next().value, wall = this.wallNow();
    return { produced: this.sequence, returned: this.returned, outstanding: this.pending.size, highWater: this.highWater,
      returnAudioMaxMs: this.returnAudioMaxMs, returnWallMaxMs: this.returnWallMaxMs,
      oldestAudioMs: oldest ? (this.frames - oldest.frame) / 16 : 0,
      oldestWallMs: oldest && wall !== null && oldest.wall !== null ? Math.max(0, wall - oldest.wall) : null,
      recent: this.recent.slice(),
      wavBackpressure: { waitQuanta: this.wavWaitQuanta, waitRenderFrames: this.wavWaitFrames,
        waitRenderMs: this.wavWaitFrames / 16, policy: 'PAUSE_FILE_CURSOR_NO_PADDING' },
      inputChannels: this.channelTotals.map((s, index) => ({ index, samples: s.samples,
        rms: s.finite ? Math.sqrt(s.squares / s.finite) : null, peak: s.finite ? s.peak : null,
        nearZeroPercent: s.samples ? 100 * s.nearZero / s.samples : 0,
        clippedSamples: s.clipped, invalidSamples: s.invalid })), channelsTruncated: this.channelsTruncated };
  }
  measureChannels(channels) {
    // Bounded scalar totals only; never retain input arrays or change channel selection.
    if (channels.length > 8) this.channelsTruncated = true;
    for (let i = 0; i < Math.min(8, channels.length); i++) {
      const s = this.channelTotals[i] ??= { samples: 0, finite: 0, squares: 0, peak: 0, nearZero: 0, clipped: 0, invalid: 0 };
      for (const v of channels[i]) {
        s.samples++;
        if (!Number.isFinite(v)) { s.invalid++; continue; }
        s.finite++; s.squares += v * v; s.peak = Math.max(s.peak, Math.abs(v));
        if (Math.abs(v) <= 1e-5) s.nearZero++;
        if (Math.abs(v) >= .999) s.clipped++;
        if (Math.abs(v) > 1) s.invalid++;
      }
    }
  }
  release() {
    this.wav?.fill(0); this.wav = null;
    this.active = false; this.buffer?.fill(0); this.buffer = null;
    for (const buffer of this.free) buffer.fill(0);
    this.free = []; this.pending.clear(); this.audioPort?.close();
  }
  finishWav() {
    if (this.wavMode && this.wavDone && this.pending.size === 0 && this.active) {
      this.port.postMessage({ type: 'wav-complete', diagnostics: this.snapshot(), samples: this.frames });
      this.release();
    }
  }
  sendBlock() {
    const sequence = this.sequence++;
    this.pending.set(sequence, { frame: this.frames, wall: this.wallNow() });
    this.highWater = Math.max(this.highWater, this.pending.size);
    this.record({ event: 'send', sequence, pending: this.pending.size });
    this.audioPort.postMessage({ type: 'pcm', pcm: this.buffer.buffer, sequence, outstanding: this.pending.size,
      sampleRate: typeof sampleRate === 'number' ? sampleRate : 16000,
      channels: this.blockChannels.size === 1 ? this.observedChannels : 0,
      validSamples: this.offset }, [this.buffer.buffer]);
    this.blockChannels.clear(); this.buffer = null; this.offset = 0;
  }
  fail(code) {
    this.port.postMessage({ type: 'overrun', code, produced: this.sequence, outstanding: this.pending.size, diagnostics: this.snapshot() });
    this.release();
  }
  process(inputs, outputs = []) {
    if (!this.active) return false;
    if (this.wavMode && !this.wavArmed) return true;
    if (this.wavMode && this.wavDone) { this.finishWav(); return this.active; }
    const channel = this.wavMode ? this.wav.subarray(this.wavOffset, this.wavOffset + (outputs[0]?.[0]?.length ?? 128)) : inputs[0]?.[0];
    if (!channel) return true;
    if (!this.wavMode) this.measureChannels(inputs[0]);
    this.observedChannels = this.wavMode ? 1 : inputs[0].length;
    if (!this.audioPort) { this.fail('AUDIO_PROTOCOL_ERROR'); return false; }
    for (let i = 0; i < channel.length; i++) {
      const sample = channel[i];
      if (!this.buffer) {
        this.buffer = this.free.pop();
        if (!this.buffer) {
          if (this.wavMode) {
            // File input is rewindable: do not consume this sample or inject silence into the decoder.
            this.wavWaitQuanta++; this.wavWaitFrames += channel.length - i;
            return true;
          }
          this.fail('AUDIO_OVERRUN'); return false;
        }
      }
      this.blockChannels.add(this.observedChannels);
      this.buffer[this.offset++] = sample; this.frames++;
      if (this.wavMode) this.wavOffset++;
      if (this.offset === 1600) {
        this.sendBlock();
      }
    }
    if (this.wavMode && this.wavOffset === this.wav.length) {
      if (this.offset) this.sendBlock();
      this.wavDone = true; this.wav.fill(0); this.wav = null; this.finishWav();
    }
    return true; // Output remains silent. No PCM is retained outside this bounded pool.
  }
}
registerProcessor('atlas-pcm', AtlasPcm);
