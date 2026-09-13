@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
echo ===== LINE 群發 =====
echo 收件人: recipients.txt   訊息: message.txt
echo 發送期間請不要操作鍵盤滑鼠。按 Ctrl+C 可中止（會先發完目前這一位）。
echo.
node bin\broadcast.js --to recipients.txt --message-file message.txt
echo.
if errorlevel 1 (
  echo 有失敗或未完成的收件人，請看 logs\ 內的紀錄與報告。補發指令在上方。
) else (
  echo 全部發送完成。
)
pause
