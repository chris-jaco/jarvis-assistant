import { ToolError } from '../tools/types.js';
import { z } from 'zod';
import { PrivateJsonMemoryStore } from './store.js';
import { MemoryService } from './service.js';
import { OpenAIMemoryExtraction } from './extraction.js';
import type { MemoryExtraction } from './types.js';
export interface MemoryRuntime { service: MemoryService; extraction: MemoryExtraction; budget: number; limit: number; automatic: boolean }
export function createMemoryRuntime(env: NodeJS.ProcessEnv = process.env): MemoryRuntime {
  try {
  const integer = (name: string, fallback: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).parse(env[name] ?? fallback);
  const automatic = env.MEMORY_AUTOMATIC ?? 'true'; if (!['true', 'false'].includes(automatic)) throw new Error('MEMORY_AUTOMATIC must be true or false');
  return { service: new MemoryService(new PrivateJsonMemoryStore(env.MEMORY_PATH)), extraction: new OpenAIMemoryExtraction(env.OPENAI_API_KEY, env.USER_TIMEZONE),
    budget: integer('MEMORY_CONTEXT_CHARS', 3000, 500, 8000), limit: integer('MEMORY_RETRIEVAL_LIMIT', 5, 1, 8), automatic: automatic === 'true' };
  } catch {
    // Optional memory configuration/storage must never prevent core voice startup.
    const unavailable = { read: async () => { throw new ToolError('UNCONFIGURED'); }, transaction: async <T>(_change: (records: import('./types.js').MemoryRecord[]) => T): Promise<T> => { throw new ToolError('UNCONFIGURED'); } };
    return { service: new MemoryService(unavailable), extraction: new OpenAIMemoryExtraction(), budget: 3000, limit: 5, automatic: false };
  }
}
