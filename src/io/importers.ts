/**
 * 导入器（PRD A-05 / Q4 / Q5，架构 T-12）。
 *
 * TabImporter 是端口：内置 json / musicxml / ascii 三个实现，
 * gp 为占位实现（抛 E_NOT_IMPLEMENTED，UI 不注册）。
 * 解析中断时返回 partial + parsedMeasures + failedAt + reason，
 * 供 UI 弹「保留可解析部分继续导入」。
 */
import type { Measure, Note, StringNumber, Tab, Technique, TimeSignature } from '@/types/tab';
import type { ImportResult, TabImporter } from '@/types/app';
import {
  AppError,
  COPY,
  ERROR_CODES,
  MAX_BPM,
  MAX_FRET,
  MAX_IMPORT_ASCII_CHARS,
  MIN_BPM,
  clamp,
  nowIso,
} from '@/core/constants';
import { newId } from '@/core/id';
import { createEmptyTab, validateTab } from '@/core/tabFactory';
import { measureTicks } from '@/core/tick';
import { musicXmlImporter } from '@/io/musicXmlImporter';

// ── ASCII 常量 ────────────────────────────────────────────────────
/** 一列 = 120 ticks（1/16 音符），4/4 一小节 16 列；3/4 一小节 12 列 */
export const ASCII_COL_TICKS = 120;
export const ASCII_DEFAULT_BPM = 90;

export function asciiColsPerMeasure(ts: TimeSignature): number {
  return Math.max(1, Math.round(measureTicks(ts) / ASCII_COL_TICKS));
}

/** 大小写敏感：e = 1 弦（高音），E = 6 弦（低音） */
const LABEL_TO_STRING: Record<string, StringNumber> = {
  e: 1,
  B: 2,
  G: 3,
  D: 4,
  A: 5,
  E: 6,
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
};

/** 弦号族：字母族（e/B/G/D/A/E）与数字族（1..6）互斥（RISK-1 防误判） */
const LETTER_LABELS = new Set(['e', 'B', 'G', 'D', 'A', 'E']);
const DIGIT_LABELS = new Set(['1', '2', '3', '4', '5', '6']);

/**
 * void：行首弦号 + 终止符（`|` 或至少一个空白）+ 内容。
 * 终止符是必需的：排除 `A:`（`A` 后跟 `:`）这类正文被误判为 A 弦行（RISK-1）。
 */
const LINE_RE = /^\s*([eEBGDA]|[1-6])(\s*\|\s*|\s+)(.*)$/;
/** 弦内容区中「至少一个可演奏字符」（音符 + 技法 / 闷音），用于块级识别（RISK-1 ②） */
const PLAYABLE_CHAR_RE = /[\d xXhps^]/;
/** 段落标记：独立成行的 `[...]`（含中文） */
const SECTION_RE = /^\s*\[([^\]]+)\]\s*$/;
/** 键值对头部：`Key: Value` / `Key：Value`（全角冒号）/ `Key = Value`（大小写不敏感） */
const KV_RE = /^\s*([A-Za-z][A-Za-z ]*?)\s*[:：=]\s*(.*)$/;
/** 表头拍号识别：`3/4` 或 `4/4`；词边界避免误吃 `BPM 87/4` */
const TS_RE = /\b([34])\s*\/\s*4\b/;

/**
 * 技法字符的唯一真值源：用 `satisfies` 绑到 `Technique` 联合类型。
 * 若将来有人从 `Technique` 里删掉 `'h'`，这一行立刻编译报错（缺陷 7 的根治）。
 */
const TECHNIQUE_CHARS_ARRAY = ['h', 'p', 's', '^'] as const satisfies readonly Technique[];
const TECHNIQUE_CHARS: ReadonlySet<string> = new Set<string>(TECHNIQUE_CHARS_ARRAY);
/** 允许但无额外语义的字符：`-` 延音 / `~` 颤音占位 / `x` `X` 闷音 */
const ALLOWED_CHARS = new Set(['-', '~', 'x', 'X']);

/**
 * 起点裁剪时必须在音符起点之后保留的最小 tick 余量。
 *
 * 用途：溢出行（相对列 ≥ `colsPerMeasure`）的 `startTick` 被夹到
 * `per − START_GUARD_TICKS`，保证音符**不会落在小节末尾之后**、且仍留下可听时值。
 * 与「时值下限」是两件事 —— 后者已由「`durCols ≥ 1` ⇒ `durCols × ASCII_COL_TICKS ≥ 120`」
 * 结构性地保证，故不再需要单独的时值下限 clamp（见 `readBlockNotes`）。
 */
const START_GUARD_TICKS = 60;

/** 标题回退链保底值（长度 6，恒过 `validateTab` 的 1–120 长度检查） */
const FALLBACK_TITLE = '导入的六线谱';

/** 表头白名单键（小写归一后比较） */
const TITLE_KEYS = new Set(['title', 'song', 'song title']);
const ARTIST_KEYS = new Set(['artist', 'band', 'by']);
const TUNING_KEYS = new Set(['tuning']);
const BPM_KEYS = new Set(['bpm', 'tempo']);

