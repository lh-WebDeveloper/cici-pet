import type { TypingStatus } from '../shared/contracts';

// 全局键盘活动监听：只感知"最近在打字"，不记录任何按键内容。
// 依赖 uiohook-napi 原生模块；macOS 需要辅助功能 + 输入监控权限。
export class TypingListener {
  private running = false;
  private callback: (() => void) | undefined;
  private uiohook: { start: () => void; stop: () => void; on: (event: string, handler: () => void) => void } | null = null;
  private lastFiredAt = 0;
  private readonly throttleMs = 1200;

  start(enabled: boolean, callback: () => void): TypingStatus {
    this.callback = callback;
    if (!enabled) {
      this.stop();
      return { enabled: false, reason: 'disabled-by-settings' };
    }
    try {
      // 动态加载，避免在未授权/无原生二进制时拖垮启动
      const mod = require('uiohook-napi');
      const uIOhook = mod.uIOhook ?? mod.default?.uIOhook ?? mod.default ?? mod;
      this.uiohook = uIOhook;
      uIOhook.on('keydown', () => {
        const now = Date.now();
        if (now - this.lastFiredAt < this.throttleMs) return;
        this.lastFiredAt = now;
        this.callback?.();
      });
      uIOhook.start();
      this.running = true;
      return { enabled: true, reason: 'listening' };
    } catch (error) {
      this.running = false;
      this.uiohook = null;
      return { enabled: false, reason: 'not-available' };
    }
  }

  stop(): void {
    this.running = false;
    try {
      this.uiohook?.stop();
    } catch {
      // 忽略重复 stop
    }
    this.uiohook = null;
    this.callback = undefined;
  }

  /** 最近一次感知到按键的时间戳（不感知内容，只感知"在打字"） */
  getLastTypingAt(): number {
    return this.lastFiredAt;
  }
}
