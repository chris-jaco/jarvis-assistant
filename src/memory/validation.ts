import { ToolError } from '../tools/types.js';
export const validationFields = ['type', 'subject.id', 'subject.name', 'subject.aliases', 'key', 'content', 'value.*', 'relationships.*', 'confidence', 'importance', 'expiresAt', 'source.kind', 'source.evidence', 'source.observedAt', 'record', 'preference.responseLength', 'evidence', 'input'] as const;
export type ValidationField = typeof validationFields[number];
export class MemoryValidationError extends ToolError {
  constructor(readonly field: ValidationField, readonly rule: 'schema' | 'secret_filter') { super('INVALID_INPUT'); }
}
export function validationField(path: readonly PropertyKey[]): ValidationField {
  const parts = path.filter(part => typeof part === 'string'); const head = parts[0] === 'candidate' ? parts.slice(1) : parts;
  const name = head.join('.'); if (validationFields.includes(name as ValidationField)) return name as ValidationField;
  if (head[0] === 'value') return 'value.*'; if (head[0] === 'relationships') return 'relationships.*';
  if (head[0] === 'subject' && head[1] === 'aliases') return 'subject.aliases';
  return 'input';
}