/** 音名白名单（含升降号），用于 Tuning 解析 */
const NOTE_NAMES = new Set(['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B']);

interface AsciiNote {
  string: StringNumber;
  fret: number;
  /** 全局列号（该行内容区坐标） */
  col: number;
  /** 自身占用的列数：1（单位品位 / 闷音）或 2（两位数品位） */
  colSpan: number;
  durCols: number;
  techniques: Technique[];
}

// ── S1：行归一与分类 ──────────────────────────────────────────────

export type LineKind = 'kv' | 'section' | 'string' | 'blank' | 'other';

export interface StringInfo {
  label: StringNumber;
  family: 'letter' | 'digit';
}

export interface RawLine {
  /** 物理原始行（仅做 `\r\n` 归一与去尾空白） */
  raw: string;
  /** 去首尾空白后的文本 */
  trimmed: string;
  kind: LineKind;
  /** kind === 'kv' 时的键 / 值 */
  kvKey?: string;
  kvValue?: string;
  /** kind === 'section' 时的段落名（去方括号） */
  sectionName?: string;
  /** kind === 'string' 时的弦号信息 */
  stringInfo?: StringInfo;
  /**
   * kind === 'string' 时的**列坐标系内容区**（D2）：剥掉行首/行尾收口 `|` 与空白，
   * 保留弦内容区内部的 `|`（这些才是小节线）。
   */
  content: string;
  /**
   * kind === 'string' 时的**物理内容区**（未剥离行首/尾 `|`）。
   * 用于两处「剥离前」判定：块内是否含可演奏字符（RISK-1 ②）、单行块是否含 `|`（RISK-1 ④）。
   */
  physicalContent: string;
}

/** 判定字母族 / 数字族 */
export function isLetterLabel(c: string): boolean {
  return LETTER_LABELS.has(c);
}

export function isDigitLabel(c: string): boolean {
  return DIGIT_LABELS.has(c);
}

/** 归一化单行：`\r\n` 归一 + 去尾空白（保留行首缩进的语义，故只 trim 尾） */
function normalizeLine(line: string): string {
  return line.replace(/\r$/, '').replace(/\s+$/, '');
}

/**
 * 单行分类（互斥）。
 *
 * 判定顺序：blank → section → string → kv → other。
 * `string` 的判定含 RISK-1 ①：弦号 + 终止符（`|` 或空白）后接内容。
 * RISK-1 ②（块内至少一个可演奏字符）在 `groupAsciiBlocks` 的块级判定中执行 ——
 * 因为在真实谱面中「空弦行」(`E|--------|`) 是**合法且常见**的，逐行要求可演奏字符
 * 会把 6 弦块砍成残块。
 */
export function classifyLine(raw: string): RawLine {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { raw, trimmed, kind: 'blank', content: '', physicalContent: '' };
  }

  const sectionMatch = SECTION_RE.exec(raw);
  if (sectionMatch) {
    return {
      raw,
      trimmed,
      kind: 'section',
      sectionName: (sectionMatch[1] ?? '').trim(),
      content: '',
      physicalContent: '',
    };
  }

  const lineMatch = LINE_RE.exec(raw);
  if (lineMatch) {
    const symbol = lineMatch[1] ?? '';
    const physical = lineMatch[3] ?? '';
    const info: StringInfo = {
      label: LABEL_TO_STRING[symbol] as StringNumber,
      family: isDigitLabel(symbol) ? 'digit' : 'letter',
    };
    return {
      raw,
      trimmed,
      kind: 'string',
      stringInfo: info,
      // D2 列坐标系：剥掉行首/行尾收口 `|` 与空白，保留弦内容区（含中间 `|`）
      content: contentOf(physical),
      // 物理内容区（未剥离）——用于「块内是否含可演奏字符」与「单行块含 `|`」判定
      physicalContent: physical,
    };
  }

  const kvMatch = KV_RE.exec(raw);
  if (kvMatch) {
    return {
      raw,
      trimmed,
      kind: 'kv',
      kvKey: (kvMatch[1] ?? '').trim(),
      kvValue: (kvMatch[2] ?? '').trim(),
      content: '',
      physicalContent: '',
    };
  }

  return { raw, trimmed, kind: 'other', content: '', physicalContent: '' };
}

/**
 * D2 列坐标系：从物理内容区（`m[3]`）得到「列 0 起于第一个非 `|` 非空白字符」的内容区，
 * 且行尾在 FIRST_BAR 之前的 `|` 与空白被裁掉（trailing 收口）。
 *
 * 例：`'|--0---0-'` → `'--0---0-'`；`'---0--'` → `'---0--'`。
 */
export function contentOf(physical: string): string {
  // 起点：跳过全部连续的 `|` 与空白（含 tab）
  let start = 0;
  while (start < physical.length && (physical.charAt(start) === '|' || /\s/.test(physical.charAt(start)))) {
    start += 1;
  }
  let body = physical.slice(start);

  // 终点：裁掉尾部的 `|` 与空白（可能连续出现多组，如 `CELL|` 的收口）
  while (body.length > 0) {
    const last = body.charAt(body.length - 1);
    if (last === '|' || /\s/.test(last)) body = body.slice(0, -1);
    else break;
  }
  return body;
}

