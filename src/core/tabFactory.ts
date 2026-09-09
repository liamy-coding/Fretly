/**
 * Tab 工厂（PRD §5.2 / §5.5 / §8，架构 T-06）。
 *
 * ★ buildTabFromChordChart 是内置示范曲的**唯一**生成入口：
 *   内置曲只存「紧凑规格」（和弦进行 + 节奏型 id + 元数据），
 *   运行时展开成完整 Tab JSON，且与节奏引擎共用 expandPattern —— 不手写完整 JSON。
 */
import type {
  ChordEvent,
  Difficulty,
  ISO,
  KeyName,
  Measure,
  Note,
  PracticeStats,
  Tab,
  TabId,
  TimeSignature,
  Track,
} from '@/types/tab';
import type { ScheduledNote } from '@/types/app';
import {
  MAX_BPM,
  MAX_FRET,
  MIN_BPM,
  SCHEMA,
  SCHEMA_VERSION,
  TICKS_PER_BEAT,
  clamp,
  nowIso,
} from '@/core/constants';
import { newId } from '@/core/id';
import { diagramOf, isBarre } from '@/core/chords';
import { fretToMidi } from '@/core/fretboard';
import { expandPattern, getPattern } from '@/core/rhythm';
import { measureTicks } from '@/core/tick';

// ── 紧凑规格 ──────────────────────────────────────────────────────
export interface ChordChartEntry {
  /** 和弦名，须在 §7.4 和弦库内；不在库内时 diagram 取 'xxxxxx' */
  name: string;
  /** 持续小节数（可为 0.5，用于一小节两和弦） */
  measures: number;
  section?: string;
}

export interface ChordChartSpec {
  title: string;
  artist?: string;
  key: KeyName;
  capo?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  bpm: number;
  timeSignature: TimeSignature;
  patternId: string;
  tags?: string[];
  /** 内置曲显式声明难度（见下方「关于难度」注释） */
  difficulty?: Difficulty;
  progression: ChordChartEntry[];
}

export function emptyPractice(bpm: number): PracticeStats {
  return {
    mastery: 0,
    masteryComputedAt: null,
    totalSeconds: 0,
    sessions: 0,
    lastPracticedAt: null,
    bestBpm: 0,
    targetBpm: bpm,
    targetReachedAt: null,
    coveredMeasures: [],
    roundsTotal: 0,
    roundsPassed: 0,
  };
}

export function createEmptyTab(partial: Partial<Tab> = {}): Tab {
  const now: ISO = nowIso();
  const timeSignature: TimeSignature = partial.timeSignature ?? [4, 4];
  const bpm = partial.bpm ?? 90;
  const base: Tab = {
    schema: SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    id: partial.id ?? newId('tab'),
    title: partial.title ?? '未命名谱面',
    artist: partial.artist ?? '未知',
    key: partial.key ?? 'C',
    capo: 0,
    tuning: ['E', 'A', 'D', 'G', 'B', 'E'],
    bpm: clamp(Math.round(bpm), MIN_BPM, MAX_BPM),
    timeSignature,
    ticksPerBeat: TICKS_PER_BEAT,
    difficulty: 1,
    difficultyOverride: null,
    tags: [],
    source: { type: 'manual', jobId: null, importer: null, confidence: null, engine: null },
    rhythmPattern: { id: null, name: '', overrides: {} },
    tracks: [
      {
        id: newId('trk'),
        name: 'Guitar',
        midiProgram: 25,
        channel: 0,
        isPercussion: false,
        volume: 0.8,
        muted: false,
        measures: [],
      },
    ],
    markers: [],
    practice: emptyPractice(clamp(Math.round(bpm), MIN_BPM, MAX_BPM)),
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };
  return { ...base, ...partial, practice: partial.practice ?? base.practice };
}

export function cloneTab(tab: Tab): Tab {
  return JSON.parse(JSON.stringify(tab)) as Tab;
}

export function totalMeasuresOf(tab: Tab): number {
  return tab.tracks[0]?.measures.length ?? 0;
}

