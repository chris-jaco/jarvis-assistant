# Read-only ACL check. Never changes permissions or prints SIDs/device data.
param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
try {
  $item = Get-Item -LiteralPath $Directory
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { exit 2 }
  $acl = Get-Acl -LiteralPath $Directory
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user) { exit 2 }
  $allowed = @($user, 'S-1-5-18', 'S-1-5-32-544') # Current user, SYSTEM, local administrators.
  foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        (([int64]$rule.FileSystemRights -band 7) -ne 0) -and
        ($allowed -notcontains $rule.IdentityReference.Value)) { exit 2 }
  }
  exit 0
} catch { exit 2 }