/** S1：文本 → RawLine[] */
export function normalizeAsciiLines(text: string): RawLine[] {
  return text.split(/\r?\n/).map((line) => classifyLine(normalizeLine(line)));
}

// ── S2：头部提取 ──────────────────────────────────────────────────

export interface AsciiHeader {
  title: string;
  artist?: string;
  tuning?: readonly ['E', 'A', 'D', 'G', 'B', 'E'];
  bpm?: number;
  /** 表头显式解析出的拍号；无则 null（由调用方回落 ts 参数） */
  tsFromHeader: TimeSignature | null;
  warnings: string[];
}

/**
 * 从表头行提取拍号。
 *
 * 只接受 `[4,4]` 与 `[3,4]`；`6/8` 等一律忽略返回 null（回落默认），
 * 否则会写出 `validateTab` 拒绝的拍号。
 */
export function parseTimeSignatureFromHeader(lines: readonly RawLine[]): TimeSignature | null {
  for (const line of lines) {
    const m = TS_RE.exec(line.raw);
    if (!m) continue;
    if (m[1] === '3') return [3, 4];
    if (m[1] === '4') return [4, 4];
  }
  return null;
}

/**
 * 解析 Tuning 值 → 标准调弦元组或 undefined。
 *
 * ⚠ 类型约束（实测 tsc TS2322）：`Tab.tuning` 的类型是 `readonly ['E','A','D','G','B','E']`，
 * 即**字面量元组**，每个位置只接受该字面量。因此除标准调弦外的任何调弦（含 `Drop D`）
 * 在类型层面**无法表达**，写进去会直接编译失败。
 * PRD §6.6 禁止改动 `types/tab.ts` 的既有字段语义，故这里只能：
 *   合法 6 音名且恰为 `E A D G B E` → 返回标准调弦；其余一律 undefined（调用方保持默认 + warning）。
 * 这是**类型系统的硬约束**，不是解析能力的偷懒。
 */
export function parseTuningValue(value: string): readonly ['E', 'A', 'D', 'G', 'B', 'E'] | undefined {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length === 0) return undefined;

  const parts = normalized.split(' ');
  if (parts.length !== 6) return undefined;
  for (const token of parts) {
    const name = token.charAt(0).toUpperCase() + token.slice(1);
    if (!NOTE_NAMES.has(name)) return undefined;
  }
  const upper = parts.map((t) => t.toUpperCase());
  if (upper.join(' ') === 'E A D G B E') return ['E', 'A', 'D', 'G', 'B', 'E'];
  return undefined;
}

/**
 * S2：只扫**第一个 string 行之前**的前导区，收白名单 KV、执行标题回退链、提取拍号。
 */
export function extractAsciiHeader(lines: readonly RawLine[]): AsciiHeader {
  const warnings: string[] = [];
  const leading: RawLine[] = [];
  for (const line of lines) {
    if (line.kind === 'string') break;
    leading.push(line);
  }

  let titleFromKey: string | undefined;
  let artist: string | undefined;
  let tuningRaw: string | undefined;
  let bpmFromKey: number | undefined;

  for (const line of leading) {
    if (line.kind !== 'kv') continue;
    const key = (line.kvKey ?? '').toLowerCase();
    const value = (line.kvValue ?? '').trim();

    if (TITLE_KEYS.has(key)) {
      if (titleFromKey === undefined && value.length > 0) titleFromKey = value;
      continue;
    }
    if (ARTIST_KEYS.has(key)) {
      if (artist === undefined && value.length > 0) artist = value;
      continue;
    }
    if (TUNING_KEYS.has(key)) {
      tuningRaw = value;
      continue;
    }
    if (BPM_KEYS.has(key)) {
      if (bpmFromKey === undefined && value.length > 0) {
        const n = Number(value);
        if (Number.isFinite(n)) bpmFromKey = clamp(Math.round(n), MIN_BPM, MAX_BPM);
      }
      continue;
    }
    // 白名单外的 KV（Album: / Copyright: …）→ 静默忽略，不置 partial（PRD R6）
  }

  // 标题回退链：Title: 值 → 前导区首个非空、非 KV、非段落标记行 → 保底文案
  let title = titleFromKey ?? '';
  if (title.length === 0) {
    for (const line of leading) {
      if (line.kind === 'other' && line.trimmed.length > 0) {
        title = line.trimmed;
        break;
      }
    }
  }
  title = title.slice(0, 120);
  if (title.length === 0) title = FALLBACK_TITLE;

  let tuning: readonly ['E', 'A', 'D', 'G', 'B', 'E'] | undefined;
  if (tuningRaw !== undefined) {
    tuning = parseTuningValue(tuningRaw);
    if (tuning === undefined) {
      // PRD R9：Tuning 无法解析 → 保持默认 + 结构化警告（不置 failedAt）
      warnings.push(COPY.asciiTuningUnparsed);
    }
  }

  const header: AsciiHeader = {
    title,
    tsFromHeader: parseTimeSignatureFromHeader(leading),
    warnings,
  };
  if (artist !== undefined) header.artist = artist.slice(0, 120);
  if (tuning !== undefined) header.tuning = tuning;
  if (bpmFromKey !== undefined) header.bpm = bpmFromKey;
  return header;
}

