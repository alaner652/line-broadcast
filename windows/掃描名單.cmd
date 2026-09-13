@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
echo ===== 掃描 LINE 聊天室名單，產生 recipients.draft.txt =====
echo 請先打開 LINE、切到聊天分頁，視窗不要被遮住。掃描期間不要碰鍵盤滑鼠。
echo.
node bin\scan-chats.js
echo.
pause
