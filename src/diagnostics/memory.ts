import { MemoryValidationError } from '../memory/validation.js';
import { ToolError } from '../tools/types.js';
export type MemoryOperation = 'read' | 'write' | 'search' | 'get' | 'remember' | 'update' | 'forget' | 'extract' | 'context' | 'config';
export type MemoryStage = 'queue' | 'lock' | 'directory' | 'security' | 'snapshot' | 'validation' | 'commit' | 'lookup' | 'prepare' | 'execute' | 'network' | 'write' | 'sync' | 'confirmation';
export interface MemoryDiagnostic { operation: MemoryOperation; stage: MemoryStage; code: string; elapsedMs: number; field?: string; rule?: string }
export type MemoryDiagnosticSink = (entry: MemoryDiagnostic) => void;
const codes = new Set(['INVALID_INPUT', 'UNCONFIGURED', 'UPSTREAM', 'TIMEOUT', 'AMBIGUOUS', 'CONFLICT', 'EXPIRED', 'REJECTED', 'LIMIT', 'ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'ENOSPC', 'EBUSY']);
export class MemoryDiagnostics {
  constructor(private readonly enabled = false, private readonly sink: MemoryDiagnosticSink = entry => console.info('[ATLAS memory]', JSON.stringify(entry)), private readonly profile = false) {}
  failure(operation: MemoryOperation, stage: MemoryStage, error: unknown, started: number): void {
    if (!this.enabled) return;
    const raw = error instanceof ToolError ? error.category : error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError') ? 'TIMEOUT' : (error as { code?: unknown } | null)?.code;
    const code = typeof raw === 'string' && codes.has(raw) ? raw : 'UPSTREAM';
    // Explicit metadata only: no messages, stack traces, paths, arguments or IDs.
    try { this.sink({ operation, stage, code, elapsedMs: Math.max(0, Math.round(performance.now() - started)), ...(error instanceof MemoryValidationError ? { field: error.field, rule: error.rule } : {}) }); } catch { /* Diagnostics cannot affect execution. */ }
  }
  async run<T>(operation: MemoryOperation, stage: MemoryStage, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const started = performance.now(); let reported = false;
    const report = (error: unknown) => { if (!reported) { reported = true; this.failure(operation, stage, error, started); } };
    const abort = () => report(new ToolError('TIMEOUT'));
    signal?.addEventListener('abort', abort, { once: true });
    try { signal?.throwIfAborted(); const result = await work(); if (this.enabled && this.profile) { try { this.sink({ operation, stage, code: 'OK', elapsedMs: Math.max(0, Math.round(performance.now() - started)) }); } catch { /* Diagnostics cannot affect execution. */ } } return result; }
    catch (error) { report(error); throw error; }
    finally { signal?.removeEventListener('abort', abort); }
  }
}
