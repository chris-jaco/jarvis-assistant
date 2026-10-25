param([Parameter(Mandatory=$true)][string]$SdkRoot,
      [Parameter(Mandatory=$true)][string]$OutputDir,
      [switch]$Live)
# Run in an existing MSVC x64 developer PowerShell. No installation or native execution.
$ErrorActionPreference = 'Stop'
try {
  $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
  $localRoot = [IO.Path]::GetFullPath((Join-Path $repo '.local')) + [IO.Path]::DirectorySeparatorChar
  $sdk = (Resolve-Path -LiteralPath $SdkRoot).Path
  $out = [IO.Path]::GetFullPath($OutputDir)
  foreach ($item in @($sdk, $out)) {
    if (-not $item.StartsWith($localRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'LOCAL_PATH_REQUIRED' }
    $ancestor = $item
    while ($ancestor) {
      if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'REPARSE_POINT_REJECTED' }
      $parent = Split-Path -Parent $ancestor
      if ($parent -eq $ancestor -or -not $parent) { break }; $ancestor = $parent
    }
  }
  if (Test-Path -LiteralPath $out) { throw 'FRESH_OUTPUT_REQUIRED' }
  if ($env:VSCMD_ARG_TGT_ARCH -ne 'x64') { throw 'MSVC_X64_REQUIRED' }
  $compiler = (Get-Command cl.exe -ErrorAction Stop).Source
  $files = @{
    'include/sherpa-onnx/c-api/c-api.h' = '9bbc2e18824d723996bca28d51ef6a11f29b0fb80aaa4c89fdcc06f045a954d0'
    'lib/sherpa-onnx-c-api.lib' = 'edf4b780d0ab4f0320d210f9cfc7e96e01d9b0dbee7234746f6cb6b422065997'
    'lib/sherpa-onnx-c-api.dll' = '949e720ba4282d1097025d1f469317e16c06c69820d0384acd648cd12fcba983'
    'lib/onnxruntime.dll' = '422d776ab0e3218260f7f628fcb84606aaa5c21116f720c8619a6da5e0b2e0f9'
    'lib/onnxruntime_providers_shared.dll' = '0190137dee4933261c065c5d030c3568a68c7aa43cad942b4726a07011738bc2'
  }
  foreach ($entry in $files.GetEnumerator()) {
    $file = Join-Path $sdk $entry.Key
    $cursor = $file
    while ($cursor.StartsWith($localRoot,[StringComparison]::OrdinalIgnoreCase)) {
      if ((Get-Item -LiteralPath $cursor).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'REPARSE_POINT_REJECTED' }
      $cursor = Split-Path -Parent $cursor
    }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant() -ne $entry.Value) { throw 'SDK_HASH_MISMATCH' }
  }
  New-Item -ItemType Directory -Path $out | Out-Null
  $stem = if ($Live) { 'native-live' } else { 'reference-kws' }
  $source = Join-Path $PSScriptRoot "$stem.cc"
  $exe = Join-Path $out "$stem.exe"
  & $compiler /nologo /EHsc /O2 /MD /std:c++17 /utf-8 /DSHERPA_ONNX_BUILD_SHARED_LIBS=1 /D_WIN32_WINNT=0x0A00 /DNOMINMAX `
    "/I$(Join-Path $sdk 'include')" $source "/Fe:$exe" "/Fo:$(Join-Path $out "$stem.obj")" `
    /link /MACHINE:X64 (Join-Path $sdk 'lib/sherpa-onnx-c-api.lib') bcrypt.lib psapi.lib ole32.lib uuid.lib
  if ($LASTEXITCODE -ne 0) { throw 'BUILD_FAILED' }
  foreach ($name in @('sherpa-onnx-c-api.dll','onnxruntime.dll','onnxruntime_providers_shared.dll')) {
    Copy-Item -LiteralPath (Join-Path $sdk "lib/$name") -Destination (Join-Path $out $name)
  }
  $lock = @{schema=1;version='2.0.0';commit='8abb7c8f87eae85b2e75f9a4115236c978980add';
    artifactSha256='98d8cf1c0e0bfb5768042e90ffe9591203855b8f4aabdcd5c154eb39b87a0707';
    sourceSha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash.ToLowerInvariant();
    executableSha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant()}
  $lockName = 'native-lock.json'
  if ($Live) {
    $lock.kind = 'NATIVE_LIVE'
    $lock.calibrationSourceSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $PSScriptRoot 'native-calibration-core.h')).Hash.ToLowerInvariant()
    $lock.diagnosticSourceSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $PSScriptRoot 'native-fn-core.h')).Hash.ToLowerInvariant()
    $lock.referenceSourceSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $PSScriptRoot 'reference-kws.cc')).Hash.ToLowerInvariant()
    $lock.coreSourceSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $PSScriptRoot 'native-live-core.h')).Hash.ToLowerInvariant()
    $lockName = 'native-live-lock.json'
  }
  $lock | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $out $lockName) -Encoding ASCII
  Write-Output 'BUILD_COMPLETE_NOT_EXECUTED'
} catch { Write-Error 'NATIVE_BUILD_FAILED'; exit 2 }
