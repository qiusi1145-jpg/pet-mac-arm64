#
# make-ico.ps1 - Render the source PNG into a proper multi-size .ico file.
# Uses only Windows built-ins (GDI+ via .NET System.Drawing), no dependencies.
# Called by build.js:  make-ico.ps1 -Png <src.png> -Ico <out.ico>
# NOTE: keep this file ASCII-only - PowerShell 5.1 parses BOM-less files as ANSI.
#
# Why hand-built BMP entries instead of [System.Drawing.Icon]::Save():
# Icon.Save() on GetHicon/FromHandle icons emits palette-converted payloads that
# loaders choke on (observed: PrivateExtractIcons returns 0 for such exes and the
# shell falls back to the generic exe icon). Entries below are written by hand in
# the canonical 32bpp BGRA BMP form (BITMAPINFOHEADER with biHeight=2*h, bottom-up
# XOR rows, empty AND mask), which every Windows icon loader accepts.
#
param(
    [Parameter(Mandatory = $true)][string]$Png,
    [Parameter(Mandatory = $true)][string]$Ico
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $Png)) { throw "source png not found: $Png" }

$src = [System.Drawing.Image]::FromFile($Png)
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$entries = New-Object System.Collections.Generic.List[byte[]]
$payloads = New-Object System.Collections.Generic.List[byte[]]

try {
    foreach ($s in $sizes) {
        $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        try {
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            try {
                $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
                $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
                $g.Clear([System.Drawing.Color]::Transparent)
                $g.DrawImage($src, 0, 0, $s, $s)
            }
            finally { $g.Dispose() }

            # BGRA rows, bottom-up (BMP scanline order), straight alpha
            $rect = New-Object System.Drawing.Rectangle(0, 0, $s, $s)
            $bits = $bmp.LockBits($rect,
                [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
                [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
            try {
                $stride = $bits.Stride   # == 4*s for 32bpp
                $row = New-Object byte[] $stride
                $xor = New-Object byte[] (4 * $s * $s)
                for ($y = 0; $y -lt $s; $y++) {
                    $ptr = [IntPtr]::Add($bits.Scan0, $y * $stride)
                    [System.Runtime.InteropServices.Marshal]::Copy($ptr, $row, 0, $stride)
                    [Array]::Copy($row, 0, $xor, ($s - 1 - $y) * 4 * $s, 4 * $s)
                }
            }
            finally { $bmp.UnlockBits($bits) }

            # AND mask (1bpp, bottom-up, rows padded to 32 bits) - all transparent,
            # alpha channel is what matters for 32bpp entries.
            $maskStride = ((($s + 31) -shr 5) -shl 2)
            $mask = New-Object byte[] ($maskStride * $s)

            # BITMAPINFOHEADER (biHeight = 2*h per ICO spec)
            $hdr = New-Object byte[] 40
            [BitConverter]::GetBytes([uint32]40).CopyTo($hdr, 0)
            [BitConverter]::GetBytes([int32]$s).CopyTo($hdr, 4)
            [BitConverter]::GetBytes([int32]($s * 2)).CopyTo($hdr, 8)
            [BitConverter]::GetBytes([uint16]1).CopyTo($hdr, 12)
            [BitConverter]::GetBytes([uint16]32).CopyTo($hdr, 14)
            [BitConverter]::GetBytes([uint32]($xor.Length + $mask.Length)).CopyTo($hdr, 20)

            $payload = New-Object byte[] (40 + $xor.Length + $mask.Length)
            [Array]::Copy($hdr, 0, $payload, 0, 40)
            [Array]::Copy($xor, 0, $payload, 40, $xor.Length)
            [Array]::Copy($mask, 0, $payload, 40 + $xor.Length, $mask.Length)
            $payloads.Add($payload)

            # ICONDIRENTRY
            $e = New-Object byte[] 16
            $e[0] = [byte]($s -band 0xFF)   # 0 means 256, and 256 -band 0xFF == 0 anyway
            $e[1] = $e[0]
            $e[2] = 0                        # colors in palette
            $e[3] = 0                        # reserved
            [BitConverter]::GetBytes([uint16]1).CopyTo($e, 4)   # planes
            [BitConverter]::GetBytes([uint16]32).CopyTo($e, 6)  # bits per pixel
            [BitConverter]::GetBytes([uint32]$payload.Length).CopyTo($e, 8)
            $entries.Add($e)
        }
        finally { $bmp.Dispose() }
    }
}
finally { $src.Dispose() }

# Assemble: ICONDIR + ICONDIRENTRYs + payloads
$total = 6 + 16 * $entries.Count
foreach ($p in $payloads) { $total += $p.Length }
$out = New-Object byte[] $total
[BitConverter]::GetBytes([uint16]0).CopyTo($out, 0)     # reserved
[BitConverter]::GetBytes([uint16]1).CopyTo($out, 2)     # type = icon
[BitConverter]::GetBytes([uint16]$entries.Count).CopyTo($out, 4)
$offset = 6 + 16 * $entries.Count
for ($i = 0; $i -lt $entries.Count; $i++) {
    [Array]::Copy($entries[$i], 0, $out, 6 + 16 * $i, 16)
    [BitConverter]::GetBytes([uint32]$offset).CopyTo($out, 6 + 16 * $i + 12)
    $offset += $payloads[$i].Length
}
$pos = 6 + 16 * $entries.Count
for ($i = 0; $i -lt $payloads.Count; $i++) {
    [Array]::Copy($payloads[$i], 0, $out, $pos, $payloads[$i].Length)
    $pos += $payloads[$i].Length
}
[System.IO.File]::WriteAllBytes($Ico, $out)
Write-Output ('OK ' + $total + ' bytes')
