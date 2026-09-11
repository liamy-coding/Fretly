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

// ── 五线谱指法分配：绝对把位代价（core/staffFingering.ts）──────────
/**
 * 左手把位的「延伸代价」（每品）。
 *
 * 物理含义：手位越靠琴身，左臂前伸越多、静止张力越大。这是一个**绝对**梯度
 * （与相邻音符无关，只取决于手位本身），使 DP 在完成高把位乐句后有动力**回落**
 * 低把位，而不是顺着「就近转移」永远滞留在高把位盆地。
 */
export const POSITION_EXTENSION_COST = 0.04;

/**
 * 单手自然按弦跨度（品）。候选位置高出「该音自身最低可行品位」不超过此跨度时，
 * 属于一个手位内的正常伸展，不计额外代价。
 */
export const HAND_SPAN_FRETS = 5;

/**
 * 「多余伸展」惩罚（每品）。
 *
 * 物理含义：候选位置高出 `最低可行品位 + HAND_SPAN_FRETS` 的部分，是**本可避免**的
 * 上把位滞留——该音在其最低把位完全弹得下，却因贪图相邻转移之便而被迫抬高整只手。
 * 逐品计费，把「无谓的上把位漂移」显式定价。
 *
 * 该项以**音符自身**的最低可行品为基准（纯相对量），故真正的高音（如 C6 只能落 20 品）
 * 不会被误罚，只有「本可弹低却弹高」才付代价。
 */
export const OVER_REACH_PENALTY = 1.0;

/**
 * 首节点锚定惩罚（**有限**大值，刻意不用 Infinity）。
 *
 * `viterbi` 约定：整个把位序列只能从「绝对把位代价最小」的首候选出发——旋律与和弦
 * **语义统一**。（旧实现取候选数组的 `reps[0]`，对旋律是「最低品」、对和弦却是
 * 「品差最小」，同一双音在小节首音位置会被锚到高把位，与它出现在小节中间时不一致。）
 *
 * 实现上：给节点 0 的**其余候选**在 dp 初值上加此惩罚，而**完整保留候选数组**
 * （不重排、不截断），因此回溯得到的 `path[0]` 仍能直接索引原候选数组，回填逻辑无需改动。
 *
 * 取值 1e6：远超任何小节的真实目标代价上界（每节点代价 ≤ ~25、每条边 ≤ ~13、
 * 小节节点数至多数百 → 上界 < 1e4），故足以支配一切后续路径；同时是有限值，
 * 不会像 Infinity 那样污染后续加法算术。
 */
export const START_ANCHOR_PENALTY = 1_000_000;

// ── 导入 ──────────────────────────────────────────────────────────
/** MusicXML（XML）导入体积上限（MB）：XML 结构冗余，阈值更保守 */
export const MAX_IMPORT_XML_MB = 8;
/** Fretly JSON 导入体积上限（MB） */
export const MAX_IMPORT_JSON_MB = 20;
/**
 * ASCII 粘贴文本长度上限（字符数）。
 *
 * 粘贴输入没有 `File` 对象，`isFileTooLarge` 对其天然失效，故按**字符数**守卫。
 * 1,000,000 字符 ≈ 1MB 纯文本 / ≈ 2MB UTF-16，约为最坏真实用例（200 小节密集谱 ≈ 30KB）
 * 的 30 倍余量；目的是挡住「粘贴了一本书」导致 O(n·w) 扫描卡死主线程，而非限制正常使用。
 */
export const MAX_IMPORT_ASCII_CHARS = 1_000_000;

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
  importXmlTooLarge: `文件超过 ${MAX_IMPORT_XML_MB}MB，请裁剪后再导入`,
  importJsonTooLarge: `文件超过 ${MAX_IMPORT_JSON_MB}MB，请裁剪后再导入`,
  /** ASCII 走粘贴，无 File 维度，按字符数守卫 */
  importAsciiTooLarge: `粘贴内容超过 ${MAX_IMPORT_ASCII_CHARS / 10000} 万字符，请分段导入`,
  /** Tuning 键存在但无法可靠解析时的结构化警告 */
  asciiTuningUnparsed: '调弦信息无法识别，已使用标准调弦',
  pasteAsciiRequired: '请粘贴 ASCII 谱内容',
  selectFileRequired: '请选择文件',
  partialTitle: '谱面部分解析成功',
  partialKeep: '保留已解析部分并导入',
  partialAsk: '是否保留已解析的部分并导入？',
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
