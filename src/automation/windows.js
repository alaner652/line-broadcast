// windows.js — LINE Desktop send automation for Windows via AutoHotkey v2.
//
// Derived from line-desktop-mcp (MIT, Geoffrey Wang); read paths removed.
// Chat selection uses LINE's own search box (Ctrl+Shift+F → paste → Enter),
// so it depends on the recipient name matching LINE's search, and there is
// currently no read-back to confirm which chat actually opened.
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import iconv from 'iconv-lite';
import chardet from 'chardet';

const execAsync = promisify(exec);

/**
 * Locate the AutoHotkey v2 executable. Order: AHK_PATH env → winget/installer
 * default locations → bare `autohotkey` (PATH). Kept lenient so a machine that
 * has AHK in an unusual place can be fixed with a single env var instead of a
 * code change.
 */
export function resolveAhkPath() {
  if (process.env.AHK_PATH) return process.env.AHK_PATH;
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const local = process.env['LOCALAPPDATA'] || '';
  const candidates = [
    path.join(pf, 'AutoHotkey', 'v2', 'AutoHotkey64.exe'),
    path.join(pf, 'AutoHotkey', 'v2', 'AutoHotkey32.exe'),
    path.join(pf, 'AutoHotkey', 'AutoHotkey.exe'),
    local && path.join(local, 'Programs', 'AutoHotkey', 'v2', 'AutoHotkey64.exe'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      fsSync.accessSync(c);
      return c;
    } catch {
      /* try next */
    }
  }
  return 'autohotkey';
}

export class WindowsLineAutomation {
  constructor() {
    this.lineAppName = 'LINE';
    this.lineWinTitle = 'LINE';
    this.delayShort = 200; // for key stroke, mouse click simulation human-like
    this.delayMid = 600; // for short data loading
    this.delayMidLong = 1200; // for mid data loading
    this.delayLong = 3000; // for long data loading
    this.ahkPath = resolveAhkPath();
  }

  /**
   * Executes an AutoHotkey v2 script.
   * @param {string} script The AHK script content.
   * @returns {Promise<string>} The stdout from the script execution.
   */
  async runAhk(script) {
    const scriptPath = path.join(os.tmpdir(), `line-automation-${Date.now()}.ahk`);
    // Prepend necessary AHK settings
    const fullScript = `#SingleInstance force
#Requires AutoHotkey v2.0
SendMode "Input"
SetWorkingDir A_ScriptDir
CoordMode "Pixel", "Screen"
SetTitleMatchMode 2
${script}
`;
    await fs.writeFile(scriptPath, fullScript);

    try {
      // Use buffer encoding to handle raw bytes
      const { stdout, stderr } = await execAsync(`"${this.ahkPath}" "${scriptPath}"`, {
        encoding: 'buffer'
      });
      
      if (stderr && stderr.length > 0) {
        // Detect and convert stderr encoding
        const stderrEncoding = chardet.detect(stderr);
        const stderrText = stderrEncoding ? iconv.decode(stderr, stderrEncoding) : stderr.toString('utf8');
        console.error(`AHK Script Error: ${stderrText}`);
      }
      
      if (!stdout || stdout.length === 0) {
        return '';
      }
      
      // Detect encoding of stdout
      const detectedEncoding = chardet.detect(stdout);
      console.error(`AHK stdout detected encoding: ${detectedEncoding}`);
      
      // Convert to UTF-8 string
      let result;
      if (detectedEncoding && detectedEncoding.toLowerCase() !== 'utf-8' && detectedEncoding.toLowerCase() !== 'utf8') {
        try {
          result = iconv.decode(stdout, detectedEncoding);
          console.error(`AHK stdout converted from ${detectedEncoding} to UTF-8`);
        } catch (conversionError) {
          console.warn(`Failed to convert AHK stdout from ${detectedEncoding}:`, conversionError.message);
          result = stdout.toString('utf8');
        }
      } else {
        result = stdout.toString('utf8');
        console.error('AHK stdout already in UTF-8 or ASCII');
      }
      
      return result.trim();
    } catch (error) {
      console.error(`Failed to execute AHK script: ${error.message}`);
      throw new Error(`AHK execution failed. Is AutoHotkey v2 installed and in your PATH?`);
    } finally {
      await fs.unlink(scriptPath); // Clean up the temp file
    }
  }

