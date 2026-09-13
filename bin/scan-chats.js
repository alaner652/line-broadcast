#!/usr/bin/env node
// scan-chats.js — page through LINE's chat list and draft a recipients file.
//
// Windows only. Reads each visible page (UI Automation, else screenshot + the
// Windows built-in OCR), scrolls, and stops when two consecutive pages add no
// new name. Writes recipients.draft.txt and opens it in Notepad: the operator
// deletes the chats that are not customers, fixes OCR slips, then renames it
// to recipients.txt. It never writes recipients.txt itself unless asked.
//
// Usage:
//   node bin/scan-chats.js [options]
//   --out <file>        output file (default recipients.draft.txt)
//   --list-width <px>   chat list panel width in 100%-DPI px (default 320)
//   --rail <px>         left icon rail width (default 64)
//   --top <px>          panel top offset below window top, skips search box (default 90)
//   --max-pages <n>     safety cap (default 80)
//   --row-gap <f>       OCR row split: multiples of line height (default 1.8)
//   --debug             save every page's screenshot + raw text to logs/scan-<runId>/
//   --no-open           don't open the result in Notepad
//   -h, --help

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { WindowsLineAutomation } from '../src/automation/windows.js';
import { WindowsChatList, extractNames } from '../src/scan/windows-chatlist.js';
import { createLogger, fileTag, LOG_DIR } from '../src/logger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELP = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n');

function parseArgs(argv) {
  const cfg = { out: 'recipients.draft.txt', listWidth: 320, rail: 64, top: 90, maxPages: 80, rowGap: 1.8, debug: false, open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--out') cfg.out = next();
    else if (a === '--list-width') cfg.listWidth = Number(next());
    else if (a === '--rail') cfg.rail = Number(next());
    else if (a === '--top') cfg.top = Number(next());
    else if (a === '--max-pages') cfg.maxPages = Number(next());
    else if (a === '--row-gap') cfg.rowGap = Number(next());
    else if (a === '--debug') cfg.debug = true;
    else if (a === '--no-open') cfg.open = false;
    else if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else { console.error(`未知參數：${a}`); process.exit(2); }
  }
  return cfg;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const runId = fileTag();
  const log = createLogger({ runId });

  if (process.platform !== 'win32') {
    log.error(`掃描聊天室名單只支援 Windows（目前：${process.platform}）`);
    process.exit(2);
  }

  const auto = new WindowsLineAutomation();
  if (!(await auto.isLineRunning())) {
    log.error('LINE 未啟動：請先開啟 LINE 並登入。');
    process.exit(1);
  }

  const debugDir = cfg.debug ? path.join(LOG_DIR, `scan-${runId}`) : null;
  if (debugDir) fs.mkdirSync(debugDir, { recursive: true });

  const list = new WindowsChatList(auto);
  const win = await list.windowRect();
  const s = win.scale;
  const panel = {
    x: Math.round(win.x + cfg.rail * s),
    y: Math.round(win.y + cfg.top * s),
    w: Math.round(cfg.listWidth * s),
    h: Math.round(win.h - cfg.top * s - 10 * s),
  };
  panel.cx = panel.x + Math.floor(panel.w / 2);
  panel.cy = panel.y + Math.floor(panel.h / 2);
  log.info('開始掃描聊天室列表', { window: win, panel });
  console.log('掃描期間請不要碰鍵盤滑鼠，LINE 會自己捲動。按 Ctrl+C 可中止（已讀到的會照樣寫出）。\n');

  // ~72px per row at 100%; one wheel notch scrolls ~3 rows. Overlap is fine (dedupe).
  const rowsPerPage = Math.max(3, Math.floor(panel.h / (72 * s)));
  const notches = Math.max(2, Math.floor(rowsPerPage / 3) - 1);

  await list.prepare(panel);
  await sleep(auto.delayMid);

  const names = [];
  const seen = new Set();
  let source = '';
  let lang = '';
  let stale = 0;
  let stopped = false;
  process.on('SIGINT', () => { stopped = true; });

  for (let page = 1; page <= cfg.maxPages && !stopped; page++) {
    const shot = debugDir ? path.join(debugDir, `page-${String(page).padStart(2, '0')}.png`) : '';
    let r;
    try {
      r = await list.readPage(panel, shot);
    } catch (e) {
      log.error(`第 ${page} 頁讀取失敗：${e.message}`);
      break;
    }
    if (debugDir) fs.writeFileSync(path.join(debugDir, `page-${String(page).padStart(2, '0')}.json`), JSON.stringify(r, null, 2));
    if (r.error) log.warn(`第 ${page} 頁：${r.error}`);
    source = r.source || source;
    lang = r.lang || lang;

    const found = extractNames(r.lines, { panelW: panel.w, source: r.source, rowGap: cfg.rowGap });
    let added = 0;
    for (const n of found) {
      if (seen.has(n)) continue;
      seen.add(n);
      names.push(n);
      added++;
    }
    log.info(`第 ${page} 頁：辨識 ${found.length} 個，新增 ${added} 個，累計 ${names.length}`, { source: r.source });
    if (found.length === 0 && page === 1) {
      log.error('第一頁就沒讀到任何文字。請確認 LINE 視窗沒被遮住、列表在畫面上；可加 --debug 看截圖是否框到聊天列表，並用 --list-width / --rail / --top 調整範圍。');
      break;
    }
    stale = added === 0 ? stale + 1 : 0;
    if (stale >= 2) break;
    await list.scroll(panel, notches);
  }

  if (names.length === 0) {
    log.error('沒有讀到任何聊天室名稱。');
    process.exit(1);
  }

  const outPath = path.resolve(ROOT, cfg.out);
  const header = [
    `# LINE 聊天室名單草稿 — ${new Date().toLocaleString('zh-TW')}`,
    `# 來源：${source === 'uia' ? 'Windows UI Automation（文字精確）' : `Windows OCR（${lang || '未知語言'}，可能有錯字，請核對）`}，共 ${names.length} 個`,
    '# 請：1) 刪掉不是客戶的（群組、官方帳號、Keep 等） 2) 對照 LINE 修正名字',
    '#     3) 需要的話用「LINE名稱 => 稱呼」讓訊息裡的 {name} 顯示稱呼',
    '#     4) 存檔後把檔名改成 recipients.txt（或複製內容過去）',
    '',
  ];
  fs.writeFileSync(outPath, '\uFEFF' + header.concat(names).join('\r\n') + '\r\n', 'utf8');
  log.info(`已寫出 ${names.length} 個名稱到 ${path.relative(ROOT, outPath)}`);
  if (debugDir) console.log(`除錯截圖與原始辨識結果：${debugDir}`);

  if (cfg.open) {
    try { spawn('notepad', [outPath], { detached: true, stdio: 'ignore' }).unref(); } catch { /* not fatal */ }
  }
}

main().catch((e) => {
  createLogger({ runId: 'crash' }).error('未預期錯誤', e?.stack || String(e));
  process.exit(1);
});
