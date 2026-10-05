import { ToolError } from '../tools/types.js';
import type { MemoryCandidate } from './types.js';
// Only visible literals, not Spanish B/V pronunciation guesses. Preserve case in
// domains; hyphen-separated uppercase letters are an explicit spelling signal.
export function literalIdentifiers(evidence: string): string[] {
  const spelled = /\b(?:[A-Z]-){2,}[A-Z](?:\.[A-Za-z]{2,}(?:\.[A-Za-z]{2,})*)?/g;
  const expanded = evidence.replace(spelled, text => {
    const [letters, ...suffix] = text.split('.'); const word = letters!.replaceAll('-', '');
    return word[0]! + word.slice(1).toLowerCase() + (suffix.length ? '.' + suffix.join('.') : '');
  });
  const domains = [...expanded.matchAll(/\b[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)+\b/g)].filter(m => expanded[m.index - 1] !== '@').map(m => m[0]);
  const words = [...evidence.matchAll(spelled)].filter(m => !m[0].includes('.')).map(m => { const word = m[0].replaceAll('-', ''); return word[0]! + word.slice(1).toLowerCase(); });
  return [...new Set([...domains, ...words])];
}
export function validateSpelling(candidate: MemoryCandidate, evidence: string): void {
  const required = literalIdentifiers(evidence);
  if (!required.length) return;
  const values = [candidate.subject.name, ...Object.values(candidate.value).filter((v): v is string => typeof v === 'string'), ...candidate.relationships.map(r => r.target.name)];
  const text = [...values, candidate.content].join(' ');
  for (const name of required) {
    // Whole literal, not a substring of a different identifier or an email.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`(?<![\\p{L}\\p{N}@.-])${escaped}(?![\\p{L}\\p{N}-]|\\.[\\p{L}\\p{N}])`, 'u').test(text)) throw new ToolError('INVALID_INPUT');
    const suffix = name.includes('.') ? name.slice(name.indexOf('.')) : '';
    if (suffix && literalIdentifiers(text).some(value => value.endsWith(suffix) && !required.includes(value))) throw new ToolError('INVALID_INPUT');
  }
}
