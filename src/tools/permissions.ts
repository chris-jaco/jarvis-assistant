import type { ToolDefinition } from './types.js';
export function requiresConfirmation(tool: Pick<ToolDefinition, 'permission' | 'confirm'>): boolean {
  return tool.permission === 'SENSITIVE' || (tool.permission === 'WRITE' && tool.confirm !== false);
}
