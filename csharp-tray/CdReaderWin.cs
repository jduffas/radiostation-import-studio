using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace RadioStationImportStudio;

// Lecture audio CD bas niveau via IOCTL Win32 bruts (ntddcdrm.h) — aucun build ffmpeg-static
// (toutes plateformes confondues, vérifié directement sur le binaire embarqué) ne supporte le
// protocole cdda://, contrairement à ce que supposait l'ancien code (ffmpeg cdda:// utilisé
// aveuglément sur Windows). Ce fichier est la seule voie possible côté Windows.
//
// Invoqué en ligne de commande headless par main.js (spawn de ce même exe, mêmes arguments
// qu'un binaire externe type cdparanoia sur Linux — cf. main.js#CD_READER_WIN) :
//   RadioStationImportStudio.exe --cd-toc <lecteur>                  → JSON TOC sur stdout
//   RadioStationImportStudio.exe --cd-rip <lecteur> <piste> <sortie> → écrit un WAV PCM 16/44100/stéréo
//
// ⚠️ Jamais testé sur une vraie machine Windows avec lecteur CD à l'écriture de ce fichier —
// IOCTL_CDROM_RAW_READ peut se comporter différemment selon le pilote du lecteur (certains
// exigent un multiple précis de secteurs par appel, ou refusent TrackMode CDDA). En cas
// d'échec, le message d'erreur (stderr + code Win32) doit remonter tel quel jusqu'à
// l'utilisateur pour diagnostiquer sans accès à la machine.
internal static class CdReaderWin
{
    private const uint GENERIC_READ = 0x80000000;
    private const uint FILE_SHARE_READ = 0x1;
    private const uint FILE_SHARE_WRITE = 0x2;
    private const uint OPEN_EXISTING = 3;

    // ntddcdrm.h — stables depuis Windows 2000, utilisés par la plupart des graveurs/ripeurs
    // (cdrdao, ImgBurn, InfraRecorder...).
    private const uint IOCTL_CDROM_READ_TOC = 0x00024000;
    private const uint IOCTL_CDROM_RAW_READ = 0x0002403E;

