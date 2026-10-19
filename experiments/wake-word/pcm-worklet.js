class AtlasPcm extends AudioWorkletProcessor {
  constructor() {
    super(); this.buffer = new Float32Array(1600); this.offset = 0; this.credit = true; this.active = true;
    this.port.onmessage = ({ data }) => {
      if (data === 'credit') this.credit = true;
      if (data === 'stop') { this.active = false; this.buffer.fill(0); }
    };
  }
  process(inputs) {
    if (!this.active) return false;
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const sample of channel) {
      this.buffer[this.offset++] = sample;
      if (this.offset === this.buffer.length) {
        if (!this.credit) { this.port.postMessage({ type: 'overrun' }); this.buffer.fill(0); this.active = false; return false; }
        this.credit = false;
        this.port.postMessage({ type: 'pcm', pcm: this.buffer.buffer }, [this.buffer.buffer]);
        this.buffer = new Float32Array(1600); this.offset = 0;
      }
    }
    return true; // No input is connected to audible output.
  }
}
registerProcessor('atlas-pcm', AtlasPcm);
