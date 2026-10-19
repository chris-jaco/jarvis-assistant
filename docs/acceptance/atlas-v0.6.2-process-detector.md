# Windows process detector — personal preview

> Cierre V0.6.2: investigación conservada, no autorización de mantenimiento.
> Win32 y CIM dejaron 149 procesos inciertos sin rutas adicionales en Windows 11.
> La investigación queda diferida; NSIS no está soportado. Un resultado ABSENT es
> una observación del detector, no exclusión atómica ni permiso para sobrescribir
> binarios. Ver `atlas-v0.6.2-windows.md` y `../DESKTOP.md`.

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

### Win32 diagnostic summary

```powershell
node --import tsx scripts/check-atlas-processes.ts 'C:\absolute\path\to\win-unpacked' --summary
$LASTEXITCODE
```

This prints state, reason, active/uncertain counts and `diagnosticSummary`, grouped
by closed stage, numeric Win32 error (or null), and QUERY/SYNCHRONIZE access.
No PIDs, executable paths, command lines or exception messages are printed in this
mode. Without --summary, diagnostics include PID for local correlation but still
omit paths, arguments and exception text. The collector's JSON is internal IPC to
the TypeScript policy, not a diagnostic report to share or log directly.

Stages: OPEN_PROCESS_FAILED, CREATION_TIME_FAILED, IMAGE_QUERY_FAILED,
IDENTITY_RESOLUTION_FAILED, PROCESS_EXIT_CONFIRMED, IDENTITY_MISMATCH.
PROCESS_EXIT_CONFIRMED is an observation, not an error. Groups count events, not
necessarily distinct processes: an earlier failed query can precede confirmed exit.
Win32 code 5 means access denied; null means no native numeric code was available.
IDENTITY_MISMATCH also covers unverified/malformed policy identities without a
collector failure code. It is not an assertion that PID reuse actually occurred.

Image/creation queries first request QUERY_LIMITED_INFORMATION only. A separate
query+synchronize handle is bound to the first handle's creation time before any
zero-time wait can confirm exit. Synchronization failure still leaves UNKNOWN,
even if image queries succeed: this diagnostic change does not weaken the previous
acceptance condition. No candidate-name exemptions or access-denied exemptions
were added. Diagnostics are projected through an allowlist independently of policy.

Collection/PowerShell/JSON failures still produce INDETERMINATE and exit 2. They
may have no per-PID summary because collection itself did not complete. The summary
does not establish why the previous Windows run failed: run it on Windows to obtain
the actual stage/code evidence. No elevation or permission changes are required.

### Combined CIM + Win32 coverage (diagnostic only)

```powershell
node --import tsx scripts/check-atlas-processes.ts 'C:\Users\chris\jarvis-assistant\release\win-unpacked' --coverage
$LASTEXITCODE
```

Run without elevation, from the checkout. This command prints only grouped counts,
fixed status/reason codes, and the existing aggregate Win32 diagnostic summary.
It never prints PIDs, paths, command lines, creation timestamps or provider errors.
The executable path and creation dates from CIM are used only in the internal IPC
snapshot. Do not print/share the collector's raw JSON.

With --coverage only, CIM inventories bracket the unchanged Win32 collection. They
request ProcessId, CreationDate and ExecutablePath; no methods, privilege changes
or writes are performed. CIM exceptions yield FAILED, not successful empty arrays.
The coverage analyzer receives only the detector's uncertain PIDs for correlation.

- cimBefore/cimAfter: total unique valid PIDs, with/without path, unavailable creation,
  and malformed record counts. Missing/failed inventories disable correlation.
- matchedWithPath/matchedWithoutPath: uncertain PID present in both CIM inventories,
  without a demonstrated CIM creation conflict. Missing creation is counted separately;
  these are coverage counts, not a claim of verified process identity.
- presentOnlyBefore/presentOnlyAfter/missingInBoth: temporal coverage differences,
  never proof of termination. PID reuse may explain differences.
- creationChangedBetweenCimSamples, win32CreationConflictsWithCim and
  win32InternalCreationConflict: contradictory evidence; no exclusion is performed.
- FILETIME values are compared at CIM's microsecond precision (100-ns remainder
  discarded). Equality is useful correlation evidence, not a held process handle.
- pathTextDiffers only compares text after case/slash normalization; short names,
  junctions and aliases can explain differences. It is not physical exclusion.
- Duplicate or malformed records are reported as partial/ambiguous coverage.
  Counters describe different dimensions and must not all be summed together.

The classifier and its input Win32 observations do not consume CIM. Exit codes
remain ACTIVE=1, ABSENT=0, INDETERMINATE=2. A CIM failure affects coverage availability,
not the existing detector's decision. In particular, an uncertain Win32 process
with a non-null CIM path remains uncertain. This is not a maintenance authorization
tool independent of the detector, and does not resolve its access-denied limitation.

Validate coverage on Windows with Atlas closed, visible and hidden. Core without
Main does not require parent correlation. Linux tests use synthetic records and
do not establish CIM behavior or completeness on Windows. No installation,
uninstallation or forced crash is part of this diagnostic.

## Boundaries

- PowerShell adapter: enumerate processes; open separate limited-query and synchronization handles;
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
