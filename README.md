# line-broadcast — LINE 一對一群發小工具

把同一則通知（颱風休館、課程異動、活動提醒）逐一發給多位 LINE 好友，
每位間隔幾秒模擬人手，附每位結果報告、一鍵補發、完整 log。

裝在有登入 LINE 桌面版的 Windows / macOS 電腦上，操作者只要維護兩個記事本檔：

```
recipients.txt   ← 一行一個客戶的 LINE 名稱
message.txt      ← 要發的內容
```

然後雙擊 `windows\群發.cmd`。

> **這不是 LINE 官方功能。** 它是用 GUI 自動化操作你自己的 LINE 桌面版（Windows 用 AutoHotkey，
> macOS 用 Accessibility），沒有碰 LINE 伺服器、不需要帳號密碼。但用個人帳號做自動化違反
> LINE 使用條款，帳號有被限制的風險——請只發客戶預期會收到的服務通知、保持預設間隔、單日不要超過 100 人。
> 詳見 [docs/BUSINESS_PLAN.md](docs/BUSINESS_PLAN.md) 的風險段。

---

## Windows 安裝（給業務 / 店家）

1. 下載或 clone 這個資料夾到電腦上（例如 `C:\line-broadcast`）
2. 在資料夾裡對 `windows\install.ps1` 按右鍵 →「使用 PowerShell 執行」
   會自動安裝 Node.js、AutoHotkey v2（透過 winget），並建立 `recipients.txt`、`message.txt` 範本
3. 用記事本編輯 `recipients.txt` 和 `message.txt`
4. 打開 LINE 桌面版並登入，視窗不要最小化
5. 雙擊：
   - `windows\預覽.cmd` — 只列出會發給誰、發什麼，不會發送
   - `windows\群發-先確認第一位.cmd` — **新名單第一次請用這個**：第一位只貼進輸入框不送出，
     你到 LINE 看開的是不是對的人、內容對不對，按 Enter 送出後回來按 Enter 繼續
   - `windows\群發.cmd` — 全自動

發送期間不要碰鍵盤滑鼠。按 Ctrl+C 會發完目前這一位後停下。

## macOS（開發 / 測試用）

```bash
npm install
node bin/broadcast.js --to recipients.txt --check                      # 對照 LINE 列表，名字找不找得到（不發送）
node bin/broadcast.js --to recipients.txt --message-file message.txt --dry-run
node bin/broadcast.js --to recipients.txt --message-file message.txt --manual-first
```

需要「輔助使用」權限給終端機，以及 `brew install cliclick`。

## 檔案格式

**recipients.txt**
```
# 開頭 # 是註解；名字要跟 LINE 左側列表顯示的一字不差；重複只發一次
王小明
🐻小熊 => 李美麗        # 客戶暱稱很怪時，用 => 指定稱呼，訊息裡的 {name} 會用「李美麗」
```

**message.txt**（可多行；`{name}` 會換成稱呼）
```
{name} 您好，
因颱風影響，本館今日休館一天，明日視天候狀況公告。
```

## 名字對不上怎麼辦

這是最常見的失敗，先講清楚機制：

| 平台 | 怎麼找人 | 找不到會怎樣 |
|---|---|---|
| Windows | 打開 LINE 搜尋框（Ctrl+Shift+F）→ 貼上名字 → Enter → 點第一筆 | **搜尋沒結果時，LINE 仍停在原本開著的聊天室，訊息會貼到那裡。** 這是目前最大的風險。 |
| macOS | 讀側欄每一列的文字比對，點開後再讀聊天室標題驗證 | 找不到 / 標題不符 → 該位標記失敗、跳過，不會誤發 |

對策，由便宜到麻煩：

1. **在 LINE 裡改顯示名稱。** 對每位客戶「更改顯示名稱」成一致好認的格式（例如 `客戶-王小明`），
   emoji、空白、長名字截斷問題全部消失，而且搜尋一定唯一。這是根本解，一次做完就好。
2. **發送前先 `--check`**（macOS）：不打字不發送，逐一對照列表，把找不到的名字列出來。
3. **新名單一律 `--manual-first`**：第一位人眼確認，等於免費驗證這台電腦的搜尋流程沒問題。
4. **名字要唯一。** 「小明」會同時對到「王小明」「陳小明」；用全名或加前綴。
5. **失敗的不用重跑全部。** 每次都有 `logs/broadcast-report-*.json`，加 `--resume 那個檔` 只補發失敗的；
   剩下兩三位手動發也比 50 位手動發快得多。

工具**不用 OCR 找人**（讀取聊天列表靠 LINE 搜尋 / Accessibility 文字），所以沒有「辨識不出中文」的問題；
問題永遠是「名字打得跟 LINE 上顯示的不一樣」。

## 選項一覽

```
node bin/broadcast.js --help
```

## 紀錄

- `logs/broadcast-YYYY-MM-DD.log` — 每個事件（誰、幾點、成功 / 失敗原因）
- `logs/broadcast-report-YYYYMMDD-HHMMSS.json` — 每位收件人狀態，每發完一位就寫入，斷電也能補發

## 已知限制 / 待辦

- Windows 端還沒實機測過（開發在 macOS）；第一次部署要有人在旁邊
- Windows 無法確認開到的聊天室是否正確（見上表）；未來可加截圖 + Windows 內建 OCR 讀聊天室標題做驗證
- LINE 桌面版改版可能讓座標 / 快捷鍵失效，需要跟著修
- 尚未包成單一 exe

## 授權

MIT。發送自動化的核心來自 [dtwang/line-desktop-mcp](https://github.com/dtwang/line-desktop-mcp)（Geoffrey Wang, MIT）
以及 Sung Yeh 的 AX-first fork；本專案拿掉 MCP 伺服器與讀訊息 / OCR 功能，只保留群發需要的部分。