  async isLineRunning() {
    try {
      const result = execSync('tasklist /FI "IMAGENAME eq LINE.exe"', { encoding: 'utf8' });
      return result.toLowerCase().includes('line.exe');
    } catch (error) {
      // tasklist throws an error if no process is found
      return false;
    }
  }

  async activateLine() {
    const script = `
      SetTitleMatchMode 3
      If WinExist("${this.lineWinTitle}") {
        WinActivate "${this.lineWinTitle}"
        WinWaitActive "${this.lineWinTitle}",, 2
        ExitApp(0) ; Success
      } else {
        ExitApp(1) ; Failure
      }
    `;
    try {
      await this.runAhk(script);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async selectChat(chatName) {
    const script = `
      SetTitleMatchMode 3 
      WinActivate "${this.lineWinTitle}"
      Sleep ${this.delayShort}
      ; Get window position and size
      WinGetPos &winX, &winY, &winW, &winH, "${this.lineWinTitle}"
      ; Click at position (w-20, h/2) within the window
      CoordMode "Mouse", "Screen"
      scale := A_ScreenDPI / 96
      clickX := winX + 30 * scale
      clickY := winY + 110 * scale
      Click clickX, clickY
      Sleep ${this.delayMid}
      Send "^+f" ; Ctrl+Shift+F to focus search bar
      Sleep ${this.delayShort}
      A_Clipboard := "${chatName}"
      Send "^a" ; Select all
      Send "{Delete}"
      Sleep ${this.delayShort}
      Send "^v" ; Paste chat name
      Sleep ${this.delayMid}
      Send "{Enter}"
      Sleep ${this.delayShort}
      ; Space opens the highlighted (first) search result. Keyboard instead of a
      ; coordinate click so DPI scaling / window layout cannot send it elsewhere.
      Send "{Space}"
      Sleep ${this.delayMid}
      Return
    `;
    try {
      await this.runAhk(script);
      return true;
    } catch (e) {
      console.error('selectChat failed', e);
      return false;
    }
  }

  async switchToEnglish() {
    // On Windows, switching input method is complex.
    // A common method is to cycle with Alt+Shift.
    // For now, we assume the user has the correct (e.g., English) input method active.
    // This can be improved later with more advanced techniques if needed.
    const script = `
      WinActivate "${this.lineWinTitle}"
      Sleep ${this.delayShort}
      Send "!+^" ; Alt+Shift to cycle language (example, might not work for all)
    `;
    // We will just log a warning and proceed, as this is not reliable.
    console.warn("Switching to English on Windows is not reliably implemented. Assuming correct input method is active.");
    // await this.runAhk(script);
    return;
  }

  async sendMessage(chatName, message, autoSend = false) {
    const messageParts = [];
    let currentPart = '';

    /*
    const parts = message.split(/(@\S+\s)/g);

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.match(/^@\S+\s$/)) {
        if (currentPart) {
          messageParts.push(currentPart);
          currentPart = '';
        }
        messageParts.push(part);
      } else {
        currentPart += part;
      }
    }
    */
    
    // Use regex to split by @mentions pattern (已排除 /@ 這個格式)
    const parts = message.split(/((?<!\/)@\S+\s)/g);
    
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.match(/^(?<!\/)@\S+\s$/)) {
        // If we have accumulated text before this @mention, add it as a separate part
        if (currentPart) {
          messageParts.push(currentPart);
          currentPart = '';
        }
        // Add the @mention as its own part
        messageParts.push(part);
      } else {
        // Accumulate non-@mention text
        currentPart += part;
      }
    }

    // Add any remaining text
    if (currentPart) {
      messageParts.push(currentPart);
    }

    let result = await this._sendSingleMessageInit(chatName);

    for (const part of messageParts) {
      if (part.match(/^@\S+\s$/)) {
        result = await this._sendSingleMessage(chatName, ' ');
        result = await this._sendSingleMessage(chatName, part.trim() );
        result = await this._sendSingleMessage(chatName, 'k');
        result = await this._sendSingleMessageBackspace();
        //result = await this._sendSingleMessageClickMention();
        result = await this._sendShiftEnter();
        
      } else {
        const lines = part.split(/\r\n|\n|\r/); // Handles Windows, Unix, and old Mac line endings
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line) {
            result = await this._sendSingleMessage(chatName, line);
          }

          if (i < lines.length - 1) {
            // Not the last line, so press Shift+Enter
            result = await this._sendShiftEnter();
          }
        }
      }
    }

    if (autoSend) {
      result = await this._sendSingleMessageEnter();
    }

    if (result.success)
      return { success: true, error: null };
    else
      return { success: false, error: result.error };
  }

  async _sendShiftEnter() {
    const script = `
      WinActivate "${this.lineWinTitle}"
      Send "+{Enter}" ; Shift+Enter for newline
    `;
    try {
      await this.runAhk(script);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async _sendSingleMessageInit(chatName) {
    const script = `
      SetTitleMatchMode 3
      WinActivate "${this.lineWinTitle}"
      ; Get window position and size
      WinGetPos &winX, &winY, &winW, &winH, "${this.lineWinTitle}"
      ; Click at position (w-20, h/2) within the window
      CoordMode "Mouse", "Screen"
      scale := A_ScreenDPI / 96
      clickX := winX + winW * (3/4)
      clickY := winY + winH - 100 * scale
      Click clickX, clickY
      Sleep ${this.delayShort}
      Send "^a"
      Send "{Delete}"
      Sleep ${this.delayLong}
    `;
    try {
      await this.runAhk(script);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async _sendSingleMessage(chatName, message) {
    const script = `
      SetTitleMatchMode 3
      WinActivate "${this.lineWinTitle}"
      A_Clipboard := "${message.replace(/"/g, '**')}"
      Send "^v"
      Sleep ${this.delayShort}
    `;
    try {
      await this.runAhk(script);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async _sendSingleMessageEnter() {
    const script = `
      SetTitleMatchMode 3
      WinActivate "${this.lineWinTitle}"
      Send "{Enter}"
    `;
    try {
      await this.runAhk(script);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async _sendSingleMessageBackspace() {
    const script = `
      Sleep ${this.delayMid}
      SetTitleMatchMode 3
      WinActivate "${this.lineWinTitle}"
      Send "{Backspace}"
      Sleep ${this.delayMidLong}
    `;
    try {
      await this.runAhk(script);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async _sendSingleMessageClickMention() {
    const script = `
      SetTitleMatchMode 3
      Sleep ${this.delayLong}
      ; Get window position and size
      WinGetPos &winX, &winY, &winW, &winH, "${this.lineWinTitle}"
      ; Click at position (w-20, h/2) within the window
      CoordMode "Mouse", "Screen"
      scale := A_ScreenDPI / 96
      clickX := winX + winW * (3/4)
      clickY := winY + winH - 130 * scale
      Click clickX, clickY
      Sleep ${this.delayShort}

      ; Get window position and size
      WinGetPos &winX, &winY, &winW, &winH, "${this.lineWinTitle}"
      ; Click at position (w-20, h/2) within the window
      CoordMode "Mouse", "Screen"
      clickX := winX + winW - 20 * scale
      clickY := winY + winH - 50 * scale
      Click clickX, clickY
    `;
    try {
      await this.runAhk(script);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
}