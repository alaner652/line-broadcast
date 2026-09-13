@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
echo ===== 預覽（不會發送）=====
node bin\broadcast.js --to recipients.txt --message-file message.txt --dry-run
pause
