#!/usr/bin/env node
// broadcast.js — send one message to many LINE chats, one at a time, with a
// per-recipient report and resume support.
//
// Why a loop over 1:1 sends instead of LINE's own multi-forward: the desktop
// forward dialog caps the recipient count per action, and every batch needs a
// human to re-pick names. This drives the platform send path per recipient so
// an operator only has to maintain two text files (recipients + message) and
// double-click one launcher.
//
// Usage:
//   node bin/broadcast.js --to recipients.txt --message-file message.txt [options]
//   node bin/broadcast.js --to recipients.txt --message "今日颱風休館一天" [options]
//
//   --to <file>            one chat name per line; blank lines and lines starting
//                          with # are ignored; duplicates are sent once.
//                          "LINE名稱 => 稱呼" sets what {name} renders to, so a
//                          customer whose LINE nickname is "🐻小熊" can still be
//                          greeted as "王小明".
//   --message <text>       message text (use \n for newline), or
//   --message-file <file>  message text from a UTF-8 file (multi-line ok).
//                          {name} in the message is replaced by the label.
//   --delay <min-max>      seconds to wait between recipients, random in range
//                          (default 6-12). Do not go much lower: rapid identical
//                          messages are what LINE's spam filter looks for.
//   --dry-run              print the plan (recipients + rendered message), send nothing.
//   --yes                  skip the confirmation prompt.
//   --manual-first         first recipient is sent in manual mode (message pasted,
//                          Enter NOT pressed) so the operator can check the right
//                          chat opened; the loop resumes after they press Enter here.
//                          Strongly recommended on a machine's first run.
//   --resume <report.json> skip recipients already marked "sent" in a previous report.
//   --max-failures <n>     stop the whole run after n consecutive failures (default 3),
//                          since that usually means LINE lost its window, not one bad name.
//   -h, --help
//
// Output:
//   logs/broadcast-YYYY-MM-DD.log             every event, appended
//   logs/broadcast-report-YYYYMMDD-HHMMSS.json per-recipient status (for --resume)

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { LineAutomation } from '../src/automation/index.js';
import { createLogger, fileTag, LOG_DIR } from '../src/logger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- args ----

function parseArgs(argv) {
  const cfg = {
    to: null,
    message: null,
    messageFile: null,
    delayMin: 6,
    delayMax: 12,
    dryRun: false,
    yes: false,
    manualFirst: false,
    resume: null,
    maxFailures: 3,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`參數 ${a} 需要一個值`);
      return v;
    };
    if (a === '--to') cfg.to = next();
    else if (a === '--message') cfg.message = next().replace(/\\n/g, '\n');
    else if (a === '--message-file') cfg.messageFile = next();
    else if (a === '--delay') {
      const m = next().match(/^(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?$/);
      if (!m) throw new Error('--delay 格式須為 <秒> 或 <最小秒>-<最大秒>，例如 6-12');
      cfg.delayMin = parseFloat(m[1]);
      cfg.delayMax = m[2] ? parseFloat(m[2]) : cfg.delayMin;
      if (cfg.delayMax < cfg.delayMin) [cfg.delayMin, cfg.delayMax] = [cfg.delayMax, cfg.delayMin];
    } else if (a === '--dry-run') cfg.dryRun = true;
    else if (a === '--yes' || a === '-y') cfg.yes = true;
    else if (a === '--manual-first') cfg.manualFirst = true;
    else if (a === '--resume') cfg.resume = next();
    else if (a === '--max-failures') cfg.maxFailures = parseInt(next(), 10);
    else if (a === '-h' || a === '--help') cfg.help = true;
    else throw new Error(`不認得的參數：${a}（用 --help 看用法）`);
  }
  if (!Number.isFinite(cfg.maxFailures) || cfg.maxFailures < 1) cfg.maxFailures = 3;
  return cfg;
}

