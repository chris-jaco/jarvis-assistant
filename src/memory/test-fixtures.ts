import type { MemoryCandidate, MemorySource, MemoryRecord, MemoryStore } from './types.js';
export const candidate = (content = 'Frekuent is a client.', changes: Partial<MemoryCandidate> = {}): MemoryCandidate => ({ type: 'ORGANIZATION', subject: { id: 'frekuent', name: 'Frekuent', aliases: [] }, key: 'client_relationship', content, value: {}, relationships: [], confidence: 0.98, importance: 0.85, ...changes });
export const source = (evidence = 'Frekuent is a client.', kind: MemorySource['kind'] = 'explicit_user', now = Date.now()): MemorySource => ({ kind, evidence, observedAt: new Date(now).toISOString() });
export class FakeMemoryStore implements MemoryStore {
  records: MemoryRecord[] = []; failure = false;
  async read() { if (this.failure) throw new Error('private path credential'); return structuredClone(this.records); }
  async transaction<T>(change: (records: MemoryRecord[]) => T) { const rows = await this.read(); const result = change(rows); this.records = rows; return structuredClone(result); }
}
