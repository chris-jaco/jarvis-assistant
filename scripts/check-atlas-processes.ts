import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { detectWindowsProcesses } from '../src/desktop/windows-process-detector.js';
import type { InstallationIdentity, ProcessObservation } from '../src/desktop/windows-process-detector.js';

// No command shell, elevation, profile loading, or policy overrides.
async function main(): Promise<void> {
  if (process.platform !== 'win32' || process.argv.length !== 3 || !process.argv[2]) {
    console.log(JSON.stringify({ state: 'INDETERMINATE', maintenanceAllowed: false, reason: 'WINDOWS_AND_INSTALLATION_DIRECTORY_REQUIRED' }));
    process.exitCode = 2; return;
  }
  try {
    const { stdout } = await promisify(execFile)('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File',
      fileURLToPath(new URL('./collect-atlas-processes.ps1', import.meta.url)),
      '-InstallationDirectory', process.argv[2]
    ], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    const snapshot = JSON.parse(stdout.replace(/^\uFEFF/, '')) as {
      before: InstallationIdentity; processes: ProcessObservation[]; after: InstallationIdentity;
    };
    const detection = await detectWindowsProcesses({
      installation: async () => snapshot.before,
      enumerate: async () => snapshot.processes,
      verifyInstallation: async () => snapshot.after
    });
    console.log(JSON.stringify(detection, null, 2));
    process.exitCode = detection.state === 'ABSENT' ? 0 : detection.state === 'ACTIVE' ? 1 : 2;
  } catch {
    console.log(JSON.stringify({ state: 'INDETERMINATE', maintenanceAllowed: false, reason: 'WINDOWS_COLLECTION_FAILED' }));
    process.exitCode = 2;
  }
}

await main();
