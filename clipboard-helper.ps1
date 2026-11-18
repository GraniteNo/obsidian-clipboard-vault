param(
    [switch] $Once,
    [switch] $Write,
    [int] $ParentPid = 0,
    [int] $IntervalMs = 1000
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$archiveCopyFormat = 'ClipboardVault.Copy'

function Send-Message([object] $Value) {
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 4))
    [Console]::Out.Flush()
}

function Write-ArchiveCopy([object] $Payload) {
    $data = New-Object System.Windows.Forms.DataObject
    $data.SetData($archiveCopyFormat, $false, '1')
    if ($Payload.text -is [string]) {
        $data.SetText($Payload.text, [System.Windows.Forms.TextDataFormat]::UnicodeText)
        [System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 5, 100)
        return
    }
    if ($Payload.png -isnot [string]) { throw 'Invalid clipboard payload' }
    $bytes = [Convert]::FromBase64String($Payload.png)
    $stream = [System.IO.MemoryStream]::new($bytes)
    try {
        $picture = [System.Drawing.Image]::FromStream($stream)
        try {
            $bitmap = [System.Drawing.Bitmap]::new($picture)
            try {
                $data.SetImage($bitmap)
                [System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 5, 100)
            } finally { $bitmap.Dispose() }
        } finally { $picture.Dispose() }
    } finally { $stream.Dispose() }
}

function Read-ClipboardSnapshot([switch] $IgnoreArchiveCopy) {
    $clipboard = [System.Windows.Forms.Clipboard]
    if ($IgnoreArchiveCopy -and $clipboard::ContainsData($archiveCopyFormat)) { return @{ kind = 'empty' } }
    if ($clipboard::ContainsFileDropList()) {
        $paths = @($clipboard::GetFileDropList() | ForEach-Object { [string] $_ })
        if ($paths.Count -gt 0) { return @{ kind = 'files'; paths = $paths } }
    }
    if ($clipboard::ContainsImage()) {
        $picture = $clipboard::GetImage()
        if ($null -ne $picture) {
            try {
                $stream = New-Object System.IO.MemoryStream
                try {
                    $picture.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
                    if ($stream.Length -le 20971520) {
                        return @{ kind = 'image'; png = [Convert]::ToBase64String($stream.ToArray()) }
                    }
                    return @{ kind = 'oversize-image' }
                } finally { $stream.Dispose() }
            } finally { $picture.Dispose() }
        }
    }
    if ($clipboard::ContainsText()) {
        $value = $clipboard::GetText()
        if (-not [string]::IsNullOrWhiteSpace($value)) { return @{ kind = 'text'; text = $value } }
    }
    return @{ kind = 'empty' }
}

if ($Write) {
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
    Write-ArchiveCopy ([Console]::In.ReadLine() | ConvertFrom-Json)
    exit 0
}

if ($Once) {
    Send-Message (Read-ClipboardSnapshot)
    exit 0
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ClipboardSequence {
    [DllImport("user32.dll")]
    public static extern uint GetClipboardSequenceNumber();
}
'@

$available = $false
for ($attempt = 0; $attempt -lt 3; $attempt++) {
    try { [void] (Read-ClipboardSnapshot); $available = $true; break }
    catch { Start-Sleep -Milliseconds 200 }
}
if (-not $available) { [Console]::Error.WriteLine('Clipboard API unavailable'); exit 1 }

$previous = [ClipboardSequence]::GetClipboardSequenceNumber()
$failures = 0
Send-Message @{ kind = 'ready' }
while ($true) {
    if ($ParentPid -gt 0) {
        try { [void] [System.Diagnostics.Process]::GetProcessById($ParentPid) }
        catch { break }
    }
    Start-Sleep -Milliseconds $IntervalMs
    $current = [ClipboardSequence]::GetClipboardSequenceNumber()
    if ($current -eq $previous) { continue }
    try {
        Send-Message (Read-ClipboardSnapshot -IgnoreArchiveCopy)
        $previous = $current
        $failures = 0
    } catch {
        # Another application can hold the clipboard briefly; retry this sequence.
        $failures++
        if ($failures -ge 5) { [Console]::Error.WriteLine('Clipboard API unavailable'); exit 2 }
        Start-Sleep -Milliseconds 100
    }
}
