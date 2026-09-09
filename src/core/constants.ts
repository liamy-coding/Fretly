/**
 * 全局常量与通用小工具（架构 §9.2 / §9.9）。
 * core 层的基础设施：不允许 import react / audio / storage / ui。
 */
import { newId } from '@/core/id';

// ── 音乐时间 ──────────────────────────────────────────────────────
export const TICKS_PER_BEAT = 480;
/** 预调度窗口（秒） */
export const LOOKAHEAD = 0.1;
/** 调度器间隔（毫秒） */
export const SCHEDULER_MS = 25;
/** 扫弦弦间延迟系数（秒/BPM） */
export const RAKE_MS_PER_BPM = 0.006;

// ── 速度与拍号 ────────────────────────────────────────────────────
export const MIN_BPM = 40;
export const MAX_BPM = 240;
export const MIN_RATIO = 0.5;
export const MAX_RATIO = 1.5;
export const RATIO_STEP = 0.01;
export const BEATS_PER_MEASURE: Record<'4/4' | '3/4', number> = { '4/4': 4, '3/4': 3 };

// ── 指板 ──────────────────────────────────────────────────────────
export const MAX_FRET = 24;
export const STRING_COUNT = 6;

// ── 音频与扒谱 ────────────────────────────────────────────────────
export const MAX_AUDIO_SEC = 300;
export const MAX_AUDIO_MB = 50;
export const TARGET_SAMPLE_RATE = 16000;
export const PEAK_CHUNK = 512;

// ── 置信度阈值 ────────────────────────────────────────────────────
export const CONF_LOW = 0.45;
export const CONF_MID = 0.7;
export const CONF_BAD_AVG = 0.4;

// ── 练习会话 ──────────────────────────────────────────────────────
export const COUNTED_MIN_SEC = 300;
export const PAUSE_END_SEC = 60;
export const TAB_HIDDEN_END_SEC = 300;
/** 提前 1 拍预告下一个和弦 */
export const NEXT_CHORD_LOOKAHEAD_TICKS = 480;
/** 「本轮过了」点击窗口 */
export const PASS_WINDOW_MS = 5000;

// ── 存储与容量 ────────────────────────────────────────────────────
export const MAX_TABS = 500;
export const MAX_DRAFTS = 20;
export const MAX_AUDIOS = 10;
export const STORAGE_PREFIX = 'fretly.';
export const DB_NAME = 'fretly';
export const DB_VERSION = 1;

// ── Schema ───────────────────────────────────────────────────────
export const SCHEMA = 'fretly.tab';
export const SCHEMA_VERSION = '1.1';

// ── 引擎与文案常量（合规：UI 不得出现任何"使用次数配额"类措辞）──
export const LOCAL_ENGINE_LABEL = '本地轻量引擎 · 不限次';
export const LOCAL_ENGINE_ID = 'local-heuristic-v1';

export const COPY = {
  brand: '弦格 Fretly',
  storageLocation: '数据存储：本机浏览器（IndexedDB）',
  storagePrivacy: '不上传任何谱面与音频',
  noGuitarTrack: '未找到可导入的吉他轨',
  notFretlyJson: '不是有效的 Fretly 谱面文件',
  notAsciiTab: '未识别到六线谱文本',
  unsupportedExt: (ext: string) => `暂不支持 ${ext} 格式`,
  fileTooLarge: '文件超过 50MB，请裁剪后再试',
  rightsRequired: '请先确认音频权属',
  lowConfidenceBanner: '这份音频自动扒谱效果不佳',
  micDenied: '麦克风权限被拒绝 · 可在浏览器设置中重新授权',
  notSupportedAudio: '当前浏览器不支持 Web Audio，示范音轨与节拍器不可用',
  storageUnavailable: '浏览器存储不可用，数据将无法保存。请关闭无痕模式后重试',
  repeatIgnored: '反复记号已忽略',
} as const;

// ── 错误码（架构 §9.5）───────────────────────────────────────────
export const ERROR_CODES = {
  E_STORAGE_UNAVAILABLE: 'E_STORAGE_UNAVAILABLE',
  E_QUOTA: 'E_QUOTA',
  E_DECODE: 'E_DECODE',
  E_PERMISSION: 'E_PERMISSION',
  E_PARSE: 'E_PARSE',
  E_NOT_IMPLEMENTED: 'E_NOT_IMPLEMENTED',
  E_WORKER: 'E_WORKER',
  E_AUDIO: 'E_AUDIO',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class AppError extends Error {
  readonly code: ErrorCode;
  override readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.cause = cause;
  }
}

// ── 小工具 ────────────────────────────────────────────────────────
export function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type ClassValue = string | false | null | undefined;

export function cx(...parts: ClassValue[]): string {
  return parts.filter(Boolean).join(' ');
}

// ── 时间助手 ──────────────────────────────────────────────────────
export function nowIso(): string {
  return new Date().toISOString();
}

const DAY_MS = 86_400_000;

export function daysBetween(fromIso: string | null, toIso: string): number {
  if (!fromIso) return Number.POSITIVE_INFINITY;
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
  return (b - a) / DAY_MS;
}

/** 打卡用自然日键（本地时区，非 UTC） */
export function localDateKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(key: string, delta: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, (m ?? 1) - 1, d ?? 1);
  date.setDate(date.getDate() + delta);
  return localDateKey(date);
}

/** 本周起点（周一 00:00，本地时区） */
export function weekStart(d: Date = new Date()): Date {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - dow);
  return date;
}

export function relativeTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '从未练习';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '未知';
  const diffSec = Math.floor((now.getTime() - t) / 1000);
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)} 小时前`;
  if (diffSec < 86_400 * 30) return `${Math.floor(diffSec / 86_400)} 天前`;
  return localDateKey(new Date(t));
}

export { newId };
