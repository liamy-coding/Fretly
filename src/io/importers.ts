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
import { AppError, COPY, ERROR_CODES, MAX_FRET, clamp, nowIso } from '@/core/constants';
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

const LINE_RE = /^\s*([eEBGDA]|[1-6])(\s*\|\s*|\s+)(.*)$/;
const TECHNIQUE_CHARS = new Set(['h', 'p', 's', '^', 'v']);
const ALLOWED_CHARS = new Set(['-', '~', 'x', 'X']);
const MIN_NOTE_TICKS = 60;

interface AsciiNote {
  string: StringNumber;
  fret: number;
  col: number;
  durCols: number;
  techniques: Technique[];
}

export interface ParsedAscii {
  title: string;
  measures: Measure[];
  partial: boolean;
  failedAt?: number;
  reason?: string;
}

/**
 * 宽松解析（PRD Q5）：
 *  - 识别 `e/B/G/D/A/E` 或 `1..6` 开头的 6 行块
 *  - 行首允许 `|`；未识别字符按 `-` 处理并计入"部分解析"
 *  - 不要求小节线对齐
 */
export function parseAscii(text: string, ts: TimeSignature = [4, 4]): ParsedAscii {
  const lines = text.split(/\r?\n/);

  // 标题：第一段非六线谱文本
  let title = '';
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    if (LINE_RE.test(line)) break;
    title = line.trim().slice(0, 120);
    break;
  }

  const blocks: { label: StringNumber; content: string }[][] = [];
  for (let i = 0; i + 6 <= lines.length; ) {
    const block: { label: StringNumber; content: string }[] = [];
    for (let j = 0; j < 6; j += 1) {
      const m = LINE_RE.exec(lines[i + j]);
      if (!m) break;
      const label = LABEL_TO_STRING[m[1]];
      if (label !== (j + 1) as StringNumber) break;
      // 去掉小节线与空白后按列对齐
      block.push({ label, content: m[3].replace(/[|\s]/g, '') });
    }
    if (block.length === 6) {
      blocks.push(block);
      i += 6;
    } else {
      i += 1;
    }
  }

  if (blocks.length === 0) {
    return { title, measures: [], partial: false, reason: COPY.notAsciiTab };
  }

  const colsPerMeasure = asciiColsPerMeasure(ts);
  const per = measureTicks(ts);
  const measures: Measure[] = [];
  let partial = false;
  let failedAt: number | undefined;

  for (const block of blocks) {
    const width = Math.max(...block.map((l) => l.content.length));
    const measureCount = Math.max(1, Math.ceil(width / colsPerMeasure));
    const rawNotes: AsciiNote[] = [];

    for (const line of block) {
      const content = line.content;
      let lastNote: AsciiNote | null = null;
      for (let col = 0; col < content.length; col += 1) {
        const c = content.charAt(col);
        if (c >= '0' && c <= '9') {
          // 两位数品位占两列
          let end = col;
          let digits = '';
          while (
            end < content.length &&
            content.charAt(end) >= '0' &&
            content.charAt(end) <= '9' &&
            digits.length < 2
          ) {
            digits += content.charAt(end);
            end += 1;
          }
          lastNote = {
            string: line.label,
            fret: clamp(Number.parseInt(digits, 10), 0, MAX_FRET),
            col,
            durCols: 1,
            techniques: [],
          };
          rawNotes.push(lastNote);
          col = end - 1;
        } else if (c === 'x' || c === 'X') {
          lastNote = {
            string: line.label,
            fret: 0,
            col,
            durCols: 1,
            techniques: ['x'],
          };
          rawNotes.push(lastNote);
        } else if (TECHNIQUE_CHARS.has(c)) {
          if (lastNote && !lastNote.techniques.includes(c as Technique)) {
            lastNote.techniques.push(c as Technique);
          }
        } else if (!ALLOWED_CHARS.has(c)) {
          // 未识别字符按 '-' 处理，并计入部分解析
          if (!partial) {
            partial = true;
            failedAt = measures.length + Math.floor(col / colsPerMeasure);
          }
        }
      }
    }

    // 时长：到下一个同弦音符的列差；最后一个延伸到行尾
    const byString = new Map<StringNumber, AsciiNote[]>();
    for (const n of rawNotes) {
      const list = byString.get(n.string) ?? [];
      list.push(n);
      byString.set(n.string, list);
    }
    for (const list of byString.values()) {
      list.sort((a, b) => a.col - b.col);
      for (let i = 0; i < list.length; i += 1) {
        const nextCol = i + 1 < list.length ? list[i + 1].col : width;
        list[i].durCols = Math.max(1, nextCol - list[i].col);
      }
    }

    for (let m = 0; m < measureCount; m += 1) {
      const startCol = m * colsPerMeasure;
      const endCol = Math.min(width, (m + 1) * colsPerMeasure);
      const notes: Note[] = [];
      for (const n of rawNotes) {
        if (n.col < startCol || n.col >= endCol) continue;
        const durationTick = clamp(
          Math.min(n.durCols * ASCII_COL_TICKS, (endCol - n.col) * ASCII_COL_TICKS),
          MIN_NOTE_TICKS,
          per,
        );
        notes.push({
          id: newId('n'),
          string: n.string,
          fret: n.fret,
          startTick: (n.col - startCol) * ASCII_COL_TICKS,
          durationTick,
          velocity: n.techniques.includes('x') ? 0.5 : 0.75,
          techniques: [...n.techniques],
          confidence: 1,
          finger: null,
          stroke: 'P',
        });
      }
      measures.push({
        index: measures.length,
        startTick: measures.length * per,
        ticks: per,
        chords: [],
        notes: notes.sort((a, b) => a.startTick - b.startTick || a.string - b.string),
        sectionLabel: '',
      });
    }
  }

  return {
    title: title.length > 0 ? title : '导入的六线谱',
    measures,
    partial,
    failedAt,
  };
}

export function asciiToTab(text: string): ImportResult {
  const parsed = parseAscii(text);
  if (parsed.measures.length === 0) {
    return { ok: false, partial: false, parsedMeasures: 0, reason: parsed.reason ?? COPY.notAsciiTab };
  }

  const tab = createEmptyTab({
    title: parsed.title,
    artist: '未知',
    bpm: ASCII_DEFAULT_BPM,
    timeSignature: [4, 4],
    source: { type: 'imported', jobId: null, importer: 'ascii', confidence: null, engine: null },
  });
  tab.tracks[0].measures = parsed.measures;

  return {
    ok: true,
    tab,
    partial: parsed.partial,
    parsedMeasures: parsed.measures.length,
    failedAt: parsed.failedAt,
    reason: parsed.partial ? '部分字符未识别，已按延音处理' : undefined,
  };
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
