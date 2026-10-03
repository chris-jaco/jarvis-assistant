import type { Permission, ErrorCategory } from './types.js';
export interface ToolActivity {
  invocationId: string; toolId: string; integration: string; permission: Permission;
  startedAt: number; endedAt?: number; durationMs?: number;
  status: 'running' | 'pending' | 'success' | 'error'; confirmationRequired: boolean;
  confirmation: 'not_required' | 'waiting' | 'granted' | 'rejected' | 'expired'; errorCategory?: ErrorCategory;
}
export class ToolTelemetry {
  private rows: ToolActivity[] = [];
  record(row: ToolActivity): void { this.rows.push(row); if (this.rows.length > 100) this.rows.shift(); }
  snapshot(): ToolActivity[] { return this.rows.map(row => ({ ...row })); }
}