    private const int RAW_SECTOR_SIZE = 2352; // secteur CD-DA brut (pas de correction d'erreur)
    private const int MAX_TRACKS = 100;       // 99 pistes + lead-out (spec Red Book)
    private const int BATCH_SECTORS = 32;     // ~75 Ko par appel DeviceIoControl

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    private static extern IntPtr CreateFile(
        string lpFileName, uint dwDesiredAccess, uint dwShareMode,
        IntPtr lpSecurityAttributes, uint dwCreationDisposition,
        uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DeviceIoControl(
        IntPtr hDevice, uint dwIoControlCode,
        byte[]? lpInBuffer, uint nInBufferSize,
        byte[] lpOutBuffer, uint nOutBufferSize,
        out uint lpBytesReturned, IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    private sealed record TrackEntry(int Number, int LbaStart);

    private static IntPtr OpenDrive(string drive)
    {
        // "D:" -> "\\.\D:" — chemin de périphérique brut requis par DeviceIoControl.
        var letter = drive.TrimEnd('\\').TrimEnd(':');
        var devicePath = $@"\\.\{letter}:";
        var handle = CreateFile(devicePath, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
            IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        if (handle == IntPtr.Zero || handle.ToInt64() == -1)
            throw new IOException($"Impossible d'ouvrir le lecteur {drive} (erreur Win32 {Marshal.GetLastWin32Error()})");
        return handle;
    }

    private static List<TrackEntry> ReadToc(IntPtr handle, out int leadoutLba)
    {
        // CDROM_TOC : Length[2] + FirstTrack + LastTrack + jusqu'à 100 * TRACK_DATA(8 octets).
        var buf = new byte[4 + MAX_TRACKS * 8];
        if (!DeviceIoControl(handle, IOCTL_CDROM_READ_TOC, null, 0, buf, (uint)buf.Length, out _, IntPtr.Zero))
            throw new IOException($"Échec lecture TOC (erreur Win32 {Marshal.GetLastWin32Error()})");

        int firstTrack = buf[2];
        int lastTrack = buf[3];
        var tracks = new List<TrackEntry>();
        leadoutLba = 0;

        // TRACK_DATA débute à l'offset 4, 8 octets chacun :
        // [0]=Reserved, [1]=Control/Adr, [2]=TrackNumber, [3]=Reserved1, [4..7]=Address (MSF : 0,Min,Sec,Frame).
        // La piste "lead-out" (fin du disque) porte le numéro spécial 0xAA (170).
        int entries = lastTrack - firstTrack + 2; // pistes + lead-out
        for (int i = 0; i < entries && i < MAX_TRACKS; i++)
        {
            int off = 4 + i * 8;
            if (off + 8 > buf.Length) break;
            int trackNum = buf[off + 2];
            int min = buf[off + 5], sec = buf[off + 6], frame = buf[off + 7];
            int lba = (min * 60 + sec) * 75 + frame - 150; // MSF -> LBA (offset standard Red Book -150)
            if (trackNum == 0xAA) { leadoutLba = lba; break; }
            tracks.Add(new TrackEntry(trackNum, lba));
        }
        return tracks;
    }

    public static int RunToc(string drive)
    {
        IntPtr handle;
        try { handle = OpenDrive(drive); }
        catch (Exception e) { Console.Error.Write(e.Message); return 1; }

        try
        {
            var tracks = ReadToc(handle, out var leadoutLba);
            var json = JsonSerializer.Serialize(new
            {
                tracks = tracks.Select(t => new { number = t.Number, offset = t.LbaStart }),
                leadout = leadoutLba,
            });
            Console.Out.Write(json);
            return 0;
        }
        catch (Exception e)
        {
            Console.Error.Write(e.Message);
            return 1;
        }
        finally { CloseHandle(handle); }
    }

    public static int RunRip(string drive, int trackNum, string outPath)
    {
        IntPtr handle;
        try { handle = OpenDrive(drive); }
        catch (Exception e) { Console.Error.Write(e.Message); return 1; }

        try
        {
            var tracks = ReadToc(handle, out var leadoutLba);
            var idx = tracks.FindIndex(t => t.Number == trackNum);
            if (idx < 0) throw new IOException($"Piste {trackNum} introuvable au TOC ({tracks.Count} piste(s) détectée(s))");

            int startLba = tracks[idx].LbaStart;
            int nextLba = idx + 1 < tracks.Count ? tracks[idx + 1].LbaStart : leadoutLba;
            int sectorCount = nextLba - startLba;
            if (sectorCount <= 0) throw new IOException($"Piste {trackNum} : plage de secteurs invalide ({startLba}..{nextLba})");

            using (var outStream = new FileStream(outPath, FileMode.Create, FileAccess.Write))
            {
                WriteWavHeader(outStream, sectorCount * RAW_SECTOR_SIZE);
                for (int start = startLba; start < nextLba; start += BATCH_SECTORS)
                {
                    int count = Math.Min(BATCH_SECTORS, nextLba - start);
                    var data = ReadRawSectors(handle, start, count);
                    outStream.Write(data, 0, data.Length);
                }
            }
            return 0;
        }
        catch (Exception e)
        {
            Console.Error.Write(e.Message);
            try { File.Delete(outPath); } catch { /* best-effort */ }
            return 1;
        }
        finally { CloseHandle(handle); }
    }

    private static byte[] ReadRawSectors(IntPtr handle, int startLba, int count)
    {
        // RAW_READ_INFO : DiskOffset (LARGE_INTEGER, 8 octets — LBA * 2048, convention Win32
        // même si les secteurs lus font réellement 2352 octets) + SectorCount (4) +
        // TrackMode (4, énum TRACK_MODE_TYPE : 2 = CDDA).
        var inBuf = new byte[16];
        BitConverter.GetBytes((long)startLba * 2048).CopyTo(inBuf, 0);
        BitConverter.GetBytes(count).CopyTo(inBuf, 8);
        BitConverter.GetBytes(2).CopyTo(inBuf, 12); // TRACK_MODE_TYPE.CDDA

        var outBuf = new byte[count * RAW_SECTOR_SIZE];
        if (!DeviceIoControl(handle, IOCTL_CDROM_RAW_READ, inBuf, (uint)inBuf.Length,
                outBuf, (uint)outBuf.Length, out var returned, IntPtr.Zero))
            throw new IOException($"Échec lecture secteurs {startLba}..{startLba + count} (erreur Win32 {Marshal.GetLastWin32Error()})");
        if (returned != outBuf.Length)
            throw new IOException($"Lecture partielle secteurs {startLba} ({returned}/{outBuf.Length} octets reçus)");
        return outBuf;
    }

    private static void WriteWavHeader(Stream s, int dataBytes)
    {
        // PCM 16 bits, stéréo, 44100 Hz — format natif de l'audio CD (Red Book).
        void W(string tag) => s.Write(Encoding.ASCII.GetBytes(tag));
        void W32(int v) => s.Write(BitConverter.GetBytes(v));
        void W16(short v) => s.Write(BitConverter.GetBytes(v));

        W("RIFF"); W32(36 + dataBytes); W("WAVE");
        W("fmt "); W32(16); W16(1); W16(2); W32(44100); W32(44100 * 4); W16(4); W16(16);
        W("data"); W32(dataBytes);
    }
}