// ── 难度（PRD §5.5）───────────────────────────────────────────────
export interface DifficultyFactors {
  barreRatio: number;
  chordChangesDensity: number;
  speedRatio: number;
  techniqueDensity: number;
  D: number;
}

/**
 * D = 0.35 × barreRatio + 0.25 × chordChangesDensity + 0.25 × speedRatio + 0.15 × techniqueDensity
 * difficulty = clamp(round(1 + 4 × D), 1, 5)
 *   barreRatio         = 含横按和弦数 / 不同和弦总数
 *   chordChangesDensity= min(1, 和弦变化次数 / 小节数)
 *   speedRatio         = clamp((bpm − 60) / 120, 0, 1)
 *   techniqueDensity   = min(1, 带技巧音符数 / 总音符数)
 */
export function difficultyFactors(tab: Tab): DifficultyFactors {
  const measures = tab.tracks[0]?.measures ?? [];
  const totalMeasures = measures.length;

  const chordNames: string[] = [];
  let changes = 0;
  let prevName: string | null = null;
  for (const measure of measures) {
    for (const chord of measure.chords) {
      chordNames.push(chord.name);
      if (prevName !== null && chord.name !== prevName) changes += 1;
      prevName = chord.name;
    }
  }

  const distinct = new Set(chordNames);
  const barreCount = [...distinct].filter((n) => isBarre(n)).length;
  const barreRatio = distinct.size > 0 ? barreCount / distinct.size : 0;

  let totalNotes = 0;
  let techniqueNotes = 0;
  for (const measure of measures) {
    for (const note of measure.notes) {
      totalNotes += 1;
      if (note.techniques.length > 0) techniqueNotes += 1;
    }
  }

  const chordChangesDensity = totalMeasures > 0 ? Math.min(1, changes / totalMeasures) : 0;
  const speedRatio = clamp((tab.bpm - 60) / 120, 0, 1);
  const techniqueDensity = totalNotes > 0 ? Math.min(1, techniqueNotes / totalNotes) : 0;

  const D =
    0.35 * barreRatio +
    0.25 * chordChangesDensity +
    0.25 * speedRatio +
    0.15 * techniqueDensity;

  return { barreRatio, chordChangesDensity, speedRatio, techniqueDensity, D };
}

export function computeDifficulty(tab: Tab): Difficulty {
  const { D } = difficultyFactors(tab);
  return clamp(Math.round(1 + 4 * D), 1, 5) as Difficulty;
}

// ── 校验 ──────────────────────────────────────────────────────────
export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateTab(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ['谱面不是对象'] };

  if (input['schema'] !== SCHEMA) errors.push(`schema 必须为 "${SCHEMA}"`);
  const version = typeof input['schemaVersion'] === 'string' ? input['schemaVersion'] : '';
  if (version.split('.')[0] !== SCHEMA_VERSION.split('.')[0]) {
    errors.push(`schemaVersion 主版本必须为 ${SCHEMA_VERSION.split('.')[0]}`);
  }

  if (typeof input['id'] !== 'string' || input['id'].length === 0) errors.push('id 缺失');
  const title = typeof input['title'] === 'string' ? input['title'] : '';
  if (title.length < 1 || title.length > 120) errors.push('title 长度须在 1–120');
  if (typeof input['artist'] !== 'string') errors.push('artist 缺失');
  if (typeof input['key'] !== 'string') errors.push('key 缺失');

  const capo = Number(input['capo']);
  if (!Number.isInteger(capo) || capo < 0 || capo > 7) errors.push('capo 须为 0–7');

  const bpm = Number(input['bpm']);
  if (!Number.isFinite(bpm) || bpm < MIN_BPM || bpm > MAX_BPM) {
    errors.push(`bpm 须为 ${MIN_BPM}–${MAX_BPM}`);
  }

  const ts = input['timeSignature'];
  if (!Array.isArray(ts) || ts.length !== 2 || (ts[0] !== 4 && ts[0] !== 3) || ts[1] !== 4) {
    errors.push('timeSignature 只支持 [4,4] 与 [3,4]');
  }

  if (Number(input['ticksPerBeat']) !== TICKS_PER_BEAT) errors.push('ticksPerBeat 必须为 480');

  const tracks = input['tracks'];
  if (!Array.isArray(tracks) || tracks.length < 1) {
    errors.push('tracks 至少 1 条');
  } else {
    const measures = (tracks[0] as Record<string, unknown>)?.['measures'];
    if (!Array.isArray(measures)) errors.push('tracks[0].measures 缺失');
    else if (measures.length === 0) errors.push('谱面没有小节');
  }

  if (!isRecord(input['source'])) errors.push('source 缺失');
  if (!isRecord(input['practice'])) errors.push('practice 缺失');

  return { ok: errors.length === 0, errors };
}

