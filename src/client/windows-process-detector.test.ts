import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { detectWindowsProcesses } from '../desktop/windows-process-detector.js';
import type { FileIdentity, InstallationIdentity, ProcessDetectorAdapter, ProcessObservation } from '../desktop/windows-process-detector.js';

const directory: FileIdentity = { canonicalPath: 'C:\\Users\\Preview\\Apps\\Atlas', volume: '12ab', fileId: '10' };
const executable: FileIdentity = { canonicalPath: `${directory.canonicalPath}\\Atlas.exe`, volume: '12ab', fileId: '20' };
const target: InstallationIdentity = { directory, executable };
const observed = (pid: number, image = executable): ProcessObservation => ({
  pid, status: 'VERIFIED', creation: '134000000000000000', verifiedCreation: '134000000000000000', image
});
function adapter(processes: ProcessObservation[]): ProcessDetectorAdapter {
  return { installation: async () => target, enumerate: async () => processes, verifyInstallation: async () => target };
}

// Reconstructed from the user's Windows 11 report, NOT an original raw capture.
// PID/path/time/file IDs are sanitized synthetic fixtures. Roles never enter the policy.
const six = [101, 102, 103, 104, 105, 106].map(pid => observed(pid));

test('six reported packaged process roles block without inspecting commands, windows or parents', async () => {
  const result = await detectWindowsProcesses(adapter(six));
  assert.equal(result.state, 'ACTIVE');
  assert.equal(result.maintenanceAllowed, false);
  assert.deepEqual(result.activePids, [101, 102, 103, 104, 105, 106]);
});
test('Tray snapshot with the same six identities remains ACTIVE', async () => {
  assert.equal((await detectWindowsProcesses(adapter(six))).state, 'ACTIVE');
});
test('removing Main still blocks for surviving Core and auxiliaries', async () => {
  assert.equal((await detectWindowsProcesses(adapter(six.slice(1)))).state, 'ACTIVE');
});
test('Core alone blocks independently of ParentProcessId', async () => {
  assert.equal((await detectWindowsProcesses(adapter([six[1]!]))).state, 'ACTIVE');
});
test('each auxiliary alone blocks', async () => {
  for (const auxiliary of six.slice(2)) assert.equal((await detectWindowsProcesses(adapter([auxiliary]))).state, 'ACTIVE');
});
test('zero observed processes allows maintenance only as a snapshot', async () => {
  const result = await detectWindowsProcesses(adapter([]));
  assert.equal(result.state, 'ABSENT');
  assert.equal(result.maintenanceAllowed, true);
});
test('enumeration failure cannot become an empty success', async () => {
  const source = adapter([]);
  source.enumerate = async () => { throw new Error('access denied'); };
  assert.equal((await detectWindowsProcesses(source)).state, 'INDETERMINATE');
});
test('inaccessible process blocks without a process-name exemption', async () => {
  const result = await detectWindowsProcesses(adapter([{ pid: 200, status: 'UNKNOWN' }]));
  assert.equal(result.state, 'INDETERMINATE');
  assert.equal(result.maintenanceAllowed, false);
  assert.deepEqual(result.uncertainPids, [200]);
});
test('PID reuse or inconsistent creation identity blocks', async () => {
  const result = await detectWindowsProcesses(adapter([{
    pid: 200, status: 'VERIFIED', creation: '100', verifiedCreation: '101', image: executable
  }]));
  assert.equal(result.state, 'INDETERMINATE');
});
test('confirmed process termination may be discarded; an unconfirmed error may not', async () => {
  assert.equal((await detectWindowsProcesses(adapter([{ pid: 200, status: 'EXITED_CONFIRMED' }]))).state, 'ABSENT');
  assert.equal((await detectWindowsProcesses(adapter([{ pid: 200, status: 'UNKNOWN' }]))).state, 'INDETERMINATE');
});
test('case differences and same-file aliases are equivalent', async () => {
  for (const image of [
    { ...executable, canonicalPath: executable.canonicalPath.toUpperCase() },
    { ...executable, canonicalPath: 'C:\\ALIASES\\ATLAS~1.EXE' }
  ]) assert.equal((await detectWindowsProcesses(adapter([observed(200, image)]))).state, 'ACTIVE');
});
test('junction and short-path inputs resolved by adapter to the same physical identity block', async () => {
  const source = adapter([observed(200)]);
  // GetFinalPathNameByHandle resolves input aliases; only resolved identities cross this boundary.
  source.installation = async () => structuredClone(target);
  assert.equal((await detectWindowsProcesses(source)).state, 'ACTIVE');
});
test('unresolved paths, invalid file identities and ambiguous redirections block', async () => {
  for (const image of [
    { ...executable, canonicalPath: '\\\\server\\share\\Atlas.exe' },
    { ...executable, canonicalPath: 'C:\\Apps\\..\\Atlas.exe' },
    { ...executable, fileId: '0' },
    { ...executable, fileId: 'different' }
  ]) assert.equal((await detectWindowsProcesses(adapter([observed(200, image)]))).state, 'INDETERMINATE');
});
test('another Electron application and a separate Atlas copy do not identify this installation', async () => {
  for (const canonicalPath of ['C:\\OtherApp\\electron.exe', 'C:\\OtherAtlas\\Atlas.exe', 'C:\\Users\\Preview\\Apps\\Atlas-copy\\Atlas.exe']) {
    assert.equal((await detectWindowsProcesses(adapter([observed(200, {
      canonicalPath, volume: '12ab', fileId: '99'
    })]))).state, 'ABSENT');
  }
});
test('different executable inside the installation directory blocks', async () => {
  assert.equal((await detectWindowsProcesses(adapter([observed(200, {
    canonicalPath: `${directory.canonicalPath}\\helpers\\renamed.exe`, volume: '12ab', fileId: '99'
  })]))).state, 'ACTIVE');
});
test('same path with changed file ID is ambiguous', async () => {
  assert.equal((await detectWindowsProcesses(adapter([observed(200, { ...executable, fileId: '99' })]))).state, 'INDETERMINATE');
});
test('target identity changes during inspection block even with zero processes', async () => {
  for (const after of [
    { ...target, directory: { ...directory, fileId: '99' } },
    { ...target, executable: { ...executable, fileId: '99' } },
    { directory: { ...directory, canonicalPath: 'C:\\Redirected' }, executable: { ...executable, canonicalPath: 'C:\\Redirected\\Atlas.exe' } }
  ]) {
    const source = adapter([]); source.verifyInstallation = async () => after;
    assert.equal((await detectWindowsProcesses(source)).state, 'INDETERMINATE');
  }
});
test('missing target and post-enumeration resolution errors block', async () => {
  for (const stage of ['installation', 'verifyInstallation'] as const) {
    const source = adapter([]); source[stage] = async () => { throw new Error('not found'); };
    assert.equal((await detectWindowsProcesses(source)).state, 'INDETERMINATE');
  }
});
test('malformed and duplicate process records cannot authorize maintenance', async () => {
  for (const processes of [[observed(200), observed(200)], [observed(-1)], [null] as unknown as ProcessObservation[]]) {
    assert.equal((await detectWindowsProcesses(adapter(processes))).state, 'INDETERMINATE');
  }
});
test('positive evidence blocks even if another process is inaccessible', async () => {
  const result = await detectWindowsProcesses(adapter([observed(200), { pid: 201, status: 'UNKNOWN' }]));
  assert.equal(result.state, 'ACTIVE'); assert.equal(result.maintenanceAllowed, false);
  assert.deepEqual(result.uncertainPids, [201]);
});
test('adapter requests limited read/query rights and never performs process or installation mutations', () => {
  const root = resolve(import.meta.dirname, '../..');
  const collector = readFileSync(resolve(root, 'scripts/collect-atlas-processes.ps1'), 'utf8');
  const cli = readFileSync(resolve(root, 'scripts/check-atlas-processes.ts'), 'utf8');
  assert.match(collector, /OpenProcess\(0x00101000, false, pid\)/);
  assert.match(collector, /CreateFileW\(value, 0, 7, IntPtr.Zero, 3,/);
  assert.match(collector, /GetFinalPathNameByHandleW/);
  assert.match(collector, /GetFileInformationByHandle/);
  assert.match(collector, /GetProcessTimes/);
  assert.doesNotMatch(collector, /taskkill|TerminateProcess|Stop-Process|SendMessage|PostMessage|WriteFile|Set-Content|Remove-Item|PROCESS_ALL_ACCESS/i);
  assert.doesNotMatch(cli, /shell:\s*true|ExecutionPolicy|runas|taskkill|\.kill\(/i);
});
