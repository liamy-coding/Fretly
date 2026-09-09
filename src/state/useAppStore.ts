/**
 * 应用级 Store（T-16）：Settings 持久化 + UI 偏好 + Toast 队列 + 合规声明 + 能力检测。
 *
 * Settings 的权威读写走 storage/db（localStorage `fretly.settings` + 订阅）；
 * 这里做 React 侧缓存与同步，避免页面各自读 localStorage。
 */
import { create } from 'zustand';
import type { Settings } from '@/types/app';
import type { Capabilities } from '@/audio/AudioEngine';
import { detectCapabilities } from '@/audio/AudioEngine';
import { loadSettings, onSettingsChange, patchSettings, saveSettings } from '@/storage/db';

export type ToastType = 'success' | 'error' | 'warn' | 'info';

export interface ToastItem {
  id: number;
  type: ToastType;
  text: string;
}

interface AppState {
  settings: Settings;
  capabilities: Capabilities;
  toasts: ToastItem[];
  showDisclaimer: boolean;
  inited: boolean;

  init(): void;
  patchSettings(patch: Partial<Settings> | ((s: Settings) => Partial<Settings>)): void;
  resetSettings(): void;
  ackDisclaimer(): void;
  toast(type: ToastType, text: string): void;
  dismissToast(id: number): void;
}

let toastSeq = 1;

export const useAppStore = create<AppState>((set, get) => ({
  settings: loadSettings(),
  capabilities: detectCapabilities(),
  toasts: [],
  showDisclaimer: !loadSettings().disclaimerAcked,
  inited: false,

  init() {
    if (get().inited) return;
    const settings = loadSettings();
    set({
      settings,
      showDisclaimer: !settings.disclaimerAcked,
      capabilities: detectCapabilities(),
      inited: true,
    });
    // 跨标签页 / 本页 settings 变更自动同步
    onSettingsChange((next) => set({ settings: next, showDisclaimer: !next.disclaimerAcked }));
  },

  patchSettings(patch) {
    const current = get().settings;
    const next = typeof patch === 'function' ? patch(current) : patch;
    saveSettings({ ...current, ...next });
    set({ settings: { ...current, ...next } });
  },

  resetSettings() {
    const next = { ...loadSettings() };
    saveSettings(next);
    set({ settings: next });
  },

  ackDisclaimer() {
    const next = { ...get().settings, disclaimerAcked: true };
    saveSettings(next);
    set({ settings: next, showDisclaimer: false });
  },

  toast(type, text) {
    const id = toastSeq++;
    set({ toasts: [...get().toasts, { id, type, text }] });
    // 自动消失（错误稍久）
    const ms = type === 'error' ? 5200 : 3000;
    window.setTimeout(() => get().dismissToast(id), ms);
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

/** 便捷：把任何可能失败的异步动作包装成 toast 错误提示 */
export async function withToastError(
  label: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    useAppStore.getState().toast('error', `${label}：${msg}`);
  }
}

export function useSettings(): Settings {
  return useAppStore((s) => s.settings);
}

export function useCapabilities(): Capabilities {
  return useAppStore((s) => s.capabilities);
}

export { patchSettings };
