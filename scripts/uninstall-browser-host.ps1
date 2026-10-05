$ErrorActionPreference = 'Stop'
# Explicit user action only. Stop Atlas first; never terminate Chrome.
$key = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.atlas.browser_bridge'
if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key -Recurse }
$install = Join-Path $env:LOCALAPPDATA 'Atlas\BrowserBridge'
if ((Test-Path -LiteralPath $install) -and (((Get-Item -LiteralPath $install -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'Unsafe installation path' }
if (Test-Path -LiteralPath $install) { Remove-Item -LiteralPath $install -Recurse }
Write-Output 'Atlas native host removed. Remove the extension separately in chrome://extensions.'
