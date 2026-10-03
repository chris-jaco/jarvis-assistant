import type { MCPServer } from '@openai/agents-core';
import type { ToolDefinition, ToolAdapter } from '../types.js';
import { ToolError } from '../types.js';
/** Connect an official SDK MCPServerStreamableHttp (or Stdio) on the backend.
 * Reviewed local schemas/permissions/output projection override all remote annotations.
 * No server connects by default. Secrets/URLs never go into browser descriptors. */
export async function mcpAdapter(server: MCPServer, integration: string,
  reviewed: Array<Omit<ToolDefinition, 'execute' | 'integration'> & { remoteName: string; project(result: unknown): unknown }>): Promise<ToolAdapter> {
  await server.connect();
  try {
    const available = await server.listTools();
    const tools = reviewed.map(({ remoteName, project, ...definition }): ToolDefinition => {
      if (!available.some(tool => tool.name === remoteName)) throw new ToolError('UNCONFIGURED');
      return { ...definition, integration, execute: async (input, signal) => {
        const result = server.callToolResult ? await server.callToolResult(remoteName, input as Record<string, unknown>, undefined, { signal }) : await server.callTool(remoteName, input as Record<string, unknown>, undefined, { signal });
        if (typeof result === 'object' && result !== null && 'isError' in result && result.isError) throw new ToolError('UPSTREAM');
        return project(result);
      } };
    });
    return { integration, transport: 'mcp', tools: () => tools, close: () => server.close() };
  } catch (error) { await server.close(); throw error; }
}
