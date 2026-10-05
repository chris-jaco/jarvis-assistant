import type { MemoryRecord, MemoryCandidate } from './types.js';
export const normalize = (text: string) => text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}@]+/gu, ' ').trim();
export const entityKey = (text: string) => normalize(text).replace(/\s+/g, '');
type Entity = MemoryCandidate['subject'];
export function entities(records: MemoryRecord[]): Entity[] {
  const result = new Map<string, Entity>();
  const ordered = [...records].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  // Current subject records own canonical spelling; relationships contribute
  // aliases, not a stale display name that undoes an explicit correction.
  const references = [...ordered.map(r => r.subject), ...ordered.flatMap(r => r.relationships.map(link => link.target))];
  for (const e of references) {
    const prior = result.get(e.id);
    result.set(e.id, prior ? { ...prior, aliases: [...new Set([...prior.aliases, e.name, ...e.aliases])] } : e);
  }
  return [...result.values()];
}
export function mentions(query: string, name: string): boolean {
  const words = normalize(query).split(/\s+/); const key = entityKey(name);
  for (let start = 0; start < words.length; start++) for (let size = 1; size <= 4; size++) if (words.slice(start, start + size).join('') === key) return true;
  return false;
}
function distance(a: string, b: string): number {
  let row = [...Array(b.length + 1).keys()];
  for (let i = 0; i < a.length; i++) { const next = [i + 1]; for (let j = 0; j < b.length; j++) next.push(Math.min(next[j]! + 1, row[j + 1]! + 1, row[j]! + (a[i] === b[j] ? 0 : 1))); row = next; }
  return row[b.length]!;
}
// Suggestions ONLY: never IDs for execution, alias learning, or automatic merging.
export function nearNames(query: string, known: Entity[]): string[] {
  const words = normalize(query).split(/\s+/); const result = new Set<string>();
  for (const e of known) for (const name of [e.name, ...e.aliases]) {
    const key = entityKey(name); if (key.length < 6 || key.length > 80) continue;
    for (let i = 0; i < words.length; i++) for (let size = 1; size <= 3; size++) {
      const part = words.slice(i, i + size).join('');
      if (part === key || part.length < 6 || Math.abs(part.length - key.length) > 2) continue;
      const edits = distance(part, key);
      if (edits <= 1 || (part.slice(0, 4) === key.slice(0, 4) && edits <= 3 && edits / Math.max(part.length, key.length) <= 0.43)) result.add(e.name);
    }
  }
  return [...result].slice(0, 4);
}