const HELP = `LINE 群發（逐一發送到多個聊天室）

用法:
  node bin/broadcast.js --to recipients.txt --message-file message.txt [選項]
  node bin/broadcast.js --to recipients.txt --message "今日颱風休館" [選項]

選項:
  --to <檔案>            收件人清單，一行一個 LINE 聊天室名稱（# 開頭為註解，重複只發一次）
                         可寫「LINE名稱 => 稱呼」，{name} 會用「稱呼」而不是 LINE 名稱
  --message <文字>       訊息內容（\\n 代表換行）
  --message-file <檔案>  從 UTF-8 檔案讀訊息（可多行）；{name} 會換成稱呼
  --delay <最小-最大>     每位之間隨機等待秒數（預設 6-12；太快容易被 LINE 判定為垃圾訊息）
  --dry-run              只列出計畫，不發送
  --yes, -y              不詢問直接開始
  --manual-first         第一位用「手動模式」：貼好訊息但不按 Enter，讓你確認開到對的人，
                         在 LINE 按送出後回到這裡按 Enter 繼續（新機器第一次強烈建議）
  --resume <報告.json>   略過上次報告中已標記 sent 的收件人
  --max-failures <n>     連續失敗 n 位就整批停止（預設 3）
  -h, --help

輸出:
  logs/broadcast-YYYY-MM-DD.log              所有事件
  logs/broadcast-report-YYYYMMDD-HHMMSS.json 每位收件人狀態（可供 --resume）
`;

// ------------------------------------------------------------- helpers ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randBetween = (a, b) => a + Math.random() * (b - a);
const stripBom = (s) => s.replace(/^\uFEFF/, '');

/**
 * Read a text file the way an operator's editor might have saved it: UTF-8
 * (with or without BOM) or UTF-16 LE/BE (Windows Notepad's "Unicode" option).
 */
function readText(file) {
  const buf = fs.readFileSync(file);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return buf.subarray(2).swap16().toString('utf16le');
  return stripBom(buf.toString('utf8'));
}

/**
 * Find an operator input file, tolerating the two ways it usually goes missing
 * on a fresh Windows machine:
 *  - the repo ships only examples/ (real names are git-ignored), so on first
 *    run the file does not exist yet → create it from the example and tell
 *    the operator to fill it in;
 *  - Notepad hides extensions, so "recipients.txt" was saved as
 *    "recipients.txt.txt" → use that one and say so.
 * @returns {{path:string, created:boolean, note?:string}}
 */
function locateInput(rel, exampleRel) {
  const abs = path.resolve(ROOT, rel);
  if (fs.existsSync(abs)) return { path: abs, created: false };
  const doubled = abs + '.txt';
  if (fs.existsSync(doubled)) {
    return { path: doubled, created: false, note: `找不到 ${rel}，但有 ${path.basename(doubled)}（記事本存檔時多了一個 .txt），先用它。` };
  }
  const example = exampleRel ? path.resolve(ROOT, exampleRel) : null;
  if (example && fs.existsSync(example)) {
    fs.copyFileSync(example, abs);
    return { path: abs, created: true };
  }
  const err = new Error(`找不到 ${rel}（也沒有 ${path.basename(doubled)}）。請在專案資料夾 ${ROOT} 建立這個檔案。`);
  err.code = 'ENOENT';
  throw err;
}

