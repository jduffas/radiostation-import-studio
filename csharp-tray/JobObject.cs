using System;
using System.Runtime.InteropServices;

namespace RadioStationImportStudio;

// Rattache node.exe (process enfant) à un Job Object Windows configuré en
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE : quand le handle du job se ferme — ce qui arrive
// automatiquement quand CE process (le tray) se termine, pour N'IMPORTE QUELLE raison
// (Quit() normal, crash, ou un `taskkill /f` externe comme celui d'installer.nsi) — Windows tue
// lui-même tous les process encore rattachés. Corrige un vrai bug observé : le watchdog
// anti-crash de StartNodeServer relançait node.exe même après un Quit() volontaire (fix
// séparé, flag _quitting), et un `taskkill /f` externe sur le tray ne laissait de toute façon
// aucune chance au code C# de tuer proprement l'enfant — dans les deux cas node.exe restait
// verrouillé, empêchant la réinstallation de l'écraser.
internal static class JobObject
{
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    private const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string? lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr hJob, int jobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    private static IntPtr _jobHandle = IntPtr.Zero;

    // Le job lui-même n'a besoin d'être créé qu'une fois — son handle vit tant que ce process
    // vit (fermé automatiquement par l'OS à la terminaison, quelle qu'en soit la cause).
    private static IntPtr EnsureJob()
    {
        if (_jobHandle != IntPtr.Zero) return _jobHandle;

        var handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) return IntPtr.Zero;

        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            BasicLimitInformation = new JOBOBJECT_BASIC_LIMIT_INFORMATION
            {
                LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        };

        int length = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
        var infoPtr = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(info, infoPtr, false);
            if (!SetInformationJobObject(handle, JobObjectExtendedLimitInformation, infoPtr, (uint)length))
                return IntPtr.Zero; // configuration échouée — mieux vaut ne pas assigner un job inerte
        }
        finally { Marshal.FreeHGlobal(infoPtr); }

        _jobHandle = handle;
        return _jobHandle;
    }

    // Best-effort : si ça échoue (permissions, OS ancien...), l'app continue de fonctionner
    // normalement, seul le filet de sécurité anti-orphelin est absent.
    public static void Attach(IntPtr processHandle)
    {
        var job = EnsureJob();
        if (job != IntPtr.Zero) AssignProcessToJobObject(job, processHandle);
    }
}
