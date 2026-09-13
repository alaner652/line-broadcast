# read-chatlist.ps1 — read the visible LINE chat list once and print JSON.
#
# Called by src/scan/windows-chatlist.js with the screen rectangle of the chat
# list panel. Tries Windows UI Automation first (exact text, if LINE exposes
# list items), then falls back to a screenshot + the Windows built-in OCR
# engine (Windows.Media.Ocr). Output is one JSON object:
#   { source: "uia"|"ocr", lang, lines: [{text,x,y,w,h}], error }
# where x/y are relative to the top-left of the captured rectangle.
param(
  [int]$X, [int]$Y, [int]$W, [int]$H,
  [string]$Shot = ''
)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public static class DpiFix { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
"@
[void][DpiFix]::SetProcessDPIAware()

$out = [ordered]@{ source = ''; lang = ''; lines = @(); error = '' }

# ---- 1. UI Automation -------------------------------------------------------
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $ae = [System.Windows.Automation.AutomationElement]
  $cond = New-Object System.Windows.Automation.PropertyCondition($ae::NameProperty, 'LINE')
  $win = $ae::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
  if ($win) {
    $icond = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)
    $items = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $icond)
    $found = @()
    foreach ($it in $items) {
      $r = $it.Current.BoundingRectangle
      $name = $it.Current.Name
      if ($name -and $r.X -ge $X -and $r.X -lt ($X + $W) -and $r.Y -ge $Y -and $r.Y -lt ($Y + $H)) {
        $found += [ordered]@{ text = $name; x = [int]($r.X - $X); y = [int]($r.Y - $Y); w = [int]$r.Width; h = [int]$r.Height }
      }
    }
    if ($found.Count -ge 3) {
      $out.source = 'uia'; $out.lines = $found
      $out | ConvertTo-Json -Depth 4 -Compress
      exit 0
    }
  }
} catch { $out.error += "uia: $($_.Exception.Message); " }

# ---- 2. Screenshot + Windows OCR -------------------------------------------
try {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  [void][Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
  function Await($op, $t) {
    $m = $asTaskGeneric.MakeGenericMethod($t)
    $task = $m.Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
  }

  $bmp = New-Object System.Drawing.Bitmap $W, $H
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($X, $Y, 0, 0, $bmp.Size)
  $g.Dispose()
  if ($Shot) { $bmp.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png) }
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $ms.Position = 0
  $ras = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $soft = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $engine = $null
  foreach ($tag in @('zh-Hant-TW', 'zh-Hant', 'zh-Hans', 'ja', 'en-US')) {
    $lang = New-Object Windows.Globalization.Language $tag
    if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($lang)) {
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
      if ($engine) { break }
    }
  }
  if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if (-not $engine) { throw '系統沒有可用的 OCR 語言（請到 設定 > 時間與語言 > 語言 安裝「中文(台灣)」並勾選 OCR）' }

  $res = Await ($engine.RecognizeAsync($soft)) ([Windows.Media.Ocr.OcrResult])
  $lines = @()
  foreach ($ln in $res.Lines) {
    $minX = [double]::MaxValue; $minY = [double]::MaxValue; $maxX = 0; $maxY = 0
    foreach ($wd in $ln.Words) {
      $r = $wd.BoundingRect
      if ($r.X -lt $minX) { $minX = $r.X }
      if ($r.Y -lt $minY) { $minY = $r.Y }
      if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
      if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
    }
    $lines += [ordered]@{ text = $ln.Text; x = [int]$minX; y = [int]$minY; w = [int]($maxX - $minX); h = [int]($maxY - $minY) }
  }
  $out.source = 'ocr'; $out.lines = $lines; $out.lang = $engine.RecognizerLanguage.LanguageTag
} catch { $out.error += "ocr: $($_.Exception.Message); " }

$out | ConvertTo-Json -Depth 4 -Compress
