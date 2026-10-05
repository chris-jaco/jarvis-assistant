import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import { FrameReader, frame } from './framing.js';
import { uuid, responseSchema, eventSchema, helloSchema } from './protocol.js';
import type { Request, Reply } from './protocol.js';
export interface BrowserTransport {
  readonly epoch: string;
  connections(): string[];
  request(connection: string, request: Request, signal: AbortSignal): Promise<Reply>;
  subscribe(listener: (connection: string, event: z.infer<typeof eventSchema>) => void): () => void;
  close(): void;
}
const packet = z.discriminatedUnion('kind', [z.object({ kind: z.literal('connected'), connectionId: uuid }).strict(), z.object({ kind: z.literal('disconnected'), connectionId: uuid }).strict(), z.object({ kind: z.literal('message'), connectionId: uuid, message: z.union([responseSchema, eventSchema]) }).strict()]);
export class NativeTransport implements BrowserTransport {
  private currentEpoch = randomUUID(); get epoch(): string { return this.currentEpoch; } private child?: ChildProcessWithoutNullStreams;
  private channels = new Set<string>(); private closed = false;
  private listeners = new Set<(connection: string, event: z.infer<typeof eventSchema>) => void>();
  private pending = new Map<string, { connection: string; session: string; finish(reply: Reply): void }>();
  constructor(private readonly executable: string | undefined, private readonly extensionId: string | undefined) {}
  private start(): void {
    if (this.child || this.closed) return;
    if (!this.executable || !isAbsolute(this.executable) || !this.extensionId || !/^[a-p]{32}$/.test(this.extensionId)) return;
    const child = spawn(this.executable, ['--broker', this.extensionId], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); this.child = child;
    child.stderr.resume(); // No child/path/security detail is exposed.
    const reader = new FrameReader(raw => {
      const p = packet.parse(raw);
      if (p.kind === 'connected') { if (this.channels.size >= 10) throw new Error(); this.channels.add(p.connectionId); this.send(p.connectionId, helloSchema.parse({ protocol: 'atlas.browser', version: 1, kind: 'hello', connectionEpoch: this.epoch })); }
      else if (p.kind === 'disconnected') this.drop(p.connectionId);
      else if (this.channels.has(p.connectionId) && p.message.connectionEpoch === this.epoch) {
        if (p.message.kind === 'response') { const waiting = this.pending.get(p.message.requestId); if (waiting?.connection === p.connectionId && waiting.session === p.message.backendSessionId) waiting.finish(p.message.reply); }
        else for (const listener of this.listeners) listener(p.connectionId, p.message);
      }
    });
    child.stdout.on('data', chunk => { try { reader.push(Buffer.from(chunk)); } catch { this.stop(); } });
    child.on('close', () => { try { reader.end(); } catch { /* Disconnection below invalidates requests. */ } if (this.child === child) this.stop(); });
    child.on('error', () => this.stop()); child.stdin.on('error', () => this.stop());
  }
  connections(): string[] { this.start(); return [...this.channels]; }
  private send(connectionId: string, message: unknown): void { this.child?.stdin.write(frame({ kind: 'message', connectionId, message })); }
  async request(connection: string, request: Request, signal: AbortSignal): Promise<Reply> {
    this.start(); if (signal.aborted || request.deadlineAt <= Date.now()) return { outcome: 'ERROR', code: 'TIMEOUT' };
    if (!this.channels.has(connection)) return { outcome: 'ERROR', code: 'DISCONNECTED' };
    if (this.pending.size >= 100 || this.pending.has(request.requestId)) return { outcome: 'ERROR', code: 'REJECTED' };
    return new Promise(resolve => {
      let finished = false;
      const finish = (reply: Reply) => { if (finished) return; finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort); this.pending.delete(request.requestId); resolve(reply); };
      const abort = () => { this.send(connection, { protocol: 'atlas.browser', version: 1, kind: 'cancel', requestId: request.requestId, backendSessionId: request.backendSessionId, connectionEpoch: this.epoch }); finish({ outcome: 'ERROR', code: 'EXECUTION_UNKNOWN' }); };
      const timer = setTimeout(abort, Math.max(1, request.deadlineAt - Date.now()));
      this.pending.set(request.requestId, { connection, session: request.backendSessionId, finish }); signal.addEventListener('abort', abort, { once: true });
      try { this.send(connection, request); } catch { finish({ outcome: 'ERROR', code: 'INVALID_INPUT' }); }
      if (signal.aborted) abort();
    });
  }
  subscribe(listener: (connection: string, event: z.infer<typeof eventSchema>) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private drop(connection: string): void { this.channels.delete(connection); for (const waiting of [...this.pending.values()]) if (waiting.connection === connection) waiting.finish({ outcome: 'ERROR', code: 'EXECUTION_UNKNOWN' }); }
  private stop(): void { this.currentEpoch = randomUUID(); const child = this.child; this.child = undefined; for (const channel of [...this.channels]) this.drop(channel); child?.stdin.destroy(); child?.kill(); }
  close(): void { this.closed = true; this.stop(); this.listeners.clear(); }
}