// ── S3：块分组 ────────────────────────────────────────────────────

export interface RawBlockLine {
  label: StringNumber;
  /** D2 列坐标系内容区（行首/尾收口 `|` 已剥离，内部 `|` 保留） */
  content: string;
  /** 物理内容区（未剥离）——用于 R1 的「本块是否含 `|`」判定 */
  physicalContent: string;
}

export interface RawBlock {
  lines: RawBlockLine[];
  /** 累积状态：上一个出现的段落标记（跨块延续，OP-5） */
  sectionLabel: string;
  /** 块首行在 lines 数组中的下标（调试 / failedAt 反查用） */
  firstLineIndex: number;
}

/**
 * S3：把**连续的** string 行聚成块。
 *
 * 关键规格（D8 / D8b）：
 *  - 1~6 行都合法，弦号允许跳号；块内弦号互异
 *  - 字母族与数字族不得同块混用
 *  - blank / other / kv / section 行**强制断块**（`io.test.ts:70` 的必要前提）
 *  - section 行同时更新「累积段落名」
 *  - 单行块额外要求内容含 `|`（挡 RISK-1 最坏误判）
 */
export function groupAsciiBlocks(lines: readonly RawLine[]): RawBlock[] {
  const blocks: RawBlock[] = [];
  const current: RawBlockLine[] = [];
  const currentLabels = new Set<StringNumber>();
  let currentKind: 'letter' | 'digit' | null = null;
  let currentHasPlayable = false;
  let currentHasBar = false;
  let currentFirstIndex = 0;
  let section = '';

  const commitRun = (): void => {
    if (current.length >= 1) {
      // RISK-1 ②：块内至少一个可演奏字符（音符 / 闷音 / 技法），纯 `---` 行组不构成块
      // RISK-1 ④：单行块额外要求该行含 `|`（挡「单行正文里恰好有数字」最坏误判）
      const playable = current.length === 1 ? currentHasPlayable && currentHasBar : currentHasPlayable;
      if (playable) {
        blocks.push({ lines: [...current], sectionLabel: section, firstLineIndex: currentFirstIndex });
      }
    }
    current.length = 0;
    currentLabels.clear();
    currentKind = null;
    currentHasPlayable = false;
    currentHasBar = false;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as RawLine;

    if (line.kind === 'section') {
      commitRun();
      section = line.sectionName ?? '';
      continue;
    }

    if (line.kind !== 'string' || !line.stringInfo) {
      // blank / other / kv 一律强制断块（A2/A5 的必要前提）
      commitRun();
      continue;
    }

    const info = line.stringInfo;
    const canJoin =
      currentKind === null ? true : currentKind === info.family && !currentLabels.has(info.label);

    if (!canJoin) commitRun();

    if (current.length === 0) currentFirstIndex = i;

    currentKind ??= info.family;
    currentLabels.add(info.label);
    currentHasPlayable = currentHasPlayable || PLAYABLE_CHAR_RE.test(line.physicalContent);
    currentHasBar = currentHasBar || line.physicalContent.includes('|');
    current.push({ label: info.label, content: line.content, physicalContent: line.physicalContent });
  }

  commitRun();
  return blocks;
}

// ── S4：小节切分（★核心） ─────────────────────────────────────────

export interface MeasureSegment {
  startCol: number;
  endCol: number;
}

export interface SplitResult {
  segments: MeasureSegment[];
  /** 各行段数不一致（RISK-3）→ partial，但不设 failedAt */
  partialByMismatch: boolean;
}

/** 收集内容区中所有 `|` 的列号（升序） */
export function collectBars(content: string): number[] {
  const bars: number[] = [];
  for (let i = 0; i < content.length; i += 1) {
    if (content.charAt(i) === '|') bars.push(i);
  }
  return bars;
}

/** 众数（出现次数最多者；并列取最小值） */
function modeMin(counts: readonly number[]): number {
  const freq = new Map<number, number>();
  for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
  let best = Number.POSITIVE_INFINITY;
  let bestFreq = -1;
  for (const [value, count] of freq) {
    if (count > bestFreq || (count === bestFreq && value < best)) {
      best = value;
      bestFreq = count;
    }
  }
  return Number.isFinite(best) ? best : 0;
}

/**
 * D3：在内容区上按 `|` 分段。
 *
 * `prev = b + 1` 且仅 `b > prev` 时 push —— 连续的 `||` 与行首 / 行尾 `|` 都不产生空小节。
 * `bars` 为空时退化为整段 `[0, len)`（D5）。
 */
