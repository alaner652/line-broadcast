// index.js — thin wrapper over the Windows LINE send automation.

import { WindowsLineAutomation } from './windows.js';

export class LineAutomation {
  constructor() {
    if (process.platform !== 'win32') {
      throw new Error(`不支援的平台：${process.platform}（只支援 Windows）`);
    }
    this.automation = new WindowsLineAutomation();
  }

  async isLineRunning() {
    return await this.automation.isLineRunning();
  }

  /**
   * Send one message to one chat.
   * @param {string} chatName   name as shown in LINE's chat list
   * @param {string} message
   * @param {boolean} autoSend  true = press Enter; false = leave it in the composer
   */
  async sendChatMessage(chatName, message, autoSend = false) {
    // selectChat is search-and-click with no read-back: a name the search
    // doesn't find leaves the previously open chat active. Callers must lean
    // on process safeguards (--manual-first, exact names).
    await this.automation.switchToEnglish();
    await this.automation.activateLine();
    const ok = await this.automation.selectChat(chatName);
    if (!ok) throw new Error(`無法選取聊天室「${chatName}」（AutoHotkey 執行失敗）`);
    return await this.automation.sendMessage(chatName, message, autoSend);
  }
}
