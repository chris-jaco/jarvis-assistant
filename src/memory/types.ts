import { z } from 'zod';
export const memoryTypes = ['USER_PROFILE', 'PREFERENCE', 'PERSON', 'ORGANIZATION', 'PROJECT', 'SKILL', 'DECISION', 'FACT', 'EPISODE', 'TEMPORARY'] as const;
export const sourceKinds = ['explicit_user', 'conversation_inference', 'tool_result', 'system'] as const;
export const entitySchema = z.object({ id: z.string().min(1).max(100), name: z.string().min(1).max(120), aliases: z.array(z.string().min(1).max(120)).max(8).default([]) }).strict();
const candidateFields = z.object({ type: z.enum(memoryTypes), subject: entitySchema,
  key: z.string().min(1).max(100), content: z.string().min(1).max(1000),
  value: z.record(z.string().max(80), z.union([z.string().max(500), z.number().finite(), z.boolean()])).refine(value => Object.keys(value).length <= 16).default({}),
  relationships: z.array(z.object({ predicate: z.string().min(1).max(80), target: entitySchema }).strict()).max(8).default([]),
  confidence: z.number().min(0).max(1), importance: z.number().min(0).max(1),
  expiresAt: z.iso.datetime().optional()
}).strict();
export const candidateSchema = candidateFields.refine(candidate => JSON.stringify(candidate).length <= 4000);
export type MemoryCandidate = z.infer<typeof candidateSchema>;
export const sourceSchema = z.object({ kind: z.enum(sourceKinds), evidence: z.string().max(2000), observedAt: z.iso.datetime() }).strict();
export type MemorySource = z.infer<typeof sourceSchema>;
export const recordSchema = candidateFields.extend({ id: z.string().uuid(), source: sourceSchema,
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), lastAccessedAt: z.iso.datetime().nullable(),
  status: z.enum(['current', 'superseded']), supersedes: z.string().uuid().optional(), supersededBy: z.string().uuid().optional(), corroborations: z.number().int().min(1),
}).strict();
export type MemoryRecord = z.infer<typeof recordSchema>;
export interface MemoryStore { read(): Promise<MemoryRecord[]>; transaction<T>(change: (records: MemoryRecord[]) => T): Promise<T> }
export interface MemoryExtraction { extract(utterance: string, context: MemoryRecord[], now: string): Promise<Array<{ candidate: MemoryCandidate; sourceKind: 'explicit_user' | 'conversation_inference'; evidence: string }>> }
export interface MemoryRelevance { score(query: string, record: MemoryRecord): number }