/** Open a file in the OS default editor so the operator can fill it in (best effort). */
function openInEditor(file) {
  try {
    const cmd = process.platform === 'win32' ? 'notepad' : 'open';
    spawn(cmd, [file], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Not fatal: the message already tells them which file to edit.
  }
}

/** @returns {{chat:string, label:string}[]} chat = LINE display name, label = what {name} renders to */
function readRecipients(file) {
  const raw = readText(file);
  const seen = new Set();
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const text = line.replace(/#.*$/, '').trim();
    if (!text) continue;
    const [chat, label] = text.split(/\s*=>\s*/);
    if (!chat) continue;
    if (seen.has(chat)) continue;
    seen.add(chat);
    out.push({ chat, label: (label || chat).trim() });
  }
  return out;
}

function loadResume(file) {
  const rep = JSON.parse(fs.readFileSync(file, 'utf8'));
  const done = new Set();
  for (const r of rep.results || []) if (r.status === 'sent' || r.status === 'sent-manual') done.add(r.chat);
  return done;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

function render(template, label) {
  return template.replace(/\{name\}/g, label);
}

function fmt(r) {
  return r.label !== r.chat ? `${r.chat}（稱呼：${r.label}）` : r.chat;
}

// ---------------------------------------------------------------- main ----

async function main() {
  let cfg;
  try {
    cfg = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`參數錯誤：${e.message}`);
    console.error(HELP);
    process.exit(2);
  }
  if (cfg.help) {
    console.log(HELP);
    return;
  }
  if (!cfg.to) {
    console.error('缺少 --to <收件人檔案>');
    console.error(HELP);
    process.exit(2);
  }
  if (!cfg.message && !cfg.messageFile) {
    console.error('缺少 --message 或 --message-file');
    console.error(HELP);
    process.exit(2);
  }

  const runId = fileTag();
  const log = createLogger({ runId });
  const reportPath = path.join(LOG_DIR, `broadcast-report-${runId}.json`);

  // Inputs. Fail loudly before touching LINE.
  // First run on a fresh machine: recipients.txt / message.txt are git-ignored
  // (real customer names), so create them from the examples, open them for
  // editing, and stop — never send the example content.
  let recipients;
  let template = cfg.message;
  try {
    const rc = locateInput(cfg.to, 'examples/recipients.example.txt');
    const mf = cfg.messageFile ? locateInput(cfg.messageFile, 'examples/message.example.txt') : null;
    if (rc.created || (mf && mf.created)) {
      const made = [rc.created && cfg.to, mf && mf.created && cfg.messageFile].filter(Boolean);
      log.warn(`第一次執行：已從範本建立 ${made.join('、')}。`);
      console.log('\n請在剛打開的記事本裡填入真實的客戶 LINE 名稱與訊息內容，存檔後再執行一次。\n');
      for (const f of made) openInEditor(path.resolve(ROOT, f));
      process.exit(2);
    }
    if (rc.note) log.warn(rc.note);
    if (mf && mf.note) log.warn(mf.note);
    recipients = readRecipients(rc.path);
    if (mf) template = readText(mf.path).replace(/\r\n/g, '\n');
  } catch (e) {
    log.error(`讀取收件人 / 訊息檔案失敗：${e.message}`);
    console.error(`\n檔案要放在這個資料夾：${ROOT}\n（如果是用記事本建立的，檢查有沒有變成 recipients.txt.txt）\n`);
    process.exit(2);
  }
  if (recipients.length === 0) {
    log.error(`收件人清單為空：${cfg.to}（開頭是 # 的行不算）`);
    process.exit(2);
  }
  template = template.replace(/\s+$/, '');
  if (!template) {
    log.error('訊息內容為空，停止。');
    process.exit(2);
  }

  let skip = new Set();
  if (cfg.resume) {
    try {
      skip = loadResume(path.resolve(ROOT, cfg.resume));
      log.info(`--resume：略過 ${skip.size} 位已發送`);
    } catch (e) {
      log.error(`讀取 --resume 報告失敗：${cfg.resume}`, e.message);
      process.exit(2);
    }
  }
  const queue = recipients.filter((r) => !skip.has(r.chat));

  // Plan.
  console.log('');
  console.log(`收件人：${recipients.length} 位（本次要發 ${queue.length} 位）`);
  for (const r of queue) console.log(`  - ${fmt(r)}`);
  console.log('');
  console.log('訊息內容：');
  console.log('----------------------------------------');
  console.log(render(template, queue[0]?.label || '{name}'));
  console.log('----------------------------------------');
  console.log(`每位間隔：${cfg.delayMin}~${cfg.delayMax} 秒，預估總時間約 ${Math.ceil((queue.length * (cfg.delayMin + cfg.delayMax)) / 2 / 60)} 分鐘`);
  if (cfg.manualFirst) console.log('第一位手動確認');
  console.log(`紀錄：${log.file}`);
  console.log('');

  if (cfg.dryRun) {
    log.info('dry-run：未發送任何訊息。', { recipients: queue.length });
    return;
  }
  if (queue.length === 0) {
    log.info('沒有需要發送的收件人。');
    return;
  }

  // Preflight: LINE must be running before we ask for confirmation, so the
  // operator gets the "open LINE first" message immediately.
  let line;
  try {
    line = new LineAutomation();
  } catch (e) {
    log.error(e.message);
    process.exit(1);
  }
  if (!(await line.isLineRunning())) {
    log.error('LINE 未啟動：請先開啟並登入 LINE 桌面版，再重新執行。');
    process.exit(1);
  }
  log.info(`AutoHotkey 路徑：${line.automation.ahkPath}`);
  if (!cfg.manualFirst) {
    log.warn('工具無法確認開到的聊天室是否正確；名字打錯會貼進目前開著的聊天室。新名單建議加 --manual-first。');
  }

  if (!cfg.yes) {
    const ans = (await ask('確認開始發送？發送期間請不要操作鍵盤滑鼠。(y/N) ')).trim().toLowerCase();
    if (ans !== 'y' && ans !== 'yes') {
      log.info('使用者取消。');
      return;
    }
  }

  // Report is written after every recipient so a crash / power loss still
  // leaves a usable --resume file.
  const report = {
    runId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    platform: process.platform,
    recipientsFile: cfg.to,
    messagePreview: template.slice(0, 200),
    results: [],
  };
  const saveReport = () => {
    try {
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    } catch (e) {
      log.warn(`寫入報告失敗：${reportPath}`, e.message);
    }
  };

  let stopRequested = false;
  const onSigint = () => {
    if (stopRequested) process.exit(130);
    stopRequested = true;
    log.warn('收到中斷（Ctrl+C）：完成目前這一位後停止，再按一次立即結束。');
  };
  process.on('SIGINT', onSigint);

  log.info('開始群發', { total: queue.length, delay: `${cfg.delayMin}-${cfg.delayMax}s` });

  let consecutiveFailures = 0;
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < queue.length; i++) {
    const { chat, label } = queue[i];
    const message = render(template, label);
    const manual = cfg.manualFirst && i === 0;
    const entry = { chat, label, status: 'pending', attempts: 0, error: null, at: null };
    report.results.push(entry);

    log.info(`(${i + 1}/${queue.length}) 發送給「${chat}」${manual ? '（手動模式）' : ''}`);

    // One retry: the usual transient failure is LINE briefly losing focus.
    for (let attempt = 1; attempt <= 2 && entry.status === 'pending'; attempt++) {
      entry.attempts = attempt;
      try {
        const r = await line.sendChatMessage(chat, message, !manual);
        if (r.success) {
          entry.status = manual ? 'sent-manual' : 'sent';
          entry.at = new Date().toISOString();
        } else {
          throw new Error(r.error || '未知錯誤');
        }
      } catch (e) {
        const msg = e?.message || String(e);
        entry.error = msg;
        // A "chat not in list" / "header mismatch" error is about this name,
        // not about LINE's state — retrying won't help, move on.
        const permanent = /不在列表中|不符|無法確認/.test(msg);
        if (attempt === 2 || permanent) {
          entry.status = 'failed';
          log.error(`「${chat}」失敗：${msg}`);
        } else {
          log.warn(`「${chat}」第 ${attempt} 次失敗，2 秒後重試：${msg}`);
          await sleep(2000);
        }
      }
    }
    saveReport();

    if (entry.status === 'failed') {
      failed++;
      consecutiveFailures++;
      if (consecutiveFailures >= cfg.maxFailures) {
        log.error(`連續 ${consecutiveFailures} 位失敗，整批停止。請檢查 LINE 視窗狀態後用 --resume ${path.relative(ROOT, reportPath)} 繼續。`);
        break;
      }
    } else {
      sent++;
      consecutiveFailures = 0;
    }

    if (manual && entry.status === 'sent-manual') {
      console.log('');
      console.log('  >> 訊息已貼在 LINE 的輸入框，請到 LINE 確認：');
      console.log('     1. 開啟的聊天室是對的人  2. 內容正確  → 在 LINE 按 Enter 送出');
      console.log('     然後回到這個視窗按 Enter 繼續其餘收件人（輸入 q 放棄）。');
      const ans = (await ask('  繼續？(Enter/q) ')).trim().toLowerCase();
      if (ans === 'q') {
        log.info('使用者在手動確認後放棄，停止。');
        break;
      }
    }

    if (stopRequested) {
      log.warn('依使用者要求停止。');
      break;
    }
    if (i < queue.length - 1) {
      const wait = randBetween(cfg.delayMin, cfg.delayMax);
      log.info(`等待 ${wait.toFixed(1)} 秒`);
      await sleep(wait * 1000);
    }
  }

  process.off('SIGINT', onSigint);
  report.finishedAt = new Date().toISOString();
  saveReport();

  const remaining = queue.length - sent - failed;
  log.info('群發結束', { sent, failed, remaining });
  console.log('');
  console.log(`完成：成功 ${sent}，失敗 ${failed}，未處理 ${remaining}`);
  if (failed || remaining) {
    console.log(`失敗名單：${report.results.filter((r) => r.status === 'failed').map((r) => r.chat).join('、') || '（無）'}`);
    console.log(`要補發，執行：node bin/broadcast.js --to ${cfg.to} ${cfg.messageFile ? `--message-file ${cfg.messageFile}` : '--message "..."'} --resume ${path.relative(ROOT, reportPath)}`);
  }
  console.log(`報告：${reportPath}`);
  process.exit(failed || remaining ? 1 : 0);
}

main().catch((e) => {
  // Anything not caught inside the loop is a bug or an environment problem;
  // make sure it lands in the log file, not just a closed console window.
  try {
    createLogger({ runId: 'crash' }).error('未預期錯誤', e?.stack || String(e));
  } catch {
    console.error(e);
  }
  process.exit(1);
});