function segmentsOf(content: string): MeasureSegment[] {
  const bars = collectBars(content);
  const segments: MeasureSegment[] = [];
  let prev = 0;
  for (const b of bars) {
    if (b > prev) segments.push({ startCol: prev, endCol: b });
    prev = b + 1;
  }
  if (content.length > prev) segments.push({ startCol: prev, endCol: content.length });
  if (segments.length === 0) segments.push({ startCol: 0, endCol: content.length });
  return segments;
}

/**
 * S4：把块切成小节段 —— 全局统一的「列 → 小节」映射表。
 *
 * D1：块内任一 string 行含 `|` → 整块走小节线模式；否则列数兜底模式（D6）。
 * D4：measureCount = mode(各行段数) 且并列取 min；第 m 小节列范围取各行第 m 段的**并集**。
 */
export function splitMeasures(block: RawBlock, colsPerMeasure: number): SplitResult {
  const contents: string[] = block.lines.map((l) => l.content);
  const blockWidth = contents.reduce((max, c) => Math.max(max, c.length), 0);
  // R1 的「块内任一弦行含 `|`」判定必须基于**物理**内容区：
  // `contentOf` 已把行首/尾收口 `|` 剥掉，而样例 B 这种「整行由首尾 `|` 包裹」的块
  // 其内容区恰好不含 `|` —— 若用 content 判定会误入 D6 列数兜底模式并被腰斩成 2 小节。
  const hasBar = block.lines.some((l) => l.physicalContent.includes('|') || l.content.includes('|'));

  if (!hasBar) {
    // D6 列数兜底模式（保持现有语义）
    const count = Math.max(1, Math.ceil(blockWidth / colsPerMeasure));
    const segments: MeasureSegment[] = [];
    for (let m = 0; m < count; m += 1) {
      segments.push({
        startCol: m * colsPerMeasure,
        endCol: Math.min(blockWidth, (m + 1) * colsPerMeasure),
      });
    }
    return { segments, partialByMismatch: false };
  }

  const perRow = contents.map((c) => segmentsOf(c));
  const counts = perRow.map((segs) => segs.length);
  const measureCount = Math.max(1, modeMin(counts));
  const partialByMismatch = counts.some((c) => c !== counts[0]);

  const segments: MeasureSegment[] = [];
  for (let m = 0; m < measureCount; m += 1) {
    const starts: number[] = [];
    const ends: number[] = [];
    for (const segs of perRow) {
      const seg = segs[m];
      if (!seg || seg.endCol <= seg.startCol) continue;
      starts.push(seg.startCol);
      ends.push(seg.endCol);
    }
    if (starts.length === 0) segments.push({ startCol: 0, endCol: 0 });
    else segments.push({ startCol: Math.min(...starts), endCol: Math.max(...ends) });
  }
  return { segments, partialByMismatch };
}

// ── S5：音符读取与时值收束 ────────────────────────────────────────

export interface BlockNotes {
  /** 每小节的音符（与 `splitMeasures` 的 segments 一一对应） */
  measureNotes: Note[][];
  partial: boolean;
  failedAt?: number;
  warnings: string[];
}

/** 行内 col 右侧最近的可能内容列距离（无则行尾 − col），用于 D11 的 h(p) */
function rightOfLine(content: string, segments: readonly MeasureSegment[], col: number): number {
  for (const seg of segments) {
    if (seg.startCol > col) return seg.startCol - col;
  }
  return content.length - col;
}

/** 读取单行字符流 → AsciiNote[] + 首个未识别字符的列号（无则 -1） */
function readLineNotes(
  line: RawBlockLine,
  segments: readonly MeasureSegment[],
): { notes: AsciiNote[]; unknownCol: number } {
  const notes: AsciiNote[] = [];
  const content = line.content;
  let last: AsciiNote | null = null;
  let unknownCol = -1;

  for (let col = 0; col < content.length; col += 1) {
    const c = content.charAt(col);
    if (c >= '0' && c <= '9') {
      // D10：最多 2 位合成一个品位，消费 2 列且不再回头重读
      const next = col + 1 < content.length ? content.charAt(col + 1) : '';
      let digits = c;
      let span = 1;
      if (next >= '0' && next <= '9') {
        digits += next;
        span = 2;
      }
      last = {
        string: line.label,
        fret: clamp(Number.parseInt(digits, 10), 0, MAX_FRET),
        col,
        colSpan: span,
        durCols: 1,
        techniques: [],
      };
      notes.push(last);
      col += span - 1;
      continue;
    }

    if (c === 'x' || c === 'X') {
      last = { string: line.label, fret: 0, col, colSpan: 1, durCols: 1, techniques: ['x'] };
      notes.push(last);
      continue;
    }

    if (TECHNIQUE_CHARS.has(c)) {
      if (last && !last.techniques.includes(c as Technique)) last.techniques.push(c as Technique);
      continue;
    }

    // 小节线 `|` 是结构字符，不是「未识别字符」（缺陷 1 的修复必须保证这点）
    if (c === '|') continue;

    if (!ALLOWED_CHARS.has(c) && unknownCol < 0) unknownCol = col;
  }

  // 时值在三步收束中统一计算（`readBlockNotes`，需要跨行视野）；
  // 此处只产出「位置 + 技法」，durCols 先置 1 占位。
  return { notes, unknownCol };
}

