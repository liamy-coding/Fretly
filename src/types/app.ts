/**
 * 应用层模型与服务接口（PRD §5.4，架构 §4.3 / §4.4）。
 * 本文件只放类型：core 纯逻辑不依赖这里的实现，依赖倒置由各层注入。
 */
import type {
  Confidence,
  Difficulty,
  ISO,
  JobId,
  KeyName,
  Midi,
  NoteId,
  SessId,
  Stroke,
  StringNumber,
  Tab,
  TabId,
  Tick,
  TimeSignature,
} from '@/types/tab';

export type CollId = `col_${string}`;

export interface PracticeSession {
  id: SessId;
  tabId: TabId;
  startedAt: ISO;
  endedAt: ISO;
  /** 仅"播放中"累计的秒数（暂停不计） */
  effectiveSeconds: number;
  /** effectiveSeconds >= 300 */
  counted: boolean;
  startBpm: number;
  endBpm: number;
  rounds: number;
  passedRounds: number;
  progressiveUsed: boolean;
  coveredMeasures: number[];
}

export interface Collection {
  id: CollId;
  name: string;
  tabIds: TabId[];
  createdAt: ISO;
}

export type JobStatus = 'processing' | 'draft' | 'archived' | 'failed' | 'interrupted';
export type StageKey = 'decode' | 'onset' | 'pitch' | 'chroma' | 'beat' | 'dp' | 'assemble';

export interface TranscriptionJob {
  id: JobId;
  status: JobStatus;
  sourceName: string;
  sourceType: 'file' | 'mic';
  durationSec: number;
  instrument: 'solo' | 'accompaniment';
  progress: number;
  stage: StageKey | '';
  avgConfidence: number | null;
  rightsConfirmed: boolean;
  hasAudio: boolean;
  /** 每 512 采样一对 [min, max] ∈ [-1,1] */
  peaks: [number, number][];
  resultTabId: TabId | null;
  createdAt: ISO;
  updatedAt: ISO;
}

export interface MetronomeSettings {
  enabled: boolean;
  subdivision: '1/4' | '1/8' | '1/16';
  countIn: boolean;
  voice: boolean;
}

export interface Settings {
  libraryView: 'grid' | 'list';
  defaultStartRatio: number;
  defaultStep: 3 | 5 | 10;
  defaultPassRounds: 1 | 2 | 3;
  defaultTargetRatio: number;
  metronome: MetronomeSettings;
  demoTrack: { enabled: boolean; volume: number };
  showFingerNumbers: boolean;
  seeded: boolean;
  disclaimerAcked: boolean;
}

export interface PendingItem {
  /** `${kind}:${measureIndex}:${noteId|tick}` */
  id: string;
  kind: 'note' | 'chord' | 'rhythm';
  measureIndex: number;
  noteId?: NoteId;
  confidence: number;
  confirmed: boolean;
  /** Top3 候选（按 DP 代价升序） */
  candidates?: { string: StringNumber; fret: number; cost: number }[];
}

export interface TranscriptionResult {
  tab: Tab;
  avgConfidence: number;
  /** 派生：confidence < 0.45 的条目 */
  pending: PendingItem[];
  peaks: [number, number][];
  durationSec: number;
  stageTimings: { stage: StageKey; ms: number }[];
}

// ── 扒谱 Provider（端口） ──────────────────────────────────────────
export interface TranscribeInput {
  /** 16 kHz mono，已归一化；所有权将 transfer 给 Worker */
  pcm: Float32Array;
  sampleRate: 16000;
  durationSec: number;
  peaks: [number, number][];
}

export interface TranscribeOptions {
  instrument: 'solo' | 'accompaniment';
  keyHint?: KeyName | 'auto';
  jobId: JobId;
}

export interface TranscribeProgress {
  stage: StageKey;
  pct: number;
  label: string;
}

export interface TranscriptionProvider {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  transcribe(
    input: TranscribeInput,
    opts: TranscribeOptions,
    onProgress: (p: TranscribeProgress) => void,
  ): Promise<TranscriptionResult>;
  cancel(jobId: JobId): void;
}

// ── Transport（唯一时间与 tempo 真相源） ───────────────────────────
export interface ScheduledNote {
  /** 全局 tick */
  tick: Tick;
  midi: Midi;
  velocity: number;
  durationTick: Tick;
  string: StringNumber;
  fret: number;
  noteId?: NoteId;
  stroke?: Stroke;
}

export interface BeatInfo {
  tick: Tick;
  index: number;
  accent: boolean;
  subdivision: 1 | 2 | 4;
}

export interface TransportEvent {
  kind: 'note' | 'beat' | 'end';
  tick: Tick;
  /** AudioContext 绝对时间（秒） */
  when: number;
  note?: ScheduledNote;
  beat?: BeatInfo;
}

export interface BoundaryEvent {
  kind: 'measure' | 'roundEnd' | 'end' | 'tempoApplied';
  tick: Tick;
  measureIndex: number;
  bpm: number;
}

export interface TransportLoadOptions {
  bpm: number;
  timeSignature: TimeSignature;
  ticksPerBeat: 480;
  totalTicks: Tick;
  loop: { start: Tick; end: Tick } | null;
}

export interface Transport {
  load(notes: ScheduledNote[], opts: TransportLoadOptions): void;
  /** countInBars > 0 时从负 tick 起播，只发节拍不出音符 */
  play(fromTick?: Tick, opts?: { countInBars?: number }): Promise<void>;
  pause(): void;
  stop(): void;
  seek(tick: Tick): void;
  /** 默认在下一个小节线生效（渐进加速提速）；immediate = true 用于拖变速滑块 */
  setTempo(bpm: number, opts?: { immediate?: boolean }): void;
  setLoop(range: { start: Tick; end: Tick } | null): void;
  setSubdivision(sub: 1 | 2 | 4): void;
  /** 唯一调度出口：Metronome / DemoTrack 都从这里拿 (事件, when) */
  onSchedule(cb: (e: TransportEvent) => void): () => void;
  /** 低频事件（跨小节 / 一轮结束 / 结束），供 React setState 用 */
  onBoundary(cb: (e: BoundaryEvent) => void): () => void;
  readonly currentTick: Tick;
  readonly currentBpm: number;
  /** 当前小节号（由 currentTick 派生），与播放头/高亮同源 */
  readonly currentMeasure: number;
  readonly isPlaying: boolean;
  dispose(): void;
}

// ── 合成器 ────────────────────────────────────────────────────────
export interface Synth {
  readonly ready: boolean;
  ensureContext(): Promise<void>;
  pluck(o: { midi: Midi; velocity: number; when?: number; durationSec?: number }): void;
  rake(notes: { midi: Midi; velocity: number; offsetSec: number; durationSec: number }[]): void;
  click(o: { when: number; accent: boolean; freq?: number }): void;
  setBusGain(bus: 'master' | 'metronome' | 'demo', v: number): void;
  dispose(): void;
}

// ── 持久化 ────────────────────────────────────────────────────────
export interface TabMeta {
  id: TabId;
  title: string;
  artist: string;
  key: KeyName;
  bpm: number;
  timeSignature: TimeSignature;
  difficulty: Difficulty;
  difficultyOverride: Difficulty | null;
  source: Tab['source'];
  tags: string[];
  mastery: number;
  lastPracticedAt: ISO | null;
  createdAt: ISO;
  updatedAt: ISO;
}

export interface TabRepository {
  list(): Promise<TabMeta[]>;
  get(id: TabId): Promise<Tab | undefined>;
  /** revision + 1，updatedAt = now */
  put(tab: Tab): Promise<Tab>;
  /** 同时从所有歌单移除 */
  remove(id: TabId): Promise<void>;
  patchPractice(id: TabId, patch: Partial<Tab['practice']>): Promise<void>;
  collections(): Promise<Collection[]>;
  putCollection(c: Collection): Promise<void>;
  removeCollection(id: CollId): Promise<void>;
  listSessions(from?: ISO, to?: ISO): Promise<PracticeSession[]>;
  putSession(s: PracticeSession): Promise<void>;
}

// ── 导入器 ────────────────────────────────────────────────────────
export interface ImportResult {
  ok: boolean;
  tab?: Tab;
  /** 部分解析（可为 UI 提供「保留可解析部分继续导入」） */
  partial: boolean;
  parsedMeasures: number;
  failedAt?: number;
  reason?: string;
  warnings?: string[];
}

export interface TabImporter {
  id: 'json' | 'musicxml' | 'ascii' | 'gp';
  label: string;
  accept: string[];
  /** ASCII 走粘贴 */
  fromText: boolean;
  parse(input: string | File): Promise<ImportResult>;
}

export interface ConfidenceLike {
  confidence: Confidence;
}
