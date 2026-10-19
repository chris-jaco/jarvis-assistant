# Windows process detector — personal preview

Read-only tool, independent of NSIS and Atlas lifecycle. No termination, installation,
uninstallation, elevation or persistent configuration changes. No dependencies added.
PowerShell compiles an in-memory Win32 adapter with Add-Type (compiler temporary files
may be managed by Windows/.NET outside the installation).

## Windows 11 command

From the repository checkout with its existing development dependencies, use the
**existing packaged installation** directory (the directory containing Atlas.exe):

```powershell
node --import tsx scripts/check-atlas-processes.ts 'C:\absolute\path\to\win-unpacked'
$LASTEXITCODE
```

The path is an example; substitute the actual package directory. No install or
uninstall is performed. Existing PowerShell execution policy is respected.

Results: `ABSENT` / exit 0; `ACTIVE` / exit 1; `INDETERMINATE` / exit 2.
Only ABSENT sets maintenanceAllowed=true. A missing Atlas.exe is INDETERMINATE,
not permission to install. This detector is not an installation-state validator.

## Boundaries

- PowerShell adapter: enumerate processes; open limited-query/synchronize handles;
  capture creation times; query executable paths; resolve disk files/directories
  using GetFinalPathNameByHandle and volume/file identity. No command-line parsing.
- TypeScript policy: injectable installation, enumeration and final verification;
  same file identity or an image within the canonical installation directory is ACTIVE.
- Same-name executable in a distinct directory with distinct file identity is not
  this installation. Rejecting other Atlas installations belongs to a future NSIS policy.
- Held handles anchor process lifetime; zero-time waits confirm exit. Failed queries
  remain unknown. Open failures require a successful second enumeration confirming
  that PID disappeared before being classified EXITED_CONFIRMED.
- Every unresolvable user-image process blocks ABSENT, regardless of its name. Only
  Windows kernel identities PID 0 and PID 4 are excluded. Protected system processes
  may therefore make an otherwise idle machine INDETERMINATE. Do not elevate or
  weaken the policy to force a passing result.
- Fixed local disk paths only; UNC, mapped network drives and removable drives block.
  Short names/junctions are accepted only when Win32 resolves
  stable canonical identities; errors, unsupported paths, and changed targets block.
  This is not authorization to use junction destinations in a future installer.
- Canonical paths are compared case-insensitively, appropriate for the supported
  ordinary Windows installation directories. Case-sensitive directory layouts,
  hostile filesystem mutation and network filesystems are outside this preview.

## Validation and limits

Deterministic fixtures reconstruct the six process roles reported by the user;
PIDs, times and paths are synthetic. The original detailed Windows capture was not
provided as a file. Tests do not claim to execute Win32 or reproduce a real orphan.

On Windows, run with Atlas visible, hidden, closing, and fully closed. Compare
activePids to the detailed audit. If all processes are readable, the closed state
should be ABSENT; otherwise uncertainPids explains the conservative block. A Core
image remains detectable without Main because neither parent PID nor command-line
classification enters the decision. A real Main-absent/Core-present observation
remains a Windows acceptance item; no forced crash is required by this tool.

Linux tests verify policy and source constraints, not PowerShell compilation or
Win32 behavior. Windows adapter acceptance is required before NSIS integration.

ABSENT describes an enumeration interval, not atomic exclusion. A process can start
after enumeration, including reuse of a PID. Held handles prevent confusing a
queried process with a later PID owner, but cannot prevent new launches. Rechecking
before maintenance reduces this interval and never eliminates it.