/** 块内单个音符的「行上下文」：所属行内容区与行内小节段表，供 ③ 的行尾兜底使用 */
interface BlockNoteRef {
  note: AsciiNote;
  lineContent: string;
  lineSegments: readonly MeasureSegment[];
}

/**
 * D11：时值三步收束（**块级**，需要跨行视野）。
 *
 * ① 同弦下一个音符列 − 当前列（同弦节奏间距）
 * ② 本小节右边界列 − 当前列（不越出小节）
 * ③ **块内任意弦**的下一个事件列 − 当前列（跨弦收束，避免一个音在其它弦先动时仍拖长）
 * 三者取最小，再夹到 `[1, ∞)` 列；tick 侧的 `MIN_NOTE_TICKS` 下限由 `readBlockNotes` 施加。
 *
 * ⚠ ③ 必须用**块内全部行**的音符集合：若只在行内找，跨弦音符永远找不到，
 * ③ 会退化成 ②（等价于「跨弦收束不存在」）。这是被 team-lead 独立探测出的阻断级缺陷。
 *
 * @param refs 块内全部音符（含其所属行上下文）
 */
export function computeDurationCols(refs: readonly BlockNoteRef[]): void {
  const all = refs.map((r) => r.note);

  for (const ref of refs) {
    const note = ref.note;

    // ① 同弦下一个音符
    let d1 = Number.POSITIVE_INFINITY;
    for (const other of all) {
      if (other.string !== note.string) continue;
      if (other.col <= note.col) continue;
      d1 = Math.min(d1, other.col - note.col);
    }

    // ② 本小节右边界（以**本音符所在行**的段表为准）
    const measure = ref.lineSegments.find((s) => note.col >= s.startCol && note.col < s.endCol);
    const measureBoundary = measure ? measure.endCol : ref.lineContent.length;
    const d2 = measureBoundary - note.col;

    // ③ 块内任意弦的下一个事件列
    //    排除「自身续位」：两位数品位占 col..col+colSpan-1，故需 col >= note.col + note.colSpan 才算下一个事件
    let d3 = Number.POSITIVE_INFINITY;
    for (const other of all) {
      if (other.col < note.col + note.colSpan) continue;
      if (other.col === note.col) continue;
      d3 = Math.min(d3, other.col - note.col);
    }
    // ③ 的行内兜底：块内无任何更右的事件时，用「行内下一段起点 / 行尾」收口
    if (!Number.isFinite(d3)) d3 = rightOfLine(ref.lineContent, ref.lineSegments, note.col);

    note.durCols = Math.max(1, Math.min(d1, d2, d3));
  }
}

/**
 * S5：块 → 各小节音符。
 *
 * 缺陷 4 / D6b 的关键：容量溢出由**两个独立触发源**判定。
 *  - S1 段宽溢出：某小节段宽 > colsPerMeasure
 *  - S2 起点越界：音符所在小节内相对列 >= colsPerMeasure
 * 二者缺一都会漏（样例 B 只命中 S1）。
 */
export function readBlockNotes(
  block: RawBlock,
  segments: readonly MeasureSegment[],
  per: number,
  colsPerMeasure: number,
): BlockNotes {
  const measureNotes: Note[][] = segments.map(() => []);
  const warnings: string[] = [];
  const noteOverflowMeasures: number[] = [];
  const overflowMeasures: number[] = [];
  const unknownMeasures: number[] = [];

  // ── 第一遍：收齐**块内全部行**的音符（③ 跨弦收束需要跨行视野） ──
  const refs: BlockNoteRef[] = [];
  for (const line of block.lines) {
    const { notes, unknownCol } = readLineNotes(line, segments);
    if (unknownCol >= 0) {
      // 未识别字符所在小节 = 包含该列的小节；不在任何段内时回退 0
      const idx = segments.findIndex((seg) => unknownCol >= seg.startCol && unknownCol < seg.endCol);
      unknownMeasures.push(idx >= 0 ? idx : 0);
    }
    for (const note of notes) {
      refs.push({ note, lineContent: line.content, lineSegments: segments });
    }
  }

  // ── 第二遍：块级统一做 D11 三步时值收束 ──
  computeDurationCols(refs);

  // ── 第三遍：落到各小节 ──
  for (const { note } of refs) {
    const m = segments.findIndex((seg) => note.col >= seg.startCol && note.col < seg.endCol);
    if (m < 0) continue;
    const seg = segments[m] as MeasureSegment;
    const relCol = note.col - seg.startCol;
    if (relCol >= colsPerMeasure) noteOverflowMeasures.push(m);

    // ① 起点裁剪：溢出行必须把起点收回小节内，并预留 START_GUARD_TICKS 余量。
    const maxStartGrid = per - START_GUARD_TICKS;
    const rawStart = relCol * ASCII_COL_TICKS;
    const gridStart = Math.round(Math.min(rawStart, maxStartGrid) / ASCII_COL_TICKS) * ASCII_COL_TICKS;
    const startTick = clamp(gridStart, 0, maxStartGrid);

    // ② 终点裁剪：上限夹到小节右界，防止音符越界。
    //    无「时值下限」clamp —— `durCols ≥ 1` 结构性地保证 `durCols × ASCII_COL_TICKS ≥ 120`，
    //    故天然满足任何 ≥ 60 的下限，显式下限分支永不触发（死代码），已删除。
    //    Hole-1 不变量由 asciiCoverageHoles.test.ts 的「无音符 durationTick < 120」用例锁定。
    const rightBound = per - startTick;
    const durationTick = clamp(note.durCols * ASCII_COL_TICKS, 0, Math.min(per, rightBound));

    (measureNotes[m] as Note[]).push({
      id: newId('n'),
      string: note.string,
      fret: note.fret,
      startTick,
      durationTick,
      velocity: note.techniques.includes('x') ? 0.5 : 0.75,
      techniques: [...note.techniques],
      confidence: 1,
      finger: null,
      stroke: 'P',
    });
  }

  // S1：段宽溢出
  for (let m = 0; m < segments.length; m += 1) {
    const seg = segments[m] as MeasureSegment;
    if (seg.endCol - seg.startCol > colsPerMeasure) overflowMeasures.push(m);
  }

  const candidates: number[] = [...overflowMeasures, ...noteOverflowMeasures, ...unknownMeasures];
  const partial = candidates.length > 0;
  const failedAt = partial ? Math.min(...candidates) : undefined;

  for (const notes of measureNotes) {
    notes.sort((a, b) => a.startTick - b.startTick || a.string - b.string);
  }

  const result: BlockNotes = { measureNotes, partial, warnings };
  if (failedAt !== undefined) result.failedAt = failedAt;
  return result;
}

