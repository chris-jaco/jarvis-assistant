/** Read-only snapshot policy. ABSENT is an observation, never a maintenance lock. */
export type DetectionState = 'ACTIVE' | 'ABSENT' | 'INDETERMINATE';

export const diagnosticStages = [
  'OPEN_PROCESS_FAILED', 'CREATION_TIME_FAILED', 'IMAGE_QUERY_FAILED',
  'IDENTITY_RESOLUTION_FAILED', 'PROCESS_EXIT_CONFIRMED', 'IDENTITY_MISMATCH'
] as const;
export interface ProcessDiagnostic {
  stage: typeof diagnosticStages[number];
  win32Error: number | null;
  access: 'QUERY' | 'SYNCHRONIZE' | null;
}

export interface FileIdentity {
  canonicalPath: string;
  volume: string;
  fileId: string;
}

export interface InstallationIdentity {
  directory: FileIdentity;
  executable: FileIdentity;
}

export type ProcessObservation = (
  | { pid: number; status: 'VERIFIED'; creation: string; verifiedCreation: string; image: FileIdentity }
  | { pid: number; status: 'EXITED_CONFIRMED' }
  | { pid: number; status: 'UNKNOWN' }) & { diagnostics?: ProcessDiagnostic[] };

export interface ProcessDetectorAdapter {
  installation(): Promise<InstallationIdentity>;
  enumerate(): Promise<ProcessObservation[]>;
  /** Re-open target identities after enumeration to detect target changes. */
  verifyInstallation(): Promise<InstallationIdentity>;
}

export interface DetectionResult {
  state: DetectionState;
  maintenanceAllowed: boolean;
  activePids: number[];
  uncertainPids: number[];
  reason: string;
  diagnostics?: Array<ProcessDiagnostic & { pid: number }>;
}

export function detectionExitCode(state: DetectionState): number {
  return state === 'ABSENT' ? 0 : state === 'ACTIVE' ? 1 : 2;
}

/** Allowlisted projection: never copy exception messages, paths or command lines. */
function safeDiagnostic(value: unknown): ProcessDiagnostic | undefined {
  if (!value || typeof value !== 'object') return;
  const row = value as Partial<ProcessDiagnostic>;
  if (!diagnosticStages.includes(row.stage as ProcessDiagnostic['stage'])) return;
  return {
    stage: row.stage!,
    win32Error: Number.isSafeInteger(row.win32Error) && row.win32Error! >= 0 && row.win32Error! <= 0xffffffff ? row.win32Error! : null,
    access: row.access === 'QUERY' || row.access === 'SYNCHRONIZE' ? row.access : null
  };
}

