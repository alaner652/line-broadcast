// windows-chatlist.js — page through LINE's chat list on Windows and collect
// chat names, to draft a recipients file the operator then edits by hand.
//
// LINE for Windows exposes no accessible text tree we can rely on, so each
// page is read by read-chatlist.ps1 (UI Automation if LINE exposes list items,
// otherwise screenshot + Windows built-in OCR). Scrolling is a mouse wheel
// over the list panel via AutoHotkey. Accuracy is "good enough for a draft":
// the output is meant to be reviewed, never sent from directly.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const PS1 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'read-chatlist.ps1');

/** Lines that are UI chrome, not chat names, if the capture rect catches them. */
const CHROME = new Set(['聊天', '搜尋', '好友', 'Chats', 'Search', 'Friends', '釘選', '全部']);
const TIME_RE = /^(\d{1,2}:\d{2}|上午\s*\d{1,2}:\d{2}|下午\s*\d{1,2}:\d{2}|昨天|前天|星期[一二三四五六日]|週[一二三四五六日]|\d{1,2}\/\d{1,2}|\d{4}\/\d{1,2}\/\d{1,2})$/;

/**
 * Turn one page of positioned text lines into chat names.
 *
 * Each list row is: [avatar] name ........ time
 *                            last message preview ... [badge]
 * So a name is the TOP line of a row on the LEFT side. Rows are separated by a
 * vertical gap clearly bigger than the name→preview gap, which we express in
 * units of the median line height so it survives DPI scaling.
 *
 * @param {{text:string,x:number,y:number,w:number,h:number}[]} lines
 * @param {{panelW:number, source?:string, rowGap?:number}} opts
 *        rowGap: multiples of median line height that start a new row (default 1.8)
 * @returns {string[]} names in top-to-bottom order
 */
export function extractNames(lines, { panelW, source = 'ocr', rowGap = 1.8 }) {
  if (source === 'uia') {
    // UIA list items already are rows; the name is the first text line.
    return lines.map((l) => cleanName(l.text.split(/\r?\n/)[0])).filter(Boolean);
  }
  const left = lines
    .filter((l) => l.text && l.text.trim() && l.x < panelW * 0.55)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  if (left.length === 0) return [];

  const hs = left.map((l) => l.h).filter((h) => h > 0).sort((a, b) => a - b);
  const medianH = hs.length ? hs[Math.floor(hs.length / 2)] : 20;
  const threshold = medianH * rowGap;

  const rows = [];
  let cur = null;
  let prevY = null;
  for (const l of left) {
    if (cur === null || l.y - prevY > threshold) {
      cur = [l];
      rows.push(cur);
    } else {
      cur.push(l);
    }
    prevY = l.y;
  }
  return rows.map((r) => cleanName(r[0].text)).filter(Boolean);
}

/** Strip group member counts, stray times, and chrome; '' if nothing is left. */
export function cleanName(text) {
  let t = String(text).trim();
  t = t.replace(/\s*[（(]\s*\d+\s*[)）]\s*$/, ''); // group "(12)"
  t = t.replace(/\s+(上午|下午)?\s*\d{1,2}:\d{2}$/, ''); // time OCR'd onto the same line
  t = t.trim();
  if (!t || CHROME.has(t) || TIME_RE.test(t)) return '';
  if (/^[\d\s:.\/-]+$/.test(t)) return ''; // pure numbers / dates
  return t;
}

export class WindowsChatList {
  /** @param {import('../automation/windows.js').WindowsLineAutomation} auto */
  constructor(auto) {
    this.auto = auto;
  }

  /** LINE window rect + DPI scale, as AHK sees them (physical pixels). */
  async windowRect() {
    const out = await this.auto.runAhk(`
      SetTitleMatchMode 3
      if !WinExist("${this.auto.lineWinTitle}")
        ExitApp(1)
      WinGetPos &x, &y, &w, &h, "${this.auto.lineWinTitle}"
      FileAppend x "," y "," w "," h "," A_ScreenDPI "\`n", "*"
    `);
    const m = out.match(/(-?\d+),(-?\d+),(\d+),(\d+),(\d+)/);
    if (!m) throw new Error(`讀不到 LINE 視窗位置（AHK 回傳：${out || '空'}）`);
    const [, x, y, w, h, dpi] = m.map(Number);
    return { x, y, w, h, scale: dpi / 96 };
  }

  /**
   * Bring LINE forward, switch to the Chats tab, close any open search, and
   * scroll the list to the top.
   */
  async prepare(panel) {
    const d = this.auto;
    await d.runAhk(`
      SetTitleMatchMode 3
      WinActivate "${d.lineWinTitle}"
      WinWaitActive "${d.lineWinTitle}",, 3
      Sleep ${d.delayShort}
      WinGetPos &winX, &winY, &winW, &winH, "${d.lineWinTitle}"
      CoordMode "Mouse", "Screen"
      scale := A_ScreenDPI / 96
      Click winX + 30 * scale, winY + 110 * scale   ; Chats tab in the left rail
      Sleep ${d.delayMid}
      Send "{Escape}"                                ; close search box if open
      Sleep ${d.delayShort}
      MouseMove ${panel.cx}, ${panel.cy}
      Send "{WheelUp 80}"
      Sleep ${d.delayMid}
    `);
  }

  async scroll(panel, notches) {
    await this.auto.runAhk(`
      CoordMode "Mouse", "Screen"
      MouseMove ${panel.cx}, ${panel.cy}
      Send "{WheelDown ${notches}}"
      Sleep ${this.auto.delayMid}
    `);
  }

  /**
   * Read the visible chat list once.
   * @returns {Promise<{source:string, lang:string, lines:any[], error:string}>}
   */
  async readPage(panel, shotPath = '') {
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1,
      '-X', String(panel.x), '-Y', String(panel.y), '-W', String(panel.w), '-H', String(panel.h),
    ];
    if (shotPath) args.push('-Shot', shotPath);
    const { stdout, stderr } = await execFileAsync('powershell', args, { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    const json = stdout.trim().split(/\r?\n/).filter((l) => l.startsWith('{')).pop();
    if (!json) throw new Error(`PowerShell 沒有回傳結果。${stderr ? 'stderr: ' + stderr.slice(0, 500) : ''}`);
    const r = JSON.parse(json);
    if (!Array.isArray(r.lines)) r.lines = r.lines ? [r.lines] : [];
    return r;
  }
}
