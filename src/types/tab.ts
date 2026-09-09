/**
 * 谱面领域模型（PRD §5.2 / §5.3，架构 §4.1 / §4.2）。
 *
 * 两条最容易写反的约定，任何新增代码都必须遵守：
 *  1. `note.string`：1 = 高音 E（最细），6 = 低音 E（最粗）。
 *  2. `chord.diagram`：6 字符串，**index 0 = 6 弦（低音），index 5 = 1 弦（高音）**。
 *     两者方向相反，转换只能走 `src/core/fretboard.ts` 的 diagramIndexOf / stringOf。
 */

export type ISO = string;
export type TabId = `tab_${string}`;
export type JobId = `job_${string}`;
export type SessId = `ses_${string}`;
export type CollId = `col_${string}`;
export type NoteId = `n_${string}`;

export type StringNumber = 1 | 2 | 3 | 4 | 5 | 6;
export type DiagramIndex = 0 | 1 | 2 | 3 | 4 | 5;
export type Midi = number;
export type Tick = number;
export type Confidence = number;

export type KeyName =
  | 'C'
  | 'G'
  | 'D'
  | 'A'
  | 'E'
  | 'B'
  | 'F#'
  | 'Gb'
  | 'Db'
  | 'Ab'
  | 'Eb'
  | 'Bb'
  | 'F'
  | 'Am'
  | 'Em'
  | 'Bm'
  | 'F#m'
  | 'C#m'
  | 'G#m'
  | 'D#m'
  | 'A#m'
  | 'Fm'
  | 'Cm'
  | 'Gm'
  | 'Dm';

export type TimeSignature = [4, 4] | [3, 4];
export type Stroke = 'D' | 'U' | 'P' | 'X' | null;
export type Technique = 'h' | 'p' | 's' | 'x' | '^';
export type SourceType = 'builtin' | 'imported' | 'transcribed' | 'manual';
export type Difficulty = 1 | 2 | 3 | 4 | 5;

export interface TabSource {
  type: SourceType;
  jobId: JobId | null;
  importer: 'json' | 'musicxml' | 'ascii' | null;
  confidence: number | null;
  engine: 'local-heuristic-v1' | null;
}

export interface RhythmPatternRef {
  id: string | null;
  name: string;
  /** `{ "<measureIndex>": "<patternId>" }`，逐小节覆盖（D-14，P1） */
  overrides: Record<number, string>;
}

export interface Note {
  id: NoteId;
  /** 1 = 高音 E（最细），6 = 低音 E（最粗） */
  string: StringNumber;
  /** 0 = 空弦，最大 24 */
  fret: number;
  /** 相对**本小节起始**的 tick 偏移 */
  startTick: Tick;
  durationTick: number;
  velocity: number;
  techniques: Technique[];
  confidence: Confidence;
  finger: 1 | 2 | 3 | 4 | null;
  stroke: Stroke;
}

export interface ChordEvent {
  /** 相对**本小节起始**的 tick 偏移（不是全局 tick） */
  tick: Tick;
  name: string;
  /** 6 字符指位串，index 0 = 6 弦 */
  diagram: string;
  confidence: Confidence;
}

export interface Measure {
  index: number;
  /** 全局 tick */
  startTick: Tick;
  ticks: number;
  chords: ChordEvent[];
  notes: Note[];
  sectionLabel: string;
}

export interface Track {
  id: string;
  name: string;
  midiProgram: 25;
  channel: 0;
  isPercussion: false;
  volume: number;
  muted: false;
  measures: Measure[];
}

export interface Marker {
  id: string;
  /** 小节号（0 起） */
  measure: number;
  note: string;
  createdAt: ISO;
  /** 被"设为循环区"的次数 */
  loopCount: number;
}

export interface PracticeStats {
  mastery: number;
  /** null = 从未重算（首算不走 EMA） */
  masteryComputedAt: ISO | null;
  totalSeconds: number;
  sessions: number;
  lastPracticedAt: ISO | null;
  bestBpm: number;
  targetBpm: number;
  targetReachedAt: ISO | null;
  coveredMeasures: number[];
  roundsTotal: number;
  roundsPassed: number;
}

export interface Tab {
  schema: 'fretly.tab';
  schemaVersion: '1.1';
  id: TabId;
  title: string;
  artist: string;
  key: KeyName;
  capo: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /** 6 弦 → 1 弦 */
  tuning: readonly ['E', 'A', 'D', 'G', 'B', 'E'];
  bpm: number;
  timeSignature: TimeSignature;
  ticksPerBeat: 480;
  difficulty: Difficulty;
  difficultyOverride: Difficulty | null;
  tags: string[];
  source: TabSource;
  rhythmPattern: RhythmPatternRef;
  tracks: Track[];
  markers: Marker[];
  practice: PracticeStats;
  createdAt: ISO;
  updatedAt: ISO;
  revision: number;
}
