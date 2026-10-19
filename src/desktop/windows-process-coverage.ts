import type { ProcessObservation } from './windows-process-detector.js';

export interface CimProcessRecord {
  pid: number;
  /** UTC FILETIME as decimal string; CIM precision is microseconds, not 100 ns. */
  creation: string | null;
  path: string | null;
}
export interface CimInventory {
  status: 'OK' | 'FAILED';
  records: CimProcessRecord[];
}

function birth(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value)) return;
  const ticks = BigInt(value);
  if (ticks > 0x7fffffffffffffffn) return;
  return ticks / 10n;
}
function textPath(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.replaceAll('/', '\\').toLowerCase() : undefined;
}
function inventory(value: unknown) {
  const records = new Map<number, CimProcessRecord>();
  let malformed = 0;
  const duplicates = new Set<number>();
  if (!value || typeof value !== 'object') return { ok: false, records, malformed: 0, duplicates };
  const input = value as Partial<CimInventory>;
  if (input.status !== 'OK' || !Array.isArray(input.records)) return { ok: false, records, malformed: 0, duplicates };
  for (const record of input.records) {
    if (!record || !Number.isSafeInteger(record.pid) || record.pid < 0) { malformed++; continue; }
    if (records.has(record.pid)) duplicates.add(record.pid);
    records.set(record.pid, record);
  }
  return { ok: true, records, malformed, duplicates };
}

function inventorySummary(value: ReturnType<typeof inventory>) {
  const rows = [...value.records.values()];
  return {
    status: value.ok ? 'OK' : 'FAILED', total: rows.length, malformed: value.malformed,
    withPath: rows.filter(row => !!textPath(row.path)).length,
    withoutPath: rows.filter(row => !textPath(row.path)).length,
    withoutCreation: rows.filter(row => birth(row.creation) === undefined).length
  };
}

/** Coverage only. No classification or maintenance authorization is performed here. */
export function summarizeCimCoverage(before: unknown, after: unknown, observations: ProcessObservation[], uncertainPids: number[]) {
  const first = inventory(before), last = inventory(after);
  const counts = {
    uncertainTotal: new Set(uncertainPids).size,
    matchedWithPath: 0, matchedWithoutPath: 0,
    presentOnlyBefore: 0, presentOnlyAfter: 0, missingInBoth: 0,
    duplicateOrAmbiguousRecord: 0,
    creationChangedBetweenCimSamples: 0,
    creationStableBetweenCimSamples: 0, creationUnavailableBetweenCimSamples: 0,
    win32CreationMatchesCim: 0, win32CreationConflictsWithCim: 0, win32CreationNotComparable: 0,
    win32InternalCreationConflict: 0,
    pathTextMatches: 0, pathTextDiffers: 0, pathTextNotComparable: 0,
    pathAvailabilityChanged: 0
  };
  const processByPid = new Map<number, ProcessObservation>();
  const repeated = new Set<number>();
  for (const row of Array.isArray(observations) ? observations : []) {
    if (!row || !Number.isSafeInteger(row.pid)) continue;
    if (processByPid.has(row.pid)) repeated.add(row.pid);
    processByPid.set(row.pid, row);
  }
  if (first.ok && last.ok) for (const pid of new Set(uncertainPids)) {
    if (first.duplicates.has(pid) || last.duplicates.has(pid) || repeated.has(pid)) {
      counts.duplicateOrAmbiguousRecord++; continue;
    }
    const a = first.records.get(pid), b = last.records.get(pid);
    if (!a && !b) { counts.missingInBoth++; continue; }
    if (!b) { counts.presentOnlyBefore++; continue; }
    if (!a) { counts.presentOnlyAfter++; continue; }
    const aBirth = birth(a.creation), bBirth = birth(b.creation);
    if (aBirth === undefined || bBirth === undefined) counts.creationUnavailableBetweenCimSamples++;
    else if (aBirth !== bBirth) { counts.creationChangedBetweenCimSamples++; continue; }
    else counts.creationStableBetweenCimSamples++;
    if (textPath(b.path)) counts.matchedWithPath++;
    else counts.matchedWithoutPath++;
    if (!!textPath(a.path) !== !!textPath(b.path)) counts.pathAvailabilityChanged++;
    // Unknown rows may carry successfully queried image/creation metadata, e.g. after a sync failure.
    const row = processByPid.get(pid) as (ProcessObservation & { creation?: unknown; verifiedCreation?: unknown; image?: { canonicalPath?: unknown } }) | undefined;
    const winBirth = birth(row?.creation);
    const verifiedBirth = birth(row?.verifiedCreation);
    if (winBirth !== undefined && verifiedBirth !== undefined && winBirth !== verifiedBirth) {
      counts.win32InternalCreationConflict++; continue;
    }
    if (aBirth === undefined || bBirth === undefined || winBirth === undefined) counts.win32CreationNotComparable++;
    else if (winBirth !== bBirth) { counts.win32CreationConflictsWithCim++; continue; }
    else counts.win32CreationMatchesCim++;
    const winPath = textPath(row?.image?.canonicalPath), cimPath = textPath(b.path);
    if (!winPath || !cimPath || winBirth === undefined || bBirth === undefined || aBirth === undefined) counts.pathTextNotComparable++;
    else if (winPath === cimPath) counts.pathTextMatches++;
    else counts.pathTextDiffers++; // Aliases can explain this; never proof of physical exclusion.
  }
  return {
    diagnosticOnly: true,
    cimBefore: inventorySummary(first),
    cimAfter: inventorySummary(last),
    correlationAvailable: first.ok && last.ok,
    partialData: first.malformed > 0 || last.malformed > 0 || first.duplicates.size > 0 || last.duplicates.size > 0,
    counts
  };
}
