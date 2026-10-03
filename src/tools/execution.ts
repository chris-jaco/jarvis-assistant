import { randomUUID } from 'node:crypto';
import { requiresConfirmation } from './permissions.js';
import { ToolTelemetry } from './telemetry.js';
import type { ToolActivity } from './telemetry.js';
import { ToolError } from './types.js';
import type { ToolDefinition, ToolResult, ErrorCategory } from './types.js';
import type { ToolRegistry } from './registry.js';
const messages: Record<ErrorCategory, string> = {
  INVALID_INPUT: 'Datos inválidos. Aclara la solicitud.', UNCONFIGURED: 'Esta integración no está configurada.',
  UPSTREAM: 'No se pudo recuperar información o completar la acción. No asumas que se realizó.',
  TIMEOUT: 'La operación tardó demasiado. Su resultado puede ser incierto; comprueba el estado antes de repetir una escritura.',
  AMBIGUOUS: 'Hay varias coincidencias. Pide al usuario que elija una.', CONFLICT: 'La información cambió o la solicitud no coincide. Vuelve a consultarla.',
  EXPIRED: 'Confirmación inválida o caducada. Solicita la acción de nuevo.', REJECTED: 'Acción cancelada. No se ha ejecutado.', LIMIT: 'Límite de herramientas de esta sesión alcanzado.'
};
export function safeError(error: unknown): ToolResult {
  const category = error instanceof ToolError ? error.category : 'UPSTREAM';
  return { status: 'error', category, message: messages[category] };
}
interface Pending { id: string; tool: ToolDefinition; input: unknown; expiresAt: number; row: ToolActivity }
export class ToolExecutor {
  private pending?: Pending;
  private calls = new Map<string, { fingerprint: string; result: Promise<ToolResult> }>();
  private controllers = new Set<AbortController>();
  private closed = false;
  private revision = 0;
  constructor(private readonly registry: ToolRegistry, private readonly now = Date.now, private readonly confirmationMs = 60_000, readonly telemetry = new ToolTelemetry()) {}
  invoke(id: string, toolId: string, input: unknown): Promise<ToolResult> {
    const fingerprint = JSON.stringify([toolId, input]);
    const previous = this.calls.get(id);
    if (previous) return previous.fingerprint === fingerprint ? previous.result : Promise.resolve(safeError(new ToolError('CONFLICT')));
    if (this.closed || this.calls.size >= 100) return Promise.resolve(safeError(new ToolError('LIMIT')));
    // Any new action invalidates the previous pending action, including reads.
    this.invalidate('rejected');
    const result = this.start(id, toolId, input);
    this.calls.set(id, { fingerprint, result });
    return result;
  }
  private async bounded<T>(tool: ToolDefinition, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController(); this.controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation(controller.signal), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new ToolError('TIMEOUT')); }, tool.timeoutMs ?? 20_000);
        controller.signal.addEventListener('abort', () => reject(new ToolError('TIMEOUT')), { once: true });
      })]);
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  private async start(id: string, toolId: string, raw: unknown): Promise<ToolResult> {
    const revision = this.revision;
    const tool = this.registry.resolve(toolId);
    if (!tool) return safeError(new ToolError('INVALID_INPUT'));
    const row: ToolActivity = { invocationId: id, toolId, integration: tool.integration, permission: tool.permission,
      startedAt: this.now(), status: 'running', confirmationRequired: requiresConfirmation(tool), confirmation: requiresConfirmation(tool) ? 'waiting' : 'not_required' };
    this.telemetry.record(row);
    try {
      const parsed = tool.schema.safeParse(raw);
      if (!parsed.success) throw new ToolError('INVALID_INPUT');
      const input = tool.prepare ? await this.bounded(tool, signal => tool.prepare!(parsed.data, signal)) : parsed.data;
      if (this.closed || revision !== this.revision) throw new ToolError('EXPIRED');
      if (requiresConfirmation(tool)) {
        this.invalidate('rejected');
        const pending = { id: randomUUID(), tool, input, expiresAt: this.now() + this.confirmationMs, row };
        this.pending = pending; row.status = 'pending';
        return { status: 'pending', confirmationId: pending.id, summary: tool.summarize?.(input) ?? `¿Confirmas ${tool.name}?`, expiresAt: pending.expiresAt };
      }
      return await this.run(tool, input, row);
    } catch (error) { return this.finishError(row, error); }
  }
  pendingState() {
    if (this.pending && this.pending.expiresAt <= this.now()) this.invalidate('expired');
    const p = this.pending;
    return p ? { confirmationId: p.id, summary: p.tool.summarize?.(p.input) ?? p.tool.name, expiresAt: p.expiresAt } : null;
  }
  async decide(id: string, approved: boolean): Promise<ToolResult> {
    const pending = this.pending;
    if (!pending || pending.id !== id || this.closed) return safeError(new ToolError('EXPIRED'));
    this.pending = undefined; // Consume before awaiting: concurrent/replayed decisions cannot execute twice.
    if (pending.expiresAt <= this.now()) { pending.row.confirmation = 'expired'; return this.finishError(pending.row, new ToolError('EXPIRED')); }
    if (!approved) { pending.row.confirmation = 'rejected'; return this.finishError(pending.row, new ToolError('REJECTED')); }
    pending.row.confirmation = 'granted';
    return this.run(pending.tool, pending.input, pending.row);
  }
  private async run(tool: ToolDefinition, input: unknown, row: ToolActivity): Promise<ToolResult> {
    row.status = 'running';
    try {
      const data = await this.bounded(tool, signal => tool.execute(input, signal));
      row.status = 'success'; this.end(row); return { status: 'success', data };
    } catch (error) { return this.finishError(row, error); }
  }
  private end(row: ToolActivity): void { row.endedAt = this.now(); row.durationMs = row.endedAt - row.startedAt; }
  private finishError(row: ToolActivity, error: unknown): ToolResult {
    const result = safeError(error); row.status = 'error';
    if (result.status === 'error') row.errorCategory = result.category;
    this.end(row); return result;
  }
  invalidate(reason: 'rejected' | 'expired' = 'rejected'): void {
    ++this.revision;
    if (this.pending) { this.pending.row.confirmation = reason; this.finishError(this.pending.row, new ToolError(reason === 'expired' ? 'EXPIRED' : 'REJECTED')); this.pending = undefined; }
  }
  close(): void { this.closed = true; this.invalidate(); for (const controller of this.controllers) controller.abort(); }
}
