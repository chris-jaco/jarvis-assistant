[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$InstallationDirectory)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# In-memory Win32 adapter. No process control, registry writes or installation writes.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public sealed class AtlasFileIdentity {
    public string canonicalPath;
    public string volume;
    public string fileId;
}
public sealed class AtlasInstallationIdentity {
    public AtlasFileIdentity directory;
    public AtlasFileIdentity executable;
}
public sealed class AtlasProcessDiagnostic {
    public string stage;
    public int? win32Error;
    public string access;
}
public sealed class AtlasProcessObservation {
    public int pid;
    public string status;
    public string creation;
    public string verifiedCreation;
    public AtlasFileIdentity image;
    public List<AtlasProcessDiagnostic> diagnostics = new List<AtlasProcessDiagnostic>();
}
public static class AtlasReadOnlyProcessProbe {
    [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint low, high; }
    [StructLayout(LayoutKind.Sequential)] struct FileInformation {
        public uint attributes; public FileTime created, accessed, written;
        public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint sharing, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint size, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation information);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
    static extern uint GetDriveTypeW(string root);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetProcessTimes(IntPtr handle, out FileTime created, out FileTime exited, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);

    public static AtlasFileIdentity Resolve(string value, bool directory) {
        if (String.IsNullOrWhiteSpace(value) || !Path.IsPathRooted(value)) throw new IOException("ABSOLUTE_LOCAL_PATH_REQUIRED");
        string checkedPath = value.StartsWith(@"\\?\", StringComparison.Ordinal) ? value.Substring(4) : value;
        if (checkedPath.Length < 3 || !Char.IsLetter(checkedPath[0]) || checkedPath[1] != ':' ||
            (checkedPath[2] != '\\' && checkedPath[2] != '/')) throw new IOException("ABSOLUTE_LOCAL_PATH_REQUIRED");
        if (GetDriveTypeW(Path.GetPathRoot(checkedPath)) != 3) throw new IOException("FIXED_LOCAL_DISK_REQUIRED");
        using (SafeFileHandle file = CreateFileW(value, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
            if (file.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            FileInformation info;
            if (!GetFileInformationByHandle(file, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (((info.attributes & 0x10) != 0) != directory) throw new IOException("FILE_KIND_MISMATCH");
            var buffer = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandleW(file, buffer, (uint)buffer.Capacity, 0);
            if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (length >= buffer.Capacity) throw new IOException("CANONICAL_PATH_UNAVAILABLE");
            string canonical = buffer.ToString();
            if (canonical.StartsWith(@"\\?\", StringComparison.Ordinal)) canonical = canonical.Substring(4);
            if (canonical.Length < 3 || canonical[1] != ':' || canonical[2] != '\\') throw new IOException("LOCAL_DISK_REQUIRED");
            if (GetDriveTypeW(Path.GetPathRoot(canonical)) != 3) throw new IOException("FIXED_LOCAL_DISK_REQUIRED");
            return new AtlasFileIdentity { canonicalPath = canonical.TrimEnd('\\'), volume = info.volume.ToString("x8"),
                fileId = (((ulong)info.indexHigh << 32) | info.indexLow).ToString("x16") };
        }
    }
    public static AtlasInstallationIdentity Installation(string directory) {
        var identity = Resolve(directory, true);
        return new AtlasInstallationIdentity { directory = identity, executable = Resolve(Path.Combine(identity.canonicalPath, "Atlas.exe"), false) };
    }
    static string Birth(IntPtr process) {
        FileTime birth, exit, kernel, user;
        if (!GetProcessTimes(process, out birth, out exit, out kernel, out user)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return (((ulong)birth.high << 32) | birth.low).ToString(CultureInfo.InvariantCulture);
    }
    static bool Gone(int pid) {
        // Only a completed second enumeration can confirm disappearance without a handle.
        bool found = false;
        foreach (Process process in Process.GetProcesses()) {
            using (process) { if (process.Id == pid) found = true; }
        }
        return !found;
    }
    static void Record(AtlasProcessObservation row, string stage, Exception error, string access) {
        var native = error as Win32Exception;
        row.diagnostics.Add(new AtlasProcessDiagnostic { stage = stage,
            win32Error = native == null ? (int?)null : native.NativeErrorCode, access = access });
    }
    static bool Exited(AtlasProcessObservation row, IntPtr sync) {
        if (sync == IntPtr.Zero) return false;
        uint state = WaitForSingleObject(sync, 0);
        if (state == 0) {
            row.status = "EXITED_CONFIRMED";
            Record(row, "PROCESS_EXIT_CONFIRMED", null, "SYNCHRONIZE");
            return true;
        }
        if (state == 0xffffffff) Record(row, "OPEN_PROCESS_FAILED", new Win32Exception(Marshal.GetLastWin32Error()), "SYNCHRONIZE");
        return false;
    }
    public static AtlasProcessObservation[] Enumerate() {
        var rows = new List<AtlasProcessObservation>();
        var handles = new List<IntPtr>();
        try {
            foreach (Process process in Process.GetProcesses()) {
                using (process) {
                    int pid = process.Id;
                    // Windows Idle (0) and System (4) are kernel identities, not user images.
                    if (pid == 0 || pid == 4) continue;
                    var row = new AtlasProcessObservation { pid = pid, status = "UNKNOWN" };
                    // Image/creation queries do not need SYNCHRONIZE.
                    IntPtr handle = OpenProcess(0x00001000, false, pid);
                    int openError = handle == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
                    handles.Add(handle); rows.Add(row);
                    if (handle == IntPtr.Zero) Record(row, "OPEN_PROCESS_FAILED", new Win32Exception(openError), "QUERY");
                    else {
                        try { row.creation = Birth(handle); }
                        catch (Exception error) { Record(row, "CREATION_TIME_FAILED", error, "QUERY"); }
                    }
                }
            }
            for (int i = 0; i < rows.Count; i++) {
                var row = rows[i]; IntPtr handle = handles[i];
                if (handle == IntPtr.Zero) {
                    try {
                        if (Gone(row.pid)) {
                            row.status = "EXITED_CONFIRMED";
                            Record(row, "PROCESS_EXIT_CONFIRMED", null, null);
                        }
                    } catch (Exception error) { Record(row, "OPEN_PROCESS_FAILED", error, "QUERY"); }
                    continue;
                }
                if (row.creation == null) continue;
                IntPtr sync = IntPtr.Zero;
                bool syncBound = false;
                string stage = "OPEN_PROCESS_FAILED";
                string access = "SYNCHRONIZE";
                try {
                    // Separate handle: limited query is needed to bind its creation time to the first handle.
                    // Keep the old acceptance requirement: failed synchronization still blocks VERIFIED.
                    sync = OpenProcess(0x00101000, false, row.pid);
                    int syncError = sync == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
                    if (sync == IntPtr.Zero) Record(row, "OPEN_PROCESS_FAILED", new Win32Exception(syncError), "SYNCHRONIZE");
                    else {
                        stage = "CREATION_TIME_FAILED";
                        if (Birth(sync) != row.creation) {
                            Record(row, "IDENTITY_MISMATCH", null, "SYNCHRONIZE");
                            CloseHandle(sync); sync = IntPtr.Zero;
                            continue;
                        }
                        syncBound = true;
                        if (Exited(row, sync)) continue;
                    }
                    // Collect query failures even if a synchronization handle was unavailable.
                    stage = "IMAGE_QUERY_FAILED"; access = "QUERY";
                    var name = new StringBuilder(32768); uint size = (uint)name.Capacity;
                    if (!QueryFullProcessImageNameW(handle, 0, name, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    stage = "IDENTITY_RESOLUTION_FAILED";
                    row.image = Resolve(name.ToString(), false);
                    stage = "CREATION_TIME_FAILED";
                    row.verifiedCreation = Birth(handle);
                    if (row.creation != row.verifiedCreation) {
                        Record(row, "IDENTITY_MISMATCH", null, "QUERY");
                        continue;
                    }
                    if (!Exited(row, sync) && sync != IntPtr.Zero) {
                        // Require the same successful zero-time wait as before; WAIT_FAILED is never success.
                        uint state = WaitForSingleObject(sync, 0);
                        if (state == 258) row.status = "VERIFIED";
                        else if (state == 0) Exited(row, sync);
                        else Record(row, "OPEN_PROCESS_FAILED", new Win32Exception(Marshal.GetLastWin32Error()), "SYNCHRONIZE");
                    }
                } catch (Exception error) {
                    Record(row, stage, error, access);
                    if (syncBound) Exited(row, sync);
                } finally {
                    if (sync != IntPtr.Zero) CloseHandle(sync);
                }
            }
            return rows.ToArray();
        } finally {
            foreach (IntPtr handle in handles) if (handle != IntPtr.Zero) CloseHandle(handle);
        }
    }
}
'@ | Out-Null

# Keep the before/processes/after order explicit. A failed collection never emits an empty success snapshot.
$before = [AtlasReadOnlyProcessProbe]::Installation($InstallationDirectory)
$processes = @([AtlasReadOnlyProcessProbe]::Enumerate())
$after = [AtlasReadOnlyProcessProbe]::Installation($InstallationDirectory)
@{ before = $before; processes = $processes; after = $after } | ConvertTo-Json -Depth 8 -Compress
