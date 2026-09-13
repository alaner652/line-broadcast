@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
echo ===== LINE 群發（第一位先手動確認）=====
echo 第一位收件人的訊息只會貼進 LINE 輸入框、不會自動送出：
echo   請到 LINE 確認開到對的人、內容正確，按 Enter 送出後，回到這裡按 Enter 繼續。
echo.
node bin\broadcast.js --to recipients.txt --message-file message.txt --manual-first
echo.
pause
