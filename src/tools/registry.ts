import { z } from 'zod';
import type { ToolAdapter, ToolDefinition } from './types.js';
export class ToolRegistry {
  private readonly entries = new Map<string, ToolDefinition>();
  register(tool: ToolDefinition): void {
    if (!/^[a-zA-Z][\w.-]{0,79}$/.test(tool.id) || this.entries.has(tool.id) || [...this.entries.keys()].some(id => id.replaceAll('.', '_') === tool.id.replaceAll('.', '_'))) throw new Error('Invalid or duplicate tool ID');
    this.entries.set(tool.id, tool);
  }
  add(adapter: ToolAdapter): void { for (const tool of adapter.tools()) this.register(tool); }
  resolve(id: string): ToolDefinition | undefined { return this.entries.get(id); }
  descriptors() { return [...this.entries.values()].map(({ id, name, description, integration, capability, permission, confirm, schema }) => ({ id, name, description, integration, capability, permission, confirm, inputSchema: z.toJSONSchema(schema) })); }
}
