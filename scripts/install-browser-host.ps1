param([Parameter(Mandatory=$true)][ValidatePattern('^[a-p]{32}$')][string]$ExtensionId)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$install = Join-Path $env:LOCALAPPDATA 'Atlas\BrowserBridge'
function Assert-SafePath([string]$Path) {
  $cursor = [IO.Path]::GetFullPath($Path)
  while ($cursor) {
    if ((Test-Path -LiteralPath $cursor) -and (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'Unsafe installation path' }
    $parent = [IO.Directory]::GetParent($cursor); if ($null -eq $parent) { break }; $cursor = $parent.FullName
  }
}
Assert-SafePath $install
$versionDir = Join-Path $install '0.5.1'
if (Test-Path -LiteralPath $versionDir) { throw 'Version already installed. Stop Atlas and uninstall before reinstalling this development build.' }
New-Item -ItemType Directory -Path $versionDir -Force | Out-Null
# Private installation directory; no profile/Chrome data is accessed.
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($user); $acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($user, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit', [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
}
Set-Acl -LiteralPath $install -AclObject $acl
& dotnet publish (Join-Path $repo 'native\Atlas.BrowserHost\Atlas.BrowserHost.csproj') -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o $versionDir
if ($LASTEXITCODE -ne 0) { throw 'Native host publish failed. Registry was not changed.' }
$exe = Join-Path $versionDir 'Atlas.NativeHost.exe'
[IO.File]::WriteAllText((Join-Path $versionDir 'atlas-host.json'), (@{ extensionId = $ExtensionId } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$manifest = Join-Path $install 'com.atlas.browser_bridge.json'
[IO.File]::WriteAllText($manifest, (@{ name='com.atlas.browser_bridge'; description='Atlas Chrome Native Messaging Bridge'; path=$exe; type='stdio'; allowed_origins=@("chrome-extension://$ExtensionId/") } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$key = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.atlas.browser_bridge'
New-Item -Path $key -Force | Out-Null
Set-Item -LiteralPath $key -Value $manifest
Write-Output "Installed native host. Set ATLAS_BROWSER_HOST_PATH=$exe"
Write-Output "Set ATLAS_BROWSER_EXTENSION_ID=$ExtensionId"
