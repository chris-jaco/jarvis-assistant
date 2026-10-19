import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { detectWindowsProcesses, detectionExitCode, summarizeDetection } from '../src/desktop/windows-process-detector.js';
import type { InstallationIdentity, ProcessObservation } from '../src/desktop/windows-process-detector.js';
import { summarizeCimCoverage } from '../src/desktop/windows-process-coverage.js';

// No command shell, elevation, profile loading, or policy overrides.
async function main(): Promise<void> {
  const summary = process.argv[3] === '--summary';
  const coverage = process.argv[3] === '--coverage';
  if (process.platform !== 'win32' || !(process.argv.length === 3 || (process.argv.length === 4 && (summary || coverage))) || !process.argv[2]) {
    console.log(JSON.stringify({ state: 'INDETERMINATE', maintenanceAllowed: false, reason: 'WINDOWS_AND_INSTALLATION_DIRECTORY_REQUIRED' }));
    process.exitCode = 2; return;
  }
  try {
    const { stdout } = await promisify(execFile)('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File',
      fileURLToPath(new URL('./collect-atlas-processes.ps1', import.meta.url)),
      '-InstallationDirectory', process.argv[2], ...(coverage ? ['-IncludeCimCoverage'] : [])
    ], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    const snapshot = JSON.parse(stdout.replace(/^\uFEFF/, '')) as {
      before: InstallationIdentity; processes: ProcessObservation[]; after: InstallationIdentity;
      cimBefore?: unknown; cimAfter?: unknown;
    };
    const detection = await detectWindowsProcesses({
      installation: async () => snapshot.before,
      enumerate: async () => snapshot.processes,
      verifyInstallation: async () => snapshot.after
    });
    const output = coverage ? {
      ...summarizeDetection(detection),
      coverage: summarizeCimCoverage(snapshot.cimBefore, snapshot.cimAfter, snapshot.processes, detection.uncertainPids)
    } : summary ? summarizeDetection(detection) : detection;
    console.log(JSON.stringify(output, null, 2));
    process.exitCode = detectionExitCode(detection.state);
  } catch {
    console.log(JSON.stringify({ state: 'INDETERMINATE', maintenanceAllowed: false, reason: 'WINDOWS_COLLECTION_FAILED' }));
    process.exitCode = 2;
  }
}

await main();