export function assertValidTab(input: unknown): Tab {
  const result = validateTab(input);
  if (!result.ok) throw new Error(`[fretly:tabFactory] 谱面校验失败：${result.errors.join('；')}`);
  return input as Tab;
}

// ── 生成 ──────────────────────────────────────────────────────────
interface ChordSegment {
  name: string;
  diagram: string;
  start: number;
  end: number;
  section: string;
}

function buildSegments(progression: readonly ChordChartEntry[]): ChordSegment[] {
  const segments: ChordSegment[] = [];
  let pos = 0;
  for (const entry of progression) {
    const length = Math.max(0.25, entry.measures);
    segments.push({
      name: entry.name,
      diagram: diagramOf(entry.name),
      start: pos,
      end: pos + length,
      section: entry.section ?? '',
    });
    pos += length;
  }
  return segments;
}

/**
 * 紧凑规格 → 完整 Tab。
 * 与节奏引擎共用 expandPattern，因此内置曲同时是节奏引擎的自检用例。
 */
export function buildTabFromChordChart(spec: ChordChartSpec): Tab {
  const now: ISO = nowIso();
  const timeSignature = spec.timeSignature;
  const per = measureTicks(timeSignature);
  const pattern = getPattern(spec.patternId);
  if (!pattern) {
    console.warn(`[fretly:tabFactory] 未找到节奏型 ${spec.patternId}，回退到 strum_quarter`);
  }
  const patternUsed = pattern ?? getPattern('strum_quarter');
  const patternId = patternUsed?.id ?? 'strum_quarter';
  const patternName = patternUsed?.name ?? '四分全下扫';
  const patternText = patternUsed?.pattern ?? 'D-D-D-D-';

  const segments = buildSegments(spec.progression);
  const totalMeasures = Math.max(1, Math.ceil(segments.length > 0 ? segments[segments.length - 1].end : 1));
  const bpm = clamp(Math.round(spec.bpm), MIN_BPM, MAX_BPM);

  const measures: Measure[] = [];
  for (let m = 0; m < totalMeasures; m += 1) {
    const chords: ChordEvent[] = [];
    let notes: Note[] = [];
    let sectionLabel = '';

    for (const seg of segments) {
      const overlapStart = Math.max(seg.start, m);
      const overlapEnd = Math.min(seg.end, m + 1);
      if (overlapEnd - overlapStart <= 1e-9) continue;

      const segStartTick = Math.round((overlapStart - m) * per);
      const segTicks = Math.round((overlapEnd - m) * per) - segStartTick;

      chords.push({
        tick: segStartTick,
        name: seg.name,
        diagram: seg.diagram,
        confidence: 1,
      });

      if (seg.start <= m && seg.end > m && sectionLabel === '') sectionLabel = seg.section;

      notes = notes.concat(
        expandPattern({
          diagram: seg.diagram,
          pattern: patternText,
          segStartTick,
          segTicks,
          bpm,
        }),
      );
    }

    measures.push({
      index: m,
      startTick: m * per,
      ticks: per,
      chords,
      notes: notes.sort((a, b) => a.startTick - b.startTick || a.string - b.string),
      sectionLabel,
    });
  }

  const track: Track = {
    id: newId('trk'),
    name: 'Guitar',
    midiProgram: 25,
    channel: 0,
    isPercussion: false,
    volume: 0.8,
    muted: false,
    measures,
  };

  const tab: Tab = {
    schema: SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    id: newId('tab'),
    title: spec.title,
    artist: spec.artist ?? '弦格 Fretly',
    key: spec.key,
    capo: spec.capo ?? 0,
    tuning: ['E', 'A', 'D', 'G', 'B', 'E'],
    bpm,
    timeSignature,
    ticksPerBeat: TICKS_PER_BEAT,
    difficulty: 1,
    difficultyOverride: null,
    tags: spec.tags ?? [],
    source: { type: 'builtin', jobId: null, importer: null, confidence: null, engine: null },
    rhythmPattern: { id: patternId, name: patternName, overrides: {} },
    tracks: [track],
    markers: [],
    practice: emptyPractice(bpm),
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };

  // 关于难度：computeDifficulty 严格实现 §5.5 公式；内置示范曲以 §8 设计的星级为准
  // （两者对本 4 首的计算结果不一致，详见交付说明），spec 未声明时才回退到公式。
  tab.difficulty = spec.difficulty ?? computeDifficulty(tab);
  return tab;
}

