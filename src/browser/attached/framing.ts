import { MAX_PAYLOAD } from './protocol.js';
export function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (!payload.length || payload.length > MAX_PAYLOAD) throw new Error('INVALID_FRAME');
  const header = Buffer.alloc(4); header.writeUInt32LE(payload.length); return Buffer.concat([header, payload]);
}
// Native Messaging on supported Windows/macOS/Linux architectures uses LE.
export class FrameReader {
  private pending = Buffer.alloc(0); private length?: number; private failed = false;
  constructor(private readonly receive: (value: unknown) => void) {}
  push(chunk: Buffer): void {
    if (this.failed) throw new Error('INVALID_FRAME');
    try {
      // Consume incrementally; never allocate an untrusted advertised length.
      let offset = 0;
      while (offset < chunk.length) {
        const target = this.length ?? 4; const take = Math.min(target - this.pending.length, chunk.length - offset);
        this.pending = Buffer.concat([this.pending, chunk.subarray(offset, offset + take)]); offset += take;
        if (this.pending.length !== target) continue;
        if (this.length === undefined) { this.length = this.pending.readUInt32LE(); this.pending = Buffer.alloc(0); if (!this.length || this.length > MAX_PAYLOAD) throw new Error(); }
        else { const text = new TextDecoder('utf-8', { fatal: true }).decode(this.pending); this.length = undefined; this.pending = Buffer.alloc(0); this.receive(JSON.parse(text)); }
      }
    } catch { this.failed = true; this.pending = Buffer.alloc(0); throw new Error('INVALID_FRAME'); }
  }
  end(): void { if (this.pending.length || this.length !== undefined) throw new Error('INCOMPLETE_FRAME'); }
}
