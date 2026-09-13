# install.ps1 — one-shot setup for the LINE broadcast tool on a Windows PC.
#
# Installs what the send path needs (Node.js LTS, AutoHotkey v2) via winget if
# missing, installs npm dependencies, and drops editable recipients.txt /
# message.txt next to the launcher. Safe to re-run.
#
# Run from an elevated or normal PowerShell:
#   Set-ExecutionPolicy -Scope Process Bypass; .\windows\install.ps1
# or right-click -> "Run with PowerShell".

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

function Has-Cmd($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

function Refresh-Path {
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [System.Environment]::GetEnvironmentVariable('Path', 'User')
}

Step "檢查 winget"
if (-not (Has-Cmd winget)) {
  Write-Host "找不到 winget。請先從 Microsoft Store 安裝「應用程式安裝程式 (App Installer)」，或手動安裝：" -ForegroundColor Red
  Write-Host "  Node.js LTS   https://nodejs.org/"
  Write-Host "  AutoHotkey v2 https://www.autohotkey.com/"
  exit 1
}
Ok "winget 可用"

Step "檢查 Node.js"
if (-not (Has-Cmd node)) {
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  Refresh-Path
}
if (-not (Has-Cmd node)) { Write-Host "Node.js 安裝後仍找不到，請關閉並重新開啟 PowerShell 再執行一次。" -ForegroundColor Red; exit 1 }
Ok ("Node.js " + (node --version))

Step "檢查 AutoHotkey v2"
$ahk = @(
  "$env:ProgramFiles\AutoHotkey\v2\AutoHotkey64.exe",
  "$env:ProgramFiles\AutoHotkey\v2\AutoHotkey32.exe",
  "$env:LOCALAPPDATA\Programs\AutoHotkey\v2\AutoHotkey64.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $ahk) {
  winget install --id AutoHotkey.AutoHotkey -e --accept-source-agreements --accept-package-agreements
  $ahk = @(
    "$env:ProgramFiles\AutoHotkey\v2\AutoHotkey64.exe",
    "$env:ProgramFiles\AutoHotkey\v2\AutoHotkey32.exe",
    "$env:LOCALAPPDATA\Programs\AutoHotkey\v2\AutoHotkey64.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if ($ahk) { Ok "AutoHotkey: $ahk" } else { Warn "找不到 AutoHotkey v2 執行檔；若已安裝在非預設位置，請設定環境變數 AHK_PATH。" }

Step "安裝 npm 套件"
npm install --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Write-Host "npm install 失敗" -ForegroundColor Red; exit 1 }
Ok "完成"

Step "建立收件人 / 訊息範本"
if (-not (Test-Path "$Root\recipients.txt")) {
  Copy-Item "$Root\examples\recipients.example.txt" "$Root\recipients.txt"
  Ok "已建立 recipients.txt（請改成真實客戶的 LINE 名稱）"
} else { Ok "recipients.txt 已存在，不覆蓋" }
if (-not (Test-Path "$Root\message.txt")) {
  Copy-Item "$Root\examples\message.example.txt" "$Root\message.txt"
  Ok "已建立 message.txt（請改成要發送的內容）"
} else { Ok "message.txt 已存在，不覆蓋" }
New-Item -ItemType Directory -Force -Path "$Root\logs" | Out-Null

Step "驗證"
node bin\broadcast.js --to recipients.txt --message-file message.txt --dry-run
if ($LASTEXITCODE -ne 0) { Write-Host "dry-run 失敗，請看上方訊息。" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "安裝完成。使用方式：" -ForegroundColor Green
Write-Host "  1. 用記事本編輯 recipients.txt（一行一個 LINE 名稱，要跟 LINE 列表顯示的一字不差）"
Write-Host "  2. 用記事本編輯 message.txt（要發的內容）"
Write-Host "  3. 打開並登入 LINE 桌面版，視窗不要最小化"
Write-Host "  4. 雙擊 windows\群發.cmd（第一次建議用 windows\群發-先確認第一位.cmd）"
Write-Host "  紀錄在 logs\ 資料夾。"
