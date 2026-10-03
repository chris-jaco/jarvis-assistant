import type { z } from 'zod';
export type Permission = 'READ' | 'WRITE' | 'SENSITIVE';
export type Transport = 'hosted' | 'mcp' | 'api' | 'function' | 'local';
export interface ToolDefinition {
  id: string; name: string; description: string; integration: string; capability: string;
  permission: Permission; confirm?: boolean; schema: z.ZodType; timeoutMs?: number;
  prepare?(input: unknown, signal: AbortSignal): Promise<unknown>;
  summarize?(input: unknown): string;
  execute(input: unknown, signal: AbortSignal): Promise<unknown>;
}
export interface ToolAdapter { integration: string; transport: Transport; tools(): ToolDefinition[]; close?(): Promise<void> }
export type ErrorCategory = 'INVALID_INPUT' | 'UNCONFIGURED' | 'UPSTREAM' | 'TIMEOUT' | 'AMBIGUOUS' | 'CONFLICT' | 'EXPIRED' | 'REJECTED' | 'LIMIT';
export class ToolError extends Error { constructor(readonly category: ErrorCategory) { super(category); } }
export type ToolResult = { status: 'success'; data: unknown } | { status: 'error'; category: ErrorCategory; message: string } | { status: 'pending'; confirmationId: string; summary: string; expiresAt: number };