export function summarizeDetection(value: DetectionResult) {
  const groups = new Map<string, ProcessDiagnostic & { count: number }>();
  for (const diagnostic of value.diagnostics ?? []) {
    const safe = safeDiagnostic(diagnostic); if (!safe) continue;
    const key = JSON.stringify(safe);
    const previous = groups.get(key);
    groups.set(key, { ...safe, count: (previous?.count ?? 0) + 1 });
  }
  return {
    state: value.state, maintenanceAllowed: value.state === 'ABSENT', reason: value.reason,
    activeCount: value.activePids.length, uncertainCount: value.uncertainPids.length,
    diagnosticSummary: [...groups.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  };
}

function path(value: string): string | undefined {
  // Collector accepts local disk paths only. UNC/device namespaces remain ambiguous.
  const normalized = value.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
  if (!/^[a-z]:\\/.test(normalized) || normalized.split('\\').some(p => p === '.' || p === '..')) return;
  return normalized;
}

function valid(value: FileIdentity): boolean {
  return !!value && typeof value.canonicalPath === 'string' && !!path(value.canonicalPath)
    && typeof value.volume === 'string' && /^[0-9a-f]+$/i.test(value.volume)
    && typeof value.fileId === 'string' && /^[0-9a-f]+$/i.test(value.fileId)
    && !/^0+$/.test(value.fileId);
}

function same(a: FileIdentity, b: FileIdentity): boolean {
  return a.volume.toLowerCase() === b.volume.toLowerCase() && a.fileId.toLowerCase() === b.fileId.toLowerCase();
}

function installationValid(value: InstallationIdentity): boolean {
  return !!value && valid(value.directory) && valid(value.executable)
    && path(value.executable.canonicalPath) === `${path(value.directory.canonicalPath)}\\atlas.exe`
    && value.directory.volume.toLowerCase() === value.executable.volume.toLowerCase();
}

function stable(a: InstallationIdentity, b: InstallationIdentity): boolean {
  return installationValid(b) && same(a.directory, b.directory) && same(a.executable, b.executable)
    && path(a.directory.canonicalPath) === path(b.directory.canonicalPath)
    && path(a.executable.canonicalPath) === path(b.executable.canonicalPath);
}

function result(state: DetectionState, reason: string, activePids: number[] = [], uncertainPids: number[] = []): DetectionResult {
  return { state, maintenanceAllowed: state === 'ABSENT', activePids, uncertainPids, reason };
}

async function classifyWindowsProcesses(adapter: ProcessDetectorAdapter): Promise<DetectionResult> {
  try {
    const target = await adapter.installation();
    if (!installationValid(target)) return result('INDETERMINATE', 'TARGET_IDENTITY_INVALID');
    const observations = await adapter.enumerate();
    if (!Array.isArray(observations)) return result('INDETERMINATE', 'ENUMERATION_INVALID');
    const active: number[] = [], uncertain: number[] = [];
    const seen = new Set<number>();
    for (const process of observations) {
      if (!process || !Number.isSafeInteger(process.pid) || process.pid <= 0 || seen.has(process.pid)) {
        return result('INDETERMINATE', 'PROCESS_RECORD_INVALID');
      }
      seen.add(process.pid);
      if (process.status === 'EXITED_CONFIRMED') continue;
      if (process.status !== 'VERIFIED' || !valid(process.image)
        || !/^[1-9][0-9]*$/.test(process.creation) || process.creation !== process.verifiedCreation) {
        uncertain.push(process.pid); continue;
      }
      const imagePath = path(process.image.canonicalPath)!;
      const targetPath = path(target.executable.canonicalPath)!;
      const inDirectory = imagePath.startsWith(`${path(target.directory.canonicalPath)}\\`);
      if (same(process.image, target.executable)) active.push(process.pid);
      else if (imagePath === targetPath) uncertain.push(process.pid); // Same spelling, different file identity.
      else if (inDirectory) {
        if (process.image.volume.toLowerCase() === target.directory.volume.toLowerCase()) active.push(process.pid);
        else uncertain.push(process.pid);
      }
    }
    if (!stable(target, await adapter.verifyInstallation())) return result('INDETERMINATE', 'TARGET_CHANGED', active, uncertain);
    // Positive evidence remains ACTIVE even when other records are inaccessible. Both block maintenance.
    if (active.length) return result('ACTIVE', 'INSTALLATION_PROCESS_FOUND', active, uncertain);
    if (uncertain.length) return result('INDETERMINATE', 'PROCESS_IDENTITY_UNAVAILABLE', [], uncertain);
    return result('ABSENT', 'NO_INSTALLATION_PROCESS_OBSERVED');
  } catch {
    return result('INDETERMINATE', 'ADAPTER_FAILED');
  }
}

export async function detectWindowsProcesses(adapter: ProcessDetectorAdapter): Promise<DetectionResult> {
  let observations: ProcessObservation[] = [];
  const classification = await classifyWindowsProcesses({
    installation: () => adapter.installation(),
    verifyInstallation: () => adapter.verifyInstallation(),
    enumerate: async () => { const rows = await adapter.enumerate(); if (Array.isArray(rows)) observations = rows; return rows; }
  });
  const diagnostics: NonNullable<DetectionResult['diagnostics']> = [];
  // Diagnostics cannot influence classification, including malformed adapter metadata.
  for (const row of observations) {
    if (!row || !Number.isSafeInteger(row.pid) || row.pid <= 0) continue;
    const entries = Array.isArray(row.diagnostics) ? row.diagnostics : [];
    const safe = entries.map(safeDiagnostic).filter((d): d is ProcessDiagnostic => !!d);
    if (row.status === 'EXITED_CONFIRMED' && !safe.some(d => d.stage === 'PROCESS_EXIT_CONFIRMED')) {
      safe.push({ stage: 'PROCESS_EXIT_CONFIRMED', win32Error: null, access: null });
    } else if (classification.uncertainPids.includes(row.pid) && safe.length === 0) {
      safe.push({ stage: 'IDENTITY_MISMATCH', win32Error: null, access: null });
    }
    diagnostics.push(...safe.map(d => ({ pid: row.pid, ...d })));
  }
  return { ...classification, diagnostics };
}