// ── S6：组装 ──────────────────────────────────────────────────────

export interface ParsedAscii {
  // 既有字段（不改）
  title: string;
  measures: Measure[];
  partial: boolean;
  failedAt?: number;
  reason?: string;

  // 新增（向后兼容）
  /** 表头 Artist/Band/By 的值；未提供则 undefined（asciiToTab 回退 '未知'） */
  artist?: string;
  /** 表头 Tuning 解析结果（仅标准调弦）；无法解析时 undefined，Tab 保持默认 */
  tuning?: readonly ['E', 'A', 'D', 'G', 'B', 'E'];
  /** 表头 BPM/Tempo，已 clamp 到 [MIN_BPM, MAX_BPM]；未提供则 undefined */
  bpm?: number;
  /** 裁决后的拍号（表头 > ts 参数 > [4,4]），必填 */
  timeSignature: TimeSignature;
  /** 结构化警告，直接透传给 ImportResult.warnings */
  warnings?: string[];
}

/**
 * 宽松解析（PRD Q5），6 阶段流水线：
 * S1 normalizeLines → S2 extractHeader → S3 groupBlocks → S4 splitMeasures → S5 readBlockNotes → S6 assemble
 *
 * 保持**无 DOM 依赖**，可在 vitest node 环境直接单测。
 */
export function parseAscii(text: string, ts: TimeSignature = [4, 4]): ParsedAscii {
  // 缺陷 9：ASCII 无 File 维度，按字符数守卫（唯一文本入口，不可绕过）
  if (text.length > MAX_IMPORT_ASCII_CHARS) {
    return {
      title: FALLBACK_TITLE,
      measures: [],
      partial: false,
      reason: COPY.importAsciiTooLarge,
      timeSignature: ts,
    };
  }

  const lines = normalizeAsciiLines(text);
  const header = extractAsciiHeader(lines);

  // D7：拍号优先级 表头 X/Y > ts 参数 > [4,4]
  const timeSignature: TimeSignature = header.tsFromHeader ?? ts;
  const per = measureTicks(timeSignature);
  const colsPerMeasure = asciiColsPerMeasure(timeSignature);

  const blocks = groupAsciiBlocks(lines);

  if (blocks.length === 0) {
    const empty: ParsedAscii = {
      title: header.title,
      measures: [],
      partial: false,
      reason: COPY.notAsciiTab,
      timeSignature,
    };
    if (header.artist !== undefined) empty.artist = header.artist;
    if (header.bpm !== undefined) empty.bpm = header.bpm;
    if (header.tuning !== undefined) empty.tuning = header.tuning;
    if (header.warnings.length > 0) empty.warnings = [...header.warnings];
    return empty;
  }

  const measures: Measure[] = [];
  const warnings: string[] = [...header.warnings];
  let partial = false;
  let failedAt: number | undefined;

  for (const block of blocks) {
    const { segments, partialByMismatch } = splitMeasures(block, colsPerMeasure);
    const blockNotes = readBlockNotes(block, segments, per, colsPerMeasure);

    if (partialByMismatch) partial = true;
    if (blockNotes.partial) partial = true;

    for (let m = 0; m < segments.length; m += 1) {
      const globalIndex = measures.length;
      const notes = (blockNotes.measureNotes[m] ?? []).map((n) => ({ ...n }));
      measures.push({
        index: globalIndex,
        startTick: globalIndex * per,
        ticks: per,
        chords: [],
        notes,
        sectionLabel: block.sectionLabel,
      });
    }

    if (blockNotes.failedAt !== undefined) {
      const absolute = measures.length - segments.length + blockNotes.failedAt;
      failedAt = failedAt === undefined ? absolute : Math.min(failedAt, absolute);
    }
  }

  // warnings 去重
  const uniqueWarnings = [...new Set(warnings)];

  const parsed: ParsedAscii = {
    title: header.title,
    measures,
    partial,
    timeSignature,
  };
  if (failedAt !== undefined) parsed.failedAt = failedAt;
  if (header.artist !== undefined) parsed.artist = header.artist;
  if (header.tuning !== undefined) parsed.tuning = header.tuning;
  if (header.bpm !== undefined) parsed.bpm = header.bpm;
  if (uniqueWarnings.length > 0) parsed.warnings = uniqueWarnings;
  // R9：partial 时 reason 必须非空
  if (partial) parsed.reason = '部分字符未识别，已按延音处理';
  return parsed;
}

