// index.js — platform wrapper over the macOS / Windows LINE send automation.

import { MacOSLineAutomation } from './macos.js';
import { WindowsLineAutomation } from './windows.js';

export class LineAutomation {
  constructor() {
    this.platform = process.platform;
    if (this.platform === 'darwin') this.automation = new MacOSLineAutomation();
    else if (this.platform === 'win32') this.automation = new WindowsLineAutomation();
    else throw new Error(`不支援的平台：${this.platform}（只支援 macOS / Windows）`);
  }

  get canVerify() {
    return this.platform === 'darwin';
  }

  async isLineRunning() {
    return await this.automation.isLineRunning();
  }

  /**
   * Resolve a chat name WITHOUT sending or typing anything. Used by --check to
   * find unresolvable names before a run.
   *
   * macOS: non-hijacking AX lookup + header read-back.
   * Windows: not possible with the search-box approach; returns verified:'unknown'.
   * @returns {Promise<{matched:boolean, verified:'match'|'mismatch'|'unknown', header:string, seen:string[]}>}
   */
  async resolveChat(chatName) {
    if (this.platform !== 'darwin') {
      return { matched: true, verified: 'unknown', header: '', seen: [] };
    }
    await this.automation.ensureReady(15000);
    const sel = await this.automation.selectChatAX(chatName);
    return { matched: sel.matched, verified: sel.verified, header: sel.header, seen: sel.seen || [] };
  }

  /**
   * Send one message to one chat.
   * @param {string} chatName   name as shown in LINE's chat list
   * @param {string} message
   * @param {boolean} autoSend  true = press Enter; false = leave it in the composer
   * @param {{requireVerified?: boolean}} opts  macOS: abort unless the opened
   *        chat's header was read back and matches chatName.
   */
  async sendChatMessage(chatName, message, autoSend = false, { requireVerified = false } = {}) {
    if (this.platform !== 'darwin') {
      // Windows selectChat is search-and-click with no read-back: a name the
      // search doesn't find leaves the previously open chat active. Callers
      // must lean on process safeguards (--manual-first, exact names).
      await this.automation.switchToEnglish();
      await this.automation.activateLine();
      const ok = await this.automation.selectChat(chatName);
      if (!ok) throw new Error(`無法選取聊天室「${chatName}」（AutoHotkey 執行失敗）`);
      return await this.automation.sendMessage(chatName, message, autoSend);
    }

    // Readiness + non-hijacking AX select first, so we fail cleanly before touching input.
    await this.automation.ensureReady(15000);
    const sel = await this.automation.selectChatAX(chatName);
    if (!sel.matched) {
      const seen = sel.seen && sel.seen.length ? sel.seen.slice(0, 10).join(', ') : '（無法讀取任何列表項）';
      throw new Error(`聊天室「${chatName}」不在列表中，無法發送。列表可見前 10 項：${seen}`);
    }
    if (sel.verified === 'mismatch') {
      throw new Error(`發送中止：目前開啟的聊天室「${sel.header}」與目標「${chatName}」不符。`);
    }
    if (requireVerified && sel.verified !== 'match') {
      throw new Error(
        `發送中止：無法確認已開啟的聊天室為「${chatName}」（標題讀取結果：「${sel.header || '空'}」）。` +
          '若確定 LINE 版面正常可加 --allow-unverified。'
      );
    }

    await this.automation.switchToEnglish();
    const act = await this.automation.activateLine();
    if (!act.success) throw new Error(`無法將 LINE 置於前景以發送訊息：${act.error}`);
    return await this.automation.sendMessage(chatName, message, autoSend);
  }
}
