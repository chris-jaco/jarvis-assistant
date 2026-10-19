// Four reusable 100 ms blocks: at most 400 ms / 25,600 bytes of PCM.
// The rendering thread never waits for a UI-thread acknowledgement.
class AtlasPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.free = Array.from({ length: 4 }, () => new Float32Array(1600));
    this.buffer = null; this.offset = 0; this.sequence = 0; this.pending = new Set(); this.active = true;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'connect' && !this.audioPort) {
        this.audioPort = data.port;
        this.audioPort.onmessage = ({ data: returned }) => {
          if (!this.active) return;
          if (returned.type !== 'recycle' || !this.pending.delete(returned.sequence)
            || !(returned.pcm instanceof ArrayBuffer) || returned.pcm.byteLength !== 6400) {
            this.fail('AUDIO_PROTOCOL_ERROR'); return;
          }
          const buffer = new Float32Array(returned.pcm); buffer.fill(0); this.free.push(buffer);
        };
        this.audioPort.start(); this.port.postMessage({ type: 'connected' });
      }
      if (data === 'stop') this.release();
    };
  }
  release() {
    this.active = false; this.buffer?.fill(0); this.buffer = null;
    for (const buffer of this.free) buffer.fill(0);
    this.free = []; this.pending.clear(); this.audioPort?.close();
  }
  fail(code) {
    this.port.postMessage({ type: 'overrun', code, produced: this.sequence, outstanding: this.pending.size });
    this.release();
  }
  process(inputs) {
    if (!this.active) return false;
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    if (!this.audioPort) { this.fail('AUDIO_PROTOCOL_ERROR'); return false; }
    for (const sample of channel) {
      if (!this.buffer) {
        this.buffer = this.free.pop();
        if (!this.buffer) { this.fail('AUDIO_OVERRUN'); return false; }
      }
      this.buffer[this.offset++] = sample;
      if (this.offset === 1600) {
        const sequence = this.sequence++;
        this.pending.add(sequence);
        this.audioPort.postMessage({ type: 'pcm', pcm: this.buffer.buffer, sequence, outstanding: this.pending.size }, [this.buffer.buffer]);
        this.buffer = null; this.offset = 0;
      }
    }
    return true; // Output remains silent. No PCM is retained outside this bounded pool.
  }
}
registerProcessor('atlas-pcm', AtlasPcm);
