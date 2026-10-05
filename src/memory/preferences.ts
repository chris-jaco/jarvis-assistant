import { z } from 'zod';
import type { MemoryCandidate } from './types.js';
export const CURRENT_USER_SUBJECT = { id: 'user', name: 'User', aliases: [] as string[] };
export const preferenceSchema = z.object({ responseLength: z.enum(['minimal', 'short', 'normal', 'detailed']) }).strict();
export type ResponsePreference = z.infer<typeof preferenceSchema>;
export const responsePreferenceKeys = new Set(['spoken_communication', 'response_style', 'response_length']);
export function responsePreference(input: ResponsePreference): MemoryCandidate {
  const descriptions = { minimal: 'Prefiere respuestas lo más cortas posible, conservando la información necesaria.', short: 'Prefiere respuestas breves y directas.', normal: 'Prefiere respuestas de extensión normal.', detailed: 'Prefiere respuestas detalladas.' };
  return { type: 'PREFERENCE', subject: { ...CURRENT_USER_SUBJECT, aliases: [] }, key: 'spoken_communication', content: descriptions[input.responseLength], value: { response_length: input.responseLength }, relationships: [], confidence: 1, importance: 1 };
}
