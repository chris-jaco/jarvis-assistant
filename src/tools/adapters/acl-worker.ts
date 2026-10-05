import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { ToolError } from '../types.js';
// A process transport, NOT an authorization cache. Each newline request runs a
// fresh ACL audit. Exactly one active request; fixed protocol, bounded output,
// cancellation kills the worker, idle shutdown, and no stdout/stderr forwarding.
export class AclWorker {
  private child?: ChildProcessWithoutNullStreams;
  private tail: Promise<unknown> = Promise.resolve();
  private active?: { finish(error?: ToolError): void };
  private output = '';
  private closed = false;
  private idle?: ReturnType<typeof setTimeout>;
  constructor(private readonly start: () => ChildProcessWithoutNullStreams, private readonly timeoutMs = 10_000, private readonly idleMs = 60_000) {}
  check(payload: string, signal?: AbortSignal): Promise<void> {
    const request = this.tail.catch(() => undefined).then(async () => { signal?.throwIfAborted(); if (this.closed) throw new ToolError('UNCONFIGURED'); await this.send(payload, signal); });
    this.tail = request; return request;
  }
  private references(referenced: boolean): void {
    this.child?.unref();
    for (const stream of [this.child?.stdin, this.child?.stdout, this.child?.stderr]) {
      const pipe = stream as unknown as { ref?(): void; unref?(): void } | undefined;
      if (referenced) pipe?.ref?.(); else pipe?.unref?.();
    }
  }
  private launch(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = this.start(); this.child = child; this.output = '';
    child.stderr.resume();
    const fail = () => { if (this.child === child) this.stop(new ToolError('UNCONFIGURED')); };
    child.on('error', fail); child.on('close', fail); child.stdin.on('error', fail);
    child.stdout.on('data', chunk => {
      if (this.child !== child) return;
      this.output += String(chunk);
      if (this.output.length > 16) { this.stop(new ToolError('UNCONFIGURED')); return; }
      const newline = this.output.indexOf('\n'); if (newline < 0) return;
      const response = this.output.slice(0, newline).replace(/\r$/, ''); const rest = this.output.slice(newline + 1); this.output = '';
      if (!this.active || rest || !['OK', 'FAIL'].includes(response)) { this.stop(new ToolError('UNCONFIGURED')); return; }
      this.active.finish(response === 'OK' ? undefined : new ToolError('UNCONFIGURED'));
    });
    return child;
  }
  private send(payload: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted(); clearTimeout(this.idle); this.idle = undefined;
    const child = this.launch(); this.references(true);
    return new Promise<void>((resolve, reject) => {
      let complete = false;
      const finish = (error?: ToolError) => {
        if (complete) return; complete = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); this.active = undefined;
        this.references(false);
        if (this.child === child) { this.idle = setTimeout(() => this.stop(), this.idleMs); this.idle.unref(); }
        if (error) reject(error); else resolve();
      };
      const abort = () => this.stop(new ToolError('TIMEOUT'));
      const timer = setTimeout(abort, this.timeoutMs);
      this.active = { finish }; signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else child.stdin.write(payload + '\n');
    });
  }
  private stop(error?: ToolError): void {
    clearTimeout(this.idle); this.idle = undefined;
    const child = this.child; this.child = undefined; this.output = '';
    this.active?.finish(error ?? new ToolError('UNCONFIGURED')); child?.stdin.destroy(); child?.kill();
  }
  close(): void { this.closed = true; this.stop(); }
}
