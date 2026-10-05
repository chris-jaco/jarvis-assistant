import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Stats } from 'node:fs';
import { AclWorker } from './acl-worker.js';
import { ToolError } from '../types.js';

// Fixed script; only a path and operation travel over stdin. Never tokens, arguments
// interpolated into PowerShell, stdout diagnostics, or an execution-policy bypass.
const ACL_VALIDATION = String.raw`
  $path = [IO.Path]::GetFullPath($request.path)
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $trusted = @($user.Value, 'S-1-5-18', 'S-1-5-32-544')
  $cursor = $path
  while ($cursor) {
    $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unsafe path' }
    $parent = [IO.Directory]::GetParent($cursor)
    if ($null -eq $parent) { break }
    $cursor = $parent.FullName
  }
  if ($request.operation -eq 'initializeDirectory') {
    if (-not (Get-Item -LiteralPath $path -Force).PSIsContainer) { throw 'Not a directory' }
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($user)
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $propagate = [Security.AccessControl.PropagationFlags]::None
    $allow = [Security.AccessControl.AccessControlType]::Allow
    foreach ($sid in @($user, ([System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')))) {
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, $propagate, $allow)
      $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $path -AclObject $acl
  } elseif ($request.operation -ne 'validate') { throw 'Invalid operation' }
  $acl = Get-Acl -LiteralPath $path
  if ($acl.Owner -eq $null) { throw 'Missing owner' }
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($owner -ne $user.Value) { throw 'Wrong owner' }
  $hasUser = $false
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
      if ($trusted -notcontains $rule.IdentityReference.Value) { throw 'Broad access' }
      if ($rule.IdentityReference.Value -eq $user.Value -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadData) -ne 0) { $hasUser = $true }
    }
  }
  if (-not $hasUser) { throw 'Missing user access' }
`;
const ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
` + ACL_VALIDATION + String.raw`
  [Console]::Out.Write('OK')
} catch { exit 1 }
`;
const BATCH_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
while (($line = [Console]::In.ReadLine()) -ne $null) {
  try {
    $requests = $line | ConvertFrom-Json
    foreach ($request in $requests) {
` + ACL_VALIDATION + String.raw`
    }
    [Console]::Out.WriteLine('OK')
  } catch { [Console]::Out.WriteLine('FAIL') }
}
`;
export type WindowsAclOperation = 'initializeDirectory' | 'validate';
export type WindowsAclCheck = (path: string, operation: WindowsAclOperation) => Promise<void>;
export function windowsAclPayload(path: string, operation: WindowsAclOperation): string {
  return JSON.stringify({ path, operation }).replace(/[^\x00-\x7f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
export interface WindowsAclRequest { path: string; operation: WindowsAclOperation }
export type WindowsAclBatchCheck = (requests: WindowsAclRequest[], signal?: AbortSignal) => Promise<void>;
async function runAcl(script: string, payload: string, signal?: AbortSignal): Promise<void> {
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let finished = false;
    const finish = (success: boolean) => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); success ? resolve() : reject(new ToolError(signal?.aborted ? 'TIMEOUT' : 'UNCONFIGURED')); };
    const abort = () => { child.kill(); finish(false); };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { child.kill(); finish(false); }, 10_000);
    child.on('error', () => finish(false));
    child.stdin.on('error', () => finish(false));
    child.stdout.on('data', chunk => { output += String(chunk); if (output.length > 100) { child.kill(); finish(false); } });
    child.stderr.resume(); // Discard diagnostics; never forward filesystem/security details.
    child.on('close', code => finish(code === 0 && output === 'OK'));
    // Windows PowerShell 5.1 stdin may use an OEM codepage. ASCII JSON escapes
    // preserve Unicode paths without changing process-wide encoding settings.
    if (signal?.aborted) abort();
    else child.stdin.end(payload);
  });
}
export const windowsAclCheck: WindowsAclCheck = (path, operation) => runAcl(ACL_SCRIPT, windowsAclPayload(path, operation));
const batchWorker = new AclWorker(() => {
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', BATCH_ACL_SCRIPT], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
});
process.once('exit', () => batchWorker.close());
export const windowsAclBatchCheck: WindowsAclBatchCheck = (requests, signal) => batchWorker.check(JSON.stringify(requests).replace(/[^\x00-\x7f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`), signal);

export interface FileSecurityEntry { path: string; info: Stats; directory?: boolean; newlyCreated?: boolean }
export class TokenFileSecurity {
  constructor(readonly platform: NodeJS.Platform = process.platform, private readonly acl: WindowsAclCheck = windowsAclCheck, private readonly batch: WindowsAclBatchCheck | undefined = acl === windowsAclCheck ? windowsAclBatchCheck : undefined) {}
  validateStructure(info: Stats, directory = false): void {
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || (!directory && info.nlink !== 1)) throw new ToolError('UNCONFIGURED');
    if (this.platform !== 'win32' && (!process.getuid || info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) throw new ToolError('UNCONFIGURED');
  }
  async validate(path: string, info: Stats, directory = false, newlyCreated = false): Promise<void> {
    this.validateStructure(info, directory);
    if (this.platform === 'win32') await this.acl(path, directory && newlyCreated ? 'initializeDirectory' : 'validate');
  }
  async validateMany(entries: FileSecurityEntry[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    for (const e of entries) this.validateStructure(e.info, e.directory);
    if (this.platform !== 'win32') return;
    const requests = entries.map(e => ({ path: e.path, operation: e.directory && e.newlyCreated ? 'initializeDirectory' as const : 'validate' as const }));
    if (this.batch) await this.batch(requests, signal);
    else for (const request of requests) { signal?.throwIfAborted(); await this.acl(request.path, request.operation); }
    signal?.throwIfAborted();
  }
}
