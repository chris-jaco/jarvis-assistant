// Four reusable 100 ms blocks: at most 400 ms / 25,600 bytes of PCM.
// The rendering thread never waits for a UI-thread acknowledgement.
class AtlasPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.free = Array.from({ length: 4 }, () => new Float32Array(1600));
    this.buffer = null; this.offset = 0; this.sequence = 0; this.pending = new Map(); this.active = true;
    this.frames = 0; this.returned = 0; this.highWater = 0; this.returnAudioMaxMs = 0; this.returnWallMaxMs = null; this.recent = [];
    this.observedChannels = 0; this.blockChannels = new Set();
    this.port.onmessage = ({ data }) => {
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
        };
        this.audioPort.start(); this.port.postMessage({ type: 'connected' });
      }
      if (data === 'stop') this.release();
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
      recent: this.recent.slice() };
  }
  release() {
    this.active = false; this.buffer?.fill(0); this.buffer = null;
    for (const buffer of this.free) buffer.fill(0);
    this.free = []; this.pending.clear(); this.audioPort?.close();
  }
  fail(code) {
    this.port.postMessage({ type: 'overrun', code, produced: this.sequence, outstanding: this.pending.size, diagnostics: this.snapshot() });
    this.release();
  }
  process(inputs) {
    if (!this.active) return false;
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    this.observedChannels = inputs[0].length;
    if (!this.audioPort) { this.fail('AUDIO_PROTOCOL_ERROR'); return false; }
    for (const sample of channel) {
      if (!this.buffer) {
        this.buffer = this.free.pop();
        if (!this.buffer) { this.fail('AUDIO_OVERRUN'); return false; }
      }
      this.blockChannels.add(this.observedChannels);
      this.buffer[this.offset++] = sample; this.frames++;
      if (this.offset === 1600) {
        const sequence = this.sequence++;
        this.pending.set(sequence, { frame: this.frames, wall: this.wallNow() });
        this.highWater = Math.max(this.highWater, this.pending.size);
        this.record({ event: 'send', sequence, pending: this.pending.size });
        this.audioPort.postMessage({ type: 'pcm', pcm: this.buffer.buffer, sequence, outstanding: this.pending.size,
          sampleRate: typeof sampleRate === 'number' ? sampleRate : 16000,
          channels: this.blockChannels.size === 1 ? this.observedChannels : 0 }, [this.buffer.buffer]);
        this.blockChannels.clear();
        this.buffer = null; this.offset = 0;
      }
    }
    return true; // Output remains silent. No PCM is retained outside this bounded pool.
  }
}
registerProcessor('atlas-pcm', AtlasPcm);
