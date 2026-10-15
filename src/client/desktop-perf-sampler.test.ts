import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const path = 'scripts/desktop-perf-sampler.ps1';

test('repository root is resolved in the script body instead of from PSScriptRoot in parameter defaults', async () => {
  const source = await readFile(path, 'utf8');
  const parameterBlock = source.match(/^\[CmdletBinding\(\)\]\nparam\(([\s\S]*?)\n\)\n/m)?.[1] ?? '';
  assert.doesNotMatch(parameterBlock, /\$PSScriptRoot/);
  assert.match(parameterBlock, /\[string\]\$RepositoryRoot = ''/);
  assert.match(source, /Resolve-AtlasRepositoryRoot -RequestedRoot \$RepositoryRoot -ScriptDirectory \$PSScriptRoot/);
  assert.match(source, /ATLAS_PERF_SCRIPT_CONTEXT_MISSING/);
  assert.match(source, /ATLAS_PERF_REPOSITORY_INVALID/);
  assert.match(source, /scripts\\desktop-perf-sampler\.ps1/);
  assert.match(source, /package\.json/);
  assert.match(source, /'\.git'/);
  assert.ok(source.indexOf('$resolvedRoot = Resolve-AtlasRepositoryRoot') < source.indexOf('if ($SelfTest)'));
});

test('desktop performance sampler is read-only toward Atlas and scopes discovery to the repository process tree', async () => {
  const source = await readFile(path, 'utf8');
  assert.match(source, /dist\\desktop-build\\desktop\\main\.js/);
  assert.match(source, /Get-DescendantProcessIds/);
  assert.match(source, /expected exactly one Electron Main/);
  assert.match(source, /expected exactly one Atlas descendant with a loopback listener/);
  assert.doesNotMatch(source, /\b(?:Stop-Process|Kill\(|taskkill|Restart-Service|Set-Acl|Set-NetFirewall|Disable-NetAdapter|Enable-NetAdapter)\b/i);
});

test('desktop performance CSV contract contains bounded metrics and excludes private fields', async () => {
  const source = await readFile(path, 'utf8');
  const columns = source.match(/\$CsvColumns = @\(([\s\S]*?)\n\)/)?.[1] ?? '';
  for (const field of ['Timestamp','Sample','ProcessState','Role','Pid','ParentPid','WorkingSetBytes','PrivateBytes','CpuTotalSeconds','CpuPercentInterval','Handles','Threads','AtlasProcessCount','LocalTcpConnections']) {
    assert.match(columns, new RegExp(`'${field}'`));
  }
  assert.doesNotMatch(columns, /CommandLine|Url|Prompt|Token|Cookie|Secret|Message|Content/i);
  assert.match(source, /ATLAS_DESKTOP_PERF_SELF_TEST_OK/);
  assert.match(source, /ProcessState = 'DISAPPEARED'/);
  assert.match(source, /\$delta \/ \$ElapsedSeconds \/ \[Math\]::Max\(1, \$LogicalProcessorCount\)/);
});