/** 用指定节奏型重生成某一小节的音符（编辑器「替换和弦 / 换模板」复用） */
export function regenerateMeasure(tab: Tab, measureIndex: number, patternId: string): Tab {
  const measure = tab.tracks[0]?.measures[measureIndex];
  if (!measure) return tab;
  const pattern = getPattern(patternId);
  if (!pattern) return tab;

  const notes: Note[] = [];
  const per = measure.ticks;
  for (let ci = 0; ci < measure.chords.length; ci += 1) {
    const chord = measure.chords[ci];
    const segStartTick = chord.tick;
    const segEndTick = ci + 1 < measure.chords.length ? measure.chords[ci + 1].tick : per;
    notes.push(
      ...expandPattern({
        diagram: chord.diagram,
        pattern: pattern.pattern,
        segStartTick,
        segTicks: Math.max(1, segEndTick - segStartTick),
        bpm: tab.bpm,
      }),
    );
  }

  const next = cloneTab(tab);
  const target = next.tracks[0].measures[measureIndex];
  target.notes = notes.sort((a, b) => a.startTick - b.startTick || a.string - b.string);
  next.rhythmPattern = {
    ...next.rhythmPattern,
    id: patternId,
    name: pattern.name,
    overrides: { ...next.rhythmPattern.overrides, [measureIndex]: patternId },
  };
  next.revision += 1;
  next.updatedAt = nowIso();
  return next;
}

/** 用节奏型铺满全部小节（D-06「应用到全部并生成谱面」，一步撤销） */
export function regenerateAllMeasures(tab: Tab, patternId: string): Tab {
  let next = cloneTab(tab);
  for (let i = 0; i < (next.tracks[0]?.measures.length ?? 0); i += 1) {
    next = regenerateMeasure(next, i, patternId);
  }
  return next;
}

// ── 播放用扁平化 ──────────────────────────────────────────────────
export interface FlatNote {
  note: Note;
  measureIndex: number;
  /** 全局 tick */
  globalTick: number;
}

export function flattenNotes(tab: Tab): FlatNote[] {
  const out: FlatNote[] = [];
  for (const measure of tab.tracks[0]?.measures ?? []) {
    for (const note of measure.notes) {
      out.push({ note, measureIndex: measure.index, globalTick: measure.startTick + note.startTick });
    }
  }
  return out.sort((a, b) => a.globalTick - b.globalTick || a.note.string - b.note.string);
}

/** Tab → Transport 需要的 ScheduledNote[]（tick 用全局，midi 由 (弦, 品) 换算） */
export function tabToScheduledNotes(tab: Tab): ScheduledNote[] {
  return flattenNotes(tab).map(({ note, globalTick }) => ({
    tick: globalTick,
    midi: fretToMidi(note.string, Math.min(note.fret, MAX_FRET)),
    velocity: note.velocity,
    durationTick: note.durationTick,
    string: note.string,
    fret: note.fret,
    noteId: note.id,
    stroke: note.stroke,
  }));
}

export function totalTicksOfTab(tab: Tab): number {
  const measures = tab.tracks[0]?.measures ?? [];
  return measures.reduce((sum, m) => sum + m.ticks, 0);
}

export type { TabId };
