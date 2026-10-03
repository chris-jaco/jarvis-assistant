import type { ToolDefinition } from './types.js';
export function requiresConfirmation(tool: Pick<ToolDefinition, 'permission' | 'confirm' | 'confirmWhen'>, prepared?: unknown): boolean {
  return tool.permission === 'SENSITIVE' || (tool.permission === 'WRITE' && (tool.confirm !== false || (prepared !== undefined && tool.confirmWhen?.(prepared) === true)));
}
