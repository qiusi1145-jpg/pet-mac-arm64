#
# set-exe-icon.ps1 - Replace the icon of an .exe with the given .ico file.
# Uses only Windows built-ins (kernel32 resource APIs via PowerShell Add-Type),
# no external tools and no network. Called by build.js.
# NOTE: keep this file ASCII-only - PowerShell 5.1 parses BOM-less files as ANSI.
#
# How it works:
#   1) Parse the .ico container (ICONDIR + ICONDIRENTRYs + image payloads).
#   2) Learn the exe's existing RT_GROUP_ICON language(s) (electron.exe: 1033).
#      The shell resolves every icon id of a group IN THE GROUP'S LANGUAGE, so
#      all icon payloads are written at those same languages.
#   3) Rebuild the RT_GROUP_ICON payload. Two classic traps, both verified here:
#      - The group DATA's internal type field must be 1 (ICONDIR "icon" type),
#        NOT 14. RT_GROUP_ICON=14 is only the resource-type argument passed to
#        UpdateResource; writing 14 into the data makes SHDefExtractIcon fail
#        with ERROR_INVALID_FUNCTION for the whole file (user32's tolerant
#        lookup still works, so the bug hides until Explorer reads the icon).
#      - Icon ids referenced by the group must exist at the group's language.
#      Entries are canonical 32bpp BMP images produced by make-ico.ps1.
#
param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [Parameter(Mandatory = $true)][string]$Ico
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class IconSwap
{
    delegate bool EnumLangCb(IntPtr hModule, IntPtr lpType, IntPtr lpName, ushort wLang, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr BeginUpdateResource(string pFileName, bool bDeleteExistingResources);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateResource(IntPtr hUpdate, IntPtr lpType, IntPtr lpName, ushort wLanguage, byte[] lpData, uint cbData);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool EndUpdateResource(IntPtr hUpdate, bool fDiscard);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr LoadLibraryEx(string lpFileName, IntPtr hFile, uint dwFlags);
    [DllImport("kernel32.dll")]
    static extern bool FreeLibrary(IntPtr hLibModule);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool EnumResourceLanguages(IntPtr hModule, IntPtr lpType, IntPtr lpName, EnumLangCb cb, IntPtr lParam);

    const uint LOAD_LIBRARY_AS_DATAFILE = 0x2;
    static readonly IntPtr RT_ICON = (IntPtr)3;
    static readonly IntPtr RT_GROUP_ICON = (IntPtr)14;

    static List<ushort> LangsOf(string exe, IntPtr type, IntPtr id)
    {
        var langs = new List<ushort>();
        IntPtr h = LoadLibraryEx(exe, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE);
        if (h == IntPtr.Zero) return langs;
        try
        {
            EnumLangCb cb = delegate(IntPtr hh, IntPtr tt, IntPtr nn, ushort lang, IntPtr lp)
            { langs.Add(lang); return true; };
            EnumResourceLanguages(h, type, id, cb, IntPtr.Zero);
        }
        finally { FreeLibrary(h); }
        if (langs.Count == 0) langs.Add(0);
        return langs;
    }

    class Entry { public byte W, H, Colors; public ushort Planes, Bits; public byte[] Data; }

    public static string Replace(string exe, string icoPath)
    {
        byte[] b = System.IO.File.ReadAllBytes(icoPath);
        if (b.Length < 22) return "invalid ico (too small)";
        if (BitConverter.ToUInt16(b, 2) != 1) return "invalid ico (type)";
        int count = BitConverter.ToUInt16(b, 4);
        if (count < 1) return "invalid ico (count)";

        var icons = new List<Entry>();
        for (int i = 0; i < count; i++)
        {
            int off = 6 + 16 * i;
            uint size = BitConverter.ToUInt32(b, off + 8);
            uint dataOff = BitConverter.ToUInt32(b, off + 12);
            if (dataOff + size > (uint)b.Length) return "invalid ico (entry " + i + " out of bounds)";
            byte[] data = new byte[size];
            Array.Copy(b, (long)dataOff, data, 0, (long)size);
            icons.Add(new Entry {
                W = b[off], H = b[off + 1], Colors = b[off + 2],
                Planes = BitConverter.ToUInt16(b, off + 4),
                Bits = BitConverter.ToUInt16(b, off + 6),
                Data = data
            });
        }

        // GRPICONDIR + GRPICONDIRENTRYs (entry points at icon ID, not file offset).
        // NOTE: data type field = 1 (ICONDIR icon type). NOT 14 - 14 is the
        // RT_GROUP_ICON resource-type argument for UpdateResource, but the shell
        // requires 1 inside the data (see header comment).
        byte[] grp = new byte[6 + 14 * icons.Count];
        BitConverter.GetBytes((ushort)0).CopyTo(grp, 0);      // reserved
        BitConverter.GetBytes((ushort)1).CopyTo(grp, 2);      // type = icon (must be 1, NOT 14 - see header)
        BitConverter.GetBytes((ushort)icons.Count).CopyTo(grp, 4);
        for (int i = 0; i < icons.Count; i++)
        {
            Entry e = icons[i]; int g = 6 + 14 * i;
            grp[g] = e.W; grp[g + 1] = e.H; grp[g + 2] = e.Colors; grp[g + 3] = 0;
            BitConverter.GetBytes(e.Planes).CopyTo(grp, g + 4);
            BitConverter.GetBytes(e.Bits).CopyTo(grp, g + 6);
            BitConverter.GetBytes((uint)e.Data.Length).CopyTo(grp, g + 8);
            BitConverter.GetBytes((ushort)(i + 1)).CopyTo(grp, g + 12);
        }

        // Learn existing languages BEFORE BeginUpdateResource (the update handle locks the file).
        // The group's language governs: the shell looks up each icon id IN the group's language.
        List<ushort> groupLangs = LangsOf(exe, RT_GROUP_ICON, (IntPtr)1);
        if (groupLangs.Count == 0) groupLangs.Add(0);

        // Freshly copied exe may be briefly held by AV scan: retry BeginUpdateResource a few times.
        IntPtr h = IntPtr.Zero;
        for (int attempt = 1; attempt <= 3 && h == IntPtr.Zero; attempt++)
        {
            h = BeginUpdateResource(exe, false);
            if (h == IntPtr.Zero) System.Threading.Thread.Sleep(800 * attempt);
        }
        if (h == IntPtr.Zero)
            return "BeginUpdateResource failed, Win32 error " + Marshal.GetLastWin32Error();

        bool ok = true;
        var log = new StringBuilder();
        for (int i = 0; ok && i < icons.Count; i++)
            foreach (ushort lang in groupLangs)
            {
                ok = UpdateResource(h, RT_ICON, (IntPtr)(i + 1), lang, icons[i].Data, (uint)icons[i].Data.Length);
                log.Append("set icon " + (i + 1) + "@lang" + lang + "=" + ok + "(err " + Marshal.GetLastWin32Error() + ") ");
                if (!ok) break;
            }
        if (ok)
            foreach (ushort lang in groupLangs)
            {
                ok = UpdateResource(h, RT_GROUP_ICON, (IntPtr)1, lang, grp, (uint)grp.Length);
                log.Append("set group@lang" + lang + "=" + ok + "(err " + Marshal.GetLastWin32Error() + ") ");
                if (!ok) break;
            }
        bool committed = false;
        if (ok) committed = EndUpdateResource(h, false);
        if (!committed)
        {
            int err = Marshal.GetLastWin32Error();
            try { EndUpdateResource(h, true); } catch {}
            return "UpdateResource failed, Win32 error " + err + " | " + log;
        }
        return "OK";
    }
}
'@

if (-not (Test-Path -LiteralPath $Exe)) { throw "exe not found: $Exe" }
if (-not (Test-Path -LiteralPath $Ico)) { throw "ico not found: $Ico" }
$result = [IconSwap]::Replace($Exe, $Ico)
if ($result -ne 'OK') { throw $result }
Write-Output 'OK'
