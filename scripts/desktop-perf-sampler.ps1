[CmdletBinding()]
param(
    [ValidateRange(1, 86400)]
    [int]$DurationSeconds = 600,

    [ValidateRange(1, 3600)]
    [int]$IntervalSeconds = 5,

    [string]$OutputPath = (Join-Path (Get-Location) ("atlas-desktop-perf-{0}.csv" -f (Get-Date -Format "yyyyMMdd-HHmmss"))),

    [string]$RepositoryRoot = '',

    [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$CsvColumns = @(
    'Timestamp', 'Sample', 'ProcessState', 'Role', 'Pid', 'ParentPid',
    'WorkingSetBytes', 'PrivateBytes', 'CpuTotalSeconds', 'CpuPercentInterval',
    'Handles', 'Threads', 'AtlasProcessCount', 'LocalTcpConnections'
)

function Resolve-AtlasRepositoryRoot {
    param(
        [AllowEmptyString()][string]$RequestedRoot,
        [Parameter(Mandatory)][string]$ScriptDirectory
    )
    $candidate = if ([string]::IsNullOrWhiteSpace($RequestedRoot)) {
        Split-Path -Parent $ScriptDirectory
    } else {
        $RequestedRoot
    }
    try {
        $resolved = (Resolve-Path -LiteralPath $candidate -ErrorAction Stop).Path
    } catch {
        throw 'ATLAS_PERF_REPOSITORY_INVALID: repository root does not exist.'
    }
    $expectedScript = Join-Path $resolved 'scripts\desktop-perf-sampler.ps1'
    $packageManifest = Join-Path $resolved 'package.json'
    $gitMetadata = Join-Path $resolved '.git'
    if (-not (Test-Path -LiteralPath $expectedScript -PathType Leaf) -or
        -not (Test-Path -LiteralPath $packageManifest -PathType Leaf) -or
        -not (Test-Path -LiteralPath $gitMetadata)) {
        throw 'ATLAS_PERF_REPOSITORY_INVALID: path is not the Atlas checkout containing this sampler.'
    }
    return $resolved
}

function Normalize-PathText {
    param([AllowNull()][string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
    return ($Value -replace '/', '\').TrimEnd('\').ToLowerInvariant()
}

function Get-DescendantProcessIds {
    param(
        [Parameter(Mandatory)][object[]]$Processes,
        [Parameter(Mandatory)][int]$RootPid
    )
    $known = [System.Collections.Generic.HashSet[int]]::new()
    [void]$known.Add($RootPid)
    do {
        $changed = $false
        foreach ($process in $Processes) {
            $pidValue = [int]$process.ProcessId
            if (-not $known.Contains($pidValue) -and $known.Contains([int]$process.ParentProcessId)) {
                [void]$known.Add($pidValue)
                $changed = $true
            }
        }
    } while ($changed)
    return @($known)
}

function Resolve-AtlasProcessSnapshot {
    param(
        [Parameter(Mandatory)][object[]]$Processes,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Connections,
        [Parameter(Mandatory)][string]$ExpectedRepositoryRoot,
        [int]$ExpectedMainPid = 0,
        [int]$KnownCorePid = 0
    )
    $root = Normalize-PathText $ExpectedRepositoryRoot
    $entry = "$root\dist\desktop-build\desktop\main.js"
    $relativeEntry = 'dist\desktop-build\desktop\main.js'
    $developmentExecutableRoot = "$root\node_modules\electron\dist"
    $mainCandidates = @($Processes | Where-Object {
        $command = Normalize-PathText ([string]$_.CommandLine)
        $executable = Normalize-PathText ([string]$_.ExecutablePath)
        $_.Name -ieq 'electron.exe' -and ($command.Contains($entry) -or ($command.Contains($relativeEntry) -and $executable.StartsWith($developmentExecutableRoot)))
    })
    if ($ExpectedMainPid -gt 0) {
        $mainCandidates = @($mainCandidates | Where-Object { [int]$_.ProcessId -eq $ExpectedMainPid })
    }
    if ($mainCandidates.Count -ne 1) {
        throw "ATLAS_PROCESS_IDENTIFICATION_FAILED: expected exactly one Electron Main for this repository; found $($mainCandidates.Count)."
    }

    $main = $mainCandidates[0]
    $ids = Get-DescendantProcessIds -Processes $Processes -RootPid ([int]$main.ProcessId)
    $atlas = @($Processes | Where-Object { $ids -contains [int]$_.ProcessId })
    $loopbackListeners = @($Connections | Where-Object {
        $_.State -eq 'Listen' -and $_.LocalAddress -in @('127.0.0.1', '::1') -and $ids -contains [int]$_.OwningProcess
    })
    $coreIds = @($loopbackListeners | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique)
    $knownCorePresent = $KnownCorePid -gt 0 -and $ids -contains $KnownCorePid
    if ($knownCorePresent) {
        $corePid = $KnownCorePid
    } elseif ($coreIds.Count -eq 1) {
        $corePid = $coreIds[0]
    } elseif ($KnownCorePid -gt 0 -and $coreIds.Count -eq 0) {
        # Preserve the prior identity so New-AtlasSampleRows can emit DISAPPEARED.
        $corePid = $KnownCorePid
    } else {
        throw "ATLAS_PROCESS_IDENTIFICATION_FAILED: expected exactly one Atlas descendant with a loopback listener; found $($coreIds.Count)."
    }

    $roles = @{}
    foreach ($process in $atlas) {
        $pidValue = [int]$process.ProcessId
        $command = [string]$process.CommandLine
        $roles[$pidValue] = if ($pidValue -eq [int]$main.ProcessId) {
            'MAIN'
        } elseif ($pidValue -eq $corePid) {
            'CORE'
        } elseif ($command -match '(?:^|\s)--type=renderer(?:\s|$)') {
            'RENDERER'
        } else {
            'AUXILIARY'
        }
    }
    return [pscustomobject]@{
        MainPid = [int]$main.ProcessId
        CorePid = [int]$corePid
        Processes = $atlas
        Roles = $roles
    }
}

function Get-CpuTotalSeconds {
    param([Parameter(Mandatory)][object]$Process)
    return (([double]$Process.KernelModeTime + [double]$Process.UserModeTime) / 10000000.0)
}

function New-AtlasSampleRows {
    param(
        [Parameter(Mandatory)][object]$Snapshot,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Connections,
        [Parameter(Mandatory)][int]$SampleNumber,
        [Parameter(Mandatory)][datetimeoffset]$Timestamp,
        [Parameter(Mandatory)][double]$ElapsedSeconds,
        [Parameter(Mandatory)][int]$LogicalProcessorCount,
        [Parameter(Mandatory)][AllowEmptyCollection()][hashtable]$PreviousCpu,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.HashSet[int]]$SeenPids,
        [Parameter(Mandatory)][AllowEmptyCollection()][hashtable]$PreviousProcesses
    )
    $currentIds = [System.Collections.Generic.HashSet[int]]::new()
    $rows = [System.Collections.Generic.List[object]]::new()
    $processCount = @($Snapshot.Processes).Count
    foreach ($process in @($Snapshot.Processes)) {
        $pidValue = [int]$process.ProcessId
        [void]$currentIds.Add($pidValue)
        $totalCpu = Get-CpuTotalSeconds $process
        $cpuPercent = $null
        if ($ElapsedSeconds -gt 0 -and $PreviousCpu.ContainsKey($pidValue)) {
            $delta = [Math]::Max(0, $totalCpu - [double]$PreviousCpu[$pidValue])
            $cpuPercent = [Math]::Round(($delta / $ElapsedSeconds / [Math]::Max(1, $LogicalProcessorCount)) * 100, 3)
        }
        $state = if ($PreviousProcesses.ContainsKey($pidValue)) { 'PRESENT' } else { 'NEW' }
        [void]$SeenPids.Add($pidValue)
        $PreviousCpu[$pidValue] = $totalCpu
        $PreviousProcesses[$pidValue] = [pscustomobject]@{ Role = [string]$Snapshot.Roles[$pidValue]; ParentPid = [int]$process.ParentProcessId }
        $tcpCount = @($Connections | Where-Object {
            [int]$_.OwningProcess -eq $pidValue -and ($_.LocalAddress -in @('127.0.0.1', '::1') -or $_.RemoteAddress -in @('127.0.0.1', '::1'))
        }).Count
        [void]$rows.Add([pscustomobject][ordered]@{
            Timestamp = $Timestamp.ToString('o'); Sample = $SampleNumber; ProcessState = $state
            Role = [string]$Snapshot.Roles[$pidValue]; Pid = $pidValue; ParentPid = [int]$process.ParentProcessId
            WorkingSetBytes = [int64]$process.WorkingSetSize; PrivateBytes = [int64]$process.PrivatePageCount
            CpuTotalSeconds = [Math]::Round($totalCpu, 3); CpuPercentInterval = $cpuPercent
            Handles = [int]$process.HandleCount; Threads = [int]$process.ThreadCount
            AtlasProcessCount = $processCount; LocalTcpConnections = $tcpCount
        })
    }
    foreach ($pidValue in @($PreviousProcesses.Keys)) {
        if ($currentIds.Contains([int]$pidValue)) { continue }
        $previous = $PreviousProcesses[$pidValue]
        [void]$rows.Add([pscustomobject][ordered]@{
            Timestamp = $Timestamp.ToString('o'); Sample = $SampleNumber; ProcessState = 'DISAPPEARED'
            Role = [string]$previous.Role; Pid = [int]$pidValue; ParentPid = [int]$previous.ParentPid
            WorkingSetBytes = $null; PrivateBytes = $null; CpuTotalSeconds = $null; CpuPercentInterval = $null
            Handles = $null; Threads = $null; AtlasProcessCount = $processCount; LocalTcpConnections = 0
        })
        [void]$PreviousProcesses.Remove($pidValue)
        [void]$PreviousCpu.Remove($pidValue)
    }
    return @($rows)
}

function Assert-SelfTest {
    $root = 'C:\work\jarvis-assistant'
    $processes = @(
        [pscustomobject]@{ Name='electron.exe';ProcessId=100;ParentProcessId=1;ExecutablePath='C:\work\jarvis-assistant\node_modules\electron\dist\electron.exe';CommandLine='electron.exe dist\desktop-build\desktop\main.js';WorkingSetSize=10;PrivatePageCount=9;KernelModeTime=10000000;UserModeTime=10000000;HandleCount=10;ThreadCount=2 },
        [pscustomobject]@{ Name='electron.exe';ProcessId=101;ParentProcessId=100;ExecutablePath='C:\work\jarvis-assistant\node_modules\electron\dist\electron.exe';CommandLine='electron.exe --type=utility';WorkingSetSize=20;PrivatePageCount=18;KernelModeTime=20000000;UserModeTime=10000000;HandleCount=11;ThreadCount=3 },
        [pscustomobject]@{ Name='electron.exe';ProcessId=102;ParentProcessId=100;ExecutablePath='C:\work\jarvis-assistant\node_modules\electron\dist\electron.exe';CommandLine='electron.exe --type=renderer';WorkingSetSize=30;PrivatePageCount=27;KernelModeTime=30000000;UserModeTime=10000000;HandleCount=12;ThreadCount=4 },
        [pscustomobject]@{ Name='electron.exe';ProcessId=900;ParentProcessId=1;ExecutablePath='C:\other\electron.exe';CommandLine='electron.exe dist\desktop-build\desktop\main.js';WorkingSetSize=99;PrivatePageCount=99;KernelModeTime=0;UserModeTime=0;HandleCount=1;ThreadCount=1 }
    )
    $connections = @([pscustomobject]@{ State='Listen';LocalAddress='127.0.0.1';RemoteAddress='0.0.0.0';OwningProcess=101 })
    $snapshot = Resolve-AtlasProcessSnapshot -Processes $processes -Connections $connections -ExpectedRepositoryRoot $root
    if ($snapshot.MainPid -ne 100 -or $snapshot.CorePid -ne 101 -or @($snapshot.Processes).Count -ne 3 -or $snapshot.Roles[102] -ne 'RENDERER') { throw 'SELF_TEST_PROCESS_IDENTIFICATION' }
    $previousCpu=@{};$seen=[System.Collections.Generic.HashSet[int]]::new();$previous=@{}
    $first = New-AtlasSampleRows -Snapshot $snapshot -Connections $connections -SampleNumber 1 -Timestamp ([datetimeoffset]'2026-01-01T00:00:00Z') -ElapsedSeconds 0 -LogicalProcessorCount 4 -PreviousCpu $previousCpu -SeenPids $seen -PreviousProcesses $previous
    $processes[1].KernelModeTime=30000000
    $secondSnapshot=Resolve-AtlasProcessSnapshot -Processes @($processes[0],$processes[1]) -Connections $connections -ExpectedRepositoryRoot $root -ExpectedMainPid 100 -KnownCorePid 101
    $second=New-AtlasSampleRows -Snapshot $secondSnapshot -Connections $connections -SampleNumber 2 -Timestamp ([datetimeoffset]'2026-01-01T00:00:05Z') -ElapsedSeconds 5 -LogicalProcessorCount 4 -PreviousCpu $previousCpu -SeenPids $seen -PreviousProcesses $previous
    $coreRow=$second|Where-Object Role -eq 'CORE';$gone=$second|Where-Object ProcessState -eq 'DISAPPEARED'
    if ($coreRow.CpuPercentInterval -ne 5 -or @($gone).Count -ne 1 -or $gone[0].Role -ne 'RENDERER') { throw 'SELF_TEST_SAMPLING' }
    $headers=($first[0].psobject.Properties.Name -join ',')
    if ($headers -ne ($CsvColumns -join ',') -or $headers -match 'CommandLine|Url|Token|Cookie|Prompt|Secret') { throw 'SELF_TEST_CSV_CONTRACT' }
    try { Resolve-AtlasProcessSnapshot -Processes @($processes + [pscustomobject]@{Name='electron.exe';ProcessId=901;ParentProcessId=1;ExecutablePath='C:\work\jarvis-assistant\node_modules\electron\dist\electron.exe';CommandLine='electron.exe dist\desktop-build\desktop\main.js'}) -Connections $connections -ExpectedRepositoryRoot $root | Out-Null; throw 'SELF_TEST_FALSE_POSITIVE' } catch { if ($_.Exception.Message -eq 'SELF_TEST_FALSE_POSITIVE') { throw } }
    Write-Host 'ATLAS_DESKTOP_PERF_SELF_TEST_OK'
}

if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) { throw 'ATLAS_PERF_SCRIPT_CONTEXT_MISSING: script directory is unavailable.' }
$resolvedRoot = Resolve-AtlasRepositoryRoot -RequestedRoot $RepositoryRoot -ScriptDirectory $PSScriptRoot
if ($SelfTest) {
    Assert-SelfTest
    exit 0
}

if ($env:OS -ne 'Windows_NT') { throw 'ATLAS_PERF_WINDOWS_REQUIRED: run this sampler from Windows PowerShell or PowerShell 7 on Windows.' }
$parent = Split-Path -Parent $OutputPath
if ([string]::IsNullOrWhiteSpace($parent)) { $parent = (Get-Location).Path }
if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
if (Test-Path -LiteralPath $OutputPath) { throw 'ATLAS_PERF_OUTPUT_EXISTS: choose a new CSV path.' }

function Read-SystemSnapshot {
    $processes = @(Get-CimInstance Win32_Process)
    $connections = @(Get-NetTCPConnection -ErrorAction Stop)
    return [pscustomobject]@{ Processes=$processes;Connections=$connections }
}

$system = Read-SystemSnapshot
$atlas = Resolve-AtlasProcessSnapshot -Processes $system.Processes -Connections $system.Connections -ExpectedRepositoryRoot $resolvedRoot
$mainPid = $atlas.MainPid
$corePid = $atlas.CorePid
$logicalProcessors = [Environment]::ProcessorCount
$previousCpu=@{};$seen=[System.Collections.Generic.HashSet[int]]::new();$previousProcesses=@{}
$allRows=[System.Collections.Generic.List[object]]::new()
$started=[datetimeoffset]::Now;$last=$started;$sampleNumber=0
$csvCreated=$false
Write-Host "Sampling one Atlas instance for $DurationSeconds seconds every $IntervalSeconds seconds. Main PID: $mainPid."

while (([datetimeoffset]::Now - $started).TotalSeconds -lt $DurationSeconds) {
    $now=[datetimeoffset]::Now;$elapsed=if($sampleNumber -eq 0){0}else{($now-$last).TotalSeconds};$last=$now;$sampleNumber++
    $system=Read-SystemSnapshot
    $atlas=Resolve-AtlasProcessSnapshot -Processes $system.Processes -Connections $system.Connections -ExpectedRepositoryRoot $resolvedRoot -ExpectedMainPid $mainPid -KnownCorePid $corePid
    $corePid=$atlas.CorePid
    $rows=New-AtlasSampleRows -Snapshot $atlas -Connections $system.Connections -SampleNumber $sampleNumber -Timestamp $now -ElapsedSeconds $elapsed -LogicalProcessorCount $logicalProcessors -PreviousCpu $previousCpu -SeenPids $seen -PreviousProcesses $previousProcesses
    foreach($row in $rows){[void]$allRows.Add($row)}
    if($csvCreated){$rows|Select-Object $CsvColumns|Export-Csv -LiteralPath $OutputPath -NoTypeInformation -Encoding utf8 -Append}
    else{$rows|Select-Object $CsvColumns|Export-Csv -LiteralPath $OutputPath -NoTypeInformation -Encoding utf8;$csvCreated=$true}
    $remaining=$DurationSeconds-([datetimeoffset]::Now-$started).TotalSeconds
    if($remaining -gt 0){Start-Sleep -Milliseconds ([int]([Math]::Min($IntervalSeconds,$remaining)*1000))}
}

$active=@($allRows|Where-Object ProcessState -ne 'DISAPPEARED')
$summary=$active|Group-Object Role|Sort-Object Name|ForEach-Object{
    $memory=@($_.Group|ForEach-Object {[double]$_.PrivateBytes});$cpu=@($_.Group|Where-Object {$null -ne $_.CpuPercentInterval}|ForEach-Object {[double]$_.CpuPercentInterval})
    [pscustomobject]@{Role=$_.Name;Samples=$_.Count;UniquePids=@($_.Group.Pid|Sort-Object -Unique).Count;PeakPrivateMiB=[Math]::Round((($memory|Measure-Object -Maximum).Maximum/1MB),2);AverageCpuPercent=if($cpu.Count){[Math]::Round(($cpu|Measure-Object -Average).Average,3)}else{0}}
}
Write-Host "CSV: $OutputPath"
$summary|Format-Table -AutoSize
Write-Host ("Samples: {0}; unique Atlas PIDs: {1}; disappeared events: {2}" -f $sampleNumber,@($seen).Count,@($allRows|Where-Object ProcessState -eq 'DISAPPEARED').Count)