export function asciiToTab(text: string): ImportResult {
  const parsed = parseAscii(text);
  if (parsed.measures.length === 0) {
    return { ok: false, partial: false, parsedMeasures: 0, reason: parsed.reason ?? COPY.notAsciiTab };
  }

  const tab = createEmptyTab({
    title: parsed.title,
    // ★ 必须用 ?? '未知'：写 undefined 会让 validateTab 的 typeof !== 'string' 失败
    artist: parsed.artist ?? '未知',
    bpm: parsed.bpm ?? ASCII_DEFAULT_BPM,
    timeSignature: parsed.timeSignature,
    source: { type: 'imported', jobId: null, importer: 'ascii', confidence: null, engine: null },
  });
  if (parsed.tuning !== undefined) tab.tuning = parsed.tuning;
  tab.tracks[0].measures = parsed.measures;

  // 缺陷 8：ASCII 路径也走 validateTab（与 JSON 路径一致），防止畸形解析结果静默入库
  const valid = validateTab(tab);
  if (!valid.ok) {
    return {
      ok: false,
      partial: false,
      parsedMeasures: 0,
      reason: `${COPY.notAsciiTab}：${valid.errors.join('；')}`,
    };
  }

  const result: ImportResult = {
    ok: true,
    tab,
    partial: parsed.partial,
    parsedMeasures: parsed.measures.length,
  };
  if (parsed.failedAt !== undefined) result.failedAt = parsed.failedAt;
  if (parsed.partial) result.reason = parsed.reason ?? '部分字符未识别，已按延音处理';
  if (parsed.warnings !== undefined) result.warnings = parsed.warnings;
  return result;
}

export const asciiImporter: TabImporter = {
  id: 'ascii',
  label: 'ASCII 六线谱',
  accept: ['.txt', '.tab'],
  fromText: true,
  async parse(input) {
    const text = typeof input === 'string' ? input : await input.text();
    return asciiToTab(text);
  },
};

// ── JSON ──────────────────────────────────────────────────────────
export const jsonImporter: TabImporter = {
  id: 'json',
  label: 'Fretly JSON',
  accept: ['.json', '.fretly.json'],
  fromText: true,
  async parse(input) {
    const text = typeof input === 'string' ? input : await input.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, partial: false, parsedMeasures: 0, reason: COPY.notFretlyJson };
    }

    const result = validateTab(data);
    if (!result.ok) {
      return {
        ok: false,
        partial: false,
        parsedMeasures: 0,
        reason: `${COPY.notFretlyJson}：${result.errors.join('；')}`,
      };
    }

    const source = data as Tab;
    const now = nowIso();
    // 只生成新 id / 时间戳 / revision，其余字段（含 practice、markers）保持往返无损
    const next = createEmptyTab({
      ...source,
      id: newId('tab'),
      createdAt: now,
      updatedAt: now,
      revision: 1,
      source:
        source.source.type === 'builtin'
          ? { ...source.source, type: 'imported', importer: 'json' }
          : source.source,
    });

    return { ok: true, tab: next, partial: false, parsedMeasures: next.tracks[0]?.measures.length ?? 0 };
  },
};

// ── Guitar Pro 占位（PRD NG5，UI 不注册）─────────────────────────
export const gpImporter: TabImporter = {
  id: 'gp',
  label: 'Guitar Pro（未实现）',
  accept: ['.gp3', '.gp4', '.gp5'],
  fromText: false,
  async parse() {
    throw new AppError(ERROR_CODES.E_NOT_IMPLEMENTED, 'Guitar Pro 二进制解析本期未实现（PRD NG5）');
  },
};

export const IMPORTERS: readonly TabImporter[] = [jsonImporter, musicXmlImporter, asciiImporter];

export function importerById(id: string): TabImporter | undefined {
  return IMPORTERS.find((i) => i.id === id);
}
