/**
 * Worker 入口（架构 §2.6 文件 27，T-13）：消息循环 + 7 阶段编排 + 结果组装。
 *
 * Worker 内没有任何浏览器 Audio API（R4），pcm 由主线程 decodeToMono16k 后
 * 经 postMessage(..., [pcm.buffer]) transfer 进来。
 *
 * 阶段权重：decode 10 / onset 15 / pitch 25 / chroma 20 / beat 10 / dp 15 / assemble 5。
 */
import type { PendingItem, TranscriptionResult } from '@/types/app';
import type { ChordEvent, JobId, Note, Tab, TimeSignature } from '@/types/tab';
import { MAX_FRET, LOCAL_ENGINE_ID, clamp, nowIso, round2 } from '@/core/constants';
import { diagramOf } from '@/core/chords';
import { computeDifficulty, createEmptyTab } from '@/core/tabFactory';
import { measureTicks } from '@/core/tick';
import { newId } from '@/core/id';
import type {
  WorkerDoneMessage,
  WorkerErrorMessage,
  WorkerProgressMessage,
  WorkerRequest,
  WorkerRunRequest,
} from '@/transcribe/provider';
import { STAGE_LABELS, STAGE_WEIGHTS } from '@/transcribe/provider';
import { decodePcm, qualityGate } from '@/transcribe/worker/decode';
import {
  computeOnsets,
  identifyChords,
  pitchFrames,
  toNoteEvents,
  estimateBeat,
} from '@/transcribe/worker/analysis';
import { solveFretboard, type DpResultNote } from '@/transcribe/worker/fretboardDP';
import type { NoteEvent } from '@/transcribe/worker/analysis';

// Worker 上下文（避免直接依赖 DOM 的 Worker 类型声明细节）
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (msg: WorkerResponseLike) => void;
};

type WorkerResponseLike = WorkerProgressMessage | WorkerDoneMessage | WorkerErrorMessage;

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  if (!req || req.type !== 'run') return;
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  void runPipeline(req).then(
    (result) => {
      const msg: WorkerDoneMessage = { type: 'done', jobId: req.opts.jobId, result };
      ctx.postMessage(msg);
    },
    (err: unknown) => {
      const msg: WorkerErrorMessage = {
        type: 'error',
        jobId: req.opts.jobId,
        message: err instanceof Error ? err.message : String(err),
      };
      ctx.postMessage(msg);
    },
  );
};

function postProgress(jobId: string, stage: WorkerProgressMessage['progress']['stage'], pct: number): void {
  const progress = {
    stage,
    pct: clamp(Math.round(pct), 0, 100),
    label: STAGE_LABELS[stage],
  };
  const msg: WorkerProgressMessage = { type: 'progress', progress };
  ctx.postMessage(msg);
}

/** 单段进度 → 全流程百分比（按阶段权重线性映射） */
function overallPct(stageOrder: readonly WorkerProgressMessage['progress']['stage'][], idx: number, inner: number): number {
  let before = 0;
  for (let i = 0; i < idx; i += 1) before += STAGE_WEIGHTS[stageOrder[i]];
  return before + STAGE_WEIGHTS[stageOrder[idx]] * (inner / 100);
}

const STAGE_ORDER = ['decode', 'onset', 'pitch', 'chroma', 'beat', 'dp', 'assemble'] as const;

async function runPipeline(req: WorkerRunRequest): Promise<TranscriptionResult> {
  const timings: { stage: (typeof STAGE_ORDER)[number]; ms: number }[] = [];
  const pcm = req.pcm;

  // ① decode
  const t0 = Date.now();
  const gate = qualityGate(pcm);
  if (!gate.ok) {
    throw new Error(`质量预判未通过：${gate.reason}`);
  }
  const decoded = decodePcm(pcm, req.sampleRate);
  timings.push({ stage: 'decode', ms: Date.now() - t0 });
  postProgress(req.opts.jobId, 'decode', overallPct(STAGE_ORDER, 0, 100));

  const analysisPcm = decoded.pcm;
  const durationSec = analysisPcm.length / req.sampleRate;

  // ② onset
  const t1 = Date.now();
  const onsets = computeOnsets(analysisPcm, req.sampleRate, { instrument: req.opts.instrument });
  timings.push({ stage: 'onset', ms: Date.now() - t1 });
  postProgress(req.opts.jobId, 'onset', overallPct(STAGE_ORDER, 1, 100));

  // ③ pitch
  const t2 = Date.now();
  const frames = pitchFrames(analysisPcm, req.sampleRate);
  const noteEvents = toNoteEvents(frames);
  timings.push({ stage: 'pitch', ms: Date.now() - t2 });
  postProgress(req.opts.jobId, 'pitch', overallPct(STAGE_ORDER, 2, 100));

  // ④ chroma + 和弦 Viterbi
  const t3 = Date.now();
  const chordSegs = identifyChords(noteEvents, durationSec, { instrument: req.opts.instrument, keyHint: req.opts.keyHint });
  timings.push({ stage: 'chroma', ms: Date.now() - t3 });
  postProgress(req.opts.jobId, 'chroma', overallPct(STAGE_ORDER, 3, 100));

  // ⑤ beat / 拍号
  const t4 = Date.now();
  const beat = estimateBeat(analysisPcm, req.sampleRate, onsets);
  timings.push({ stage: 'beat', ms: Date.now() - t4 });
  postProgress(req.opts.jobId, 'beat', overallPct(STAGE_ORDER, 4, 100));

  // ⑥ 指板 DP
  const t5 = Date.now();
  const dpResults = solveFretboard(noteEvents, {
    chordSegs,
    accompaniment: req.opts.instrument === 'accompaniment',
    maxFret: MAX_FRET,
  });
  timings.push({ stage: 'dp', ms: Date.now() - t5 });
  postProgress(req.opts.jobId, 'dp', overallPct(STAGE_ORDER, 5, 100));

  // ⑦ assemble
  const t6 = Date.now();
  const result = assembleTab({
    noteEvents,
    dpResults,
    chordSegs,
    beat,
    durationSec,
    peaks: req.peaks,
    jobId: req.opts.jobId,
    instrument: req.opts.instrument,
    keyHint: req.opts.keyHint,
  });
  timings.push({ stage: 'assemble', ms: Date.now() - t6 });
  postProgress(req.opts.jobId, 'assemble', overallPct(STAGE_ORDER, 6, 100));

  return {
    ...result,
    stageTimings: timings.map((t) => ({ stage: t.stage, ms: t.ms })),
  };
}

// ── ⑦ 组装 ────────────────────────────────────────────────────────
interface AssembleInput {
  noteEvents: NoteEvent[];
  dpResults: DpResultNote[];
  chordSegs: { startSec: number; endSec: number; name: string; confidence: number; alts: { name: string; score: number }[] }[];
  beat: { bpm: number; timeSignature: [4, 4] | [3, 4]; firstBeatSec: number };
  durationSec: number;
  peaks: [number, number][];
  jobId: JobId;
  instrument: 'solo' | 'accompaniment';
  keyHint?: string;
}

export function assembleTab(input: AssembleInput): Omit<TranscriptionResult, 'stageTimings'> {
  const { noteEvents, dpResults, chordSegs, beat, durationSec, peaks, jobId, instrument } = input;
  const bpm = clamp(beat.bpm, 40, 240);
  const ts: TimeSignature = beat.timeSignature;
  const per = measureTicks(ts);
  const tps = (bpm * 480) / 60; // ticks per second
  const measureSec = per / tps;

  const totalMeasures = Math.max(1, Math.ceil(Math.max(0, durationSec - beat.firstBeatSec) / measureSec));
  const chordsByMeasure = new Map<number, ChordEvent[]>();
  const notesByMeasure = new Map<number, Note[]>();
  const pending: PendingItem[] = [];

  const dpIndex = new Map<number, DpResultNote>();
  dpResults.forEach((r) => dpIndex.set(r.index, r));

  const measureIndexOfEvent = (tSec: number): number => {
    const rel = tSec - beat.firstBeatSec;
    if (rel < 0) return -1;
    return Math.floor(rel / measureSec);
  };

  // 和弦
  for (const seg of chordSegs) {
    const startMeasure = Math.max(0, measureIndexOfEvent(seg.startSec));
    const endMeasure = Math.min(totalMeasures - 1, measureIndexOfEvent(seg.endSec - 1e-3));
    for (let m = startMeasure; m <= endMeasure; m += 1) {
      if (m < 0) continue;
      const mStart = beat.firstBeatSec + m * measureSec;
      const chordStart = Math.max(seg.startSec, mStart);
      const tick = clamp(Math.round((chordStart - mStart) * tps), 0, per - 1);
      const name = chordNameForTab(seg.name);
      const diagram = diagramOf(name);
      const entry: ChordEvent = { tick, name, diagram, confidence: round2(seg.confidence) };
      const list = chordsByMeasure.get(m) ?? [];
      list.push(entry);
      chordsByMeasure.set(m, list);
      if (entry.confidence < 0.45) {
        pending.push({ id: `chord:${m}:${tick}`, kind: 'chord', measureIndex: m, confidence: entry.confidence, confirmed: false });
      }
    }
  }

  // 音符
  noteEvents.forEach((ev, evIndex) => {
    const r = dpIndex.get(evIndex);
    if (!r) return;
    if (r.dropped) {
      const m = measureIndexOfEvent(ev.startSec);
      if (m >= 0) {
        pending.push({
          id: `rhythm:${m}:${Math.round((ev.startSec - (beat.firstBeatSec + m * measureSec)) * tps)}`,
          kind: 'rhythm',
          measureIndex: m,
          confidence: 0.2,
          confirmed: false,
          candidates: [],
        });
      }
      return;
    }
    const m = measureIndexOfEvent(ev.startSec);
    if (m < 0 || m >= totalMeasures) return;
    const mStart = beat.firstBeatSec + m * measureSec;
    const startTick = clamp(Math.round((ev.startSec - mStart) * tps), 0, per - 1);
    const durationTick = Math.max(60, Math.round((ev.endSec - ev.startSec) * tps));
    const note: Note = {
      id: newId('n'),
      string: r.string,
      fret: Math.max(0, Math.min(r.fret, MAX_FRET)),
      startTick,
      durationTick: Math.min(durationTick, per - startTick),
      velocity: 0.75,
      techniques: [],
      confidence: round2(r.confidence),
      finger: null,
      stroke: 'P',
    };
    const list = notesByMeasure.get(m) ?? [];
    list.push(note);
    notesByMeasure.set(m, list);
    if (note.confidence < 0.45) {
      pending.push({
        id: `note:${m}:${note.id}`,
        kind: 'note',
        measureIndex: m,
        noteId: note.id,
        confidence: note.confidence,
        confirmed: false,
        candidates: r.candidates.slice(0, 3).map((c) => ({ string: c.string, fret: c.fret, cost: c.cost })),
      });
    }
  });

  // 组装 Tab
  const tab = createEmptyTab({});
  tab.title = instrument === 'solo' ? '扒谱初稿 · 独奏' : '扒谱初稿 · 伴奏';
  tab.artist = '本地扒谱';
  tab.key = keyNameOrDefault(input.keyHint);
  tab.bpm = bpm;
  tab.timeSignature = ts;
  tab.source = {
    type: 'transcribed',
    jobId: jobId,
    importer: null,
    confidence: null, // 填充 avg 后再写
    engine: LOCAL_ENGINE_ID,
  };
  tab.createdAt = nowIso();
  tab.updatedAt = nowIso();

  const measures = tab.tracks[0].measures;
  for (let m = 0; m < totalMeasures; m += 1) {
    const chords = (chordsByMeasure.get(m) ?? []).sort((a, b) => a.tick - b.tick);
    const notes = (notesByMeasure.get(m) ?? []).sort((a, b) => a.startTick - b.startTick || a.string - b.string);
    measures[m] = {
      index: m,
      startTick: m * per,
      ticks: per,
      chords,
      notes,
      sectionLabel: '',
    };
  }

  // confidence 平均（音符 + 和弦）
  const allConf: number[] = [];
  for (const m of measures) {
    for (const n of m.notes) allConf.push(n.confidence);
    for (const c of m.chords) allConf.push(c.confidence);
  }
  const avgConfidence = allConf.length > 0 ? round2(allConf.reduce((s, v) => s + v, 0) / allConf.length) : 0.4;
  tab.source.confidence = avgConfidence;
  tab.difficulty = computeDifficulty(tab);
  tab.revision = 1;

  return {
    tab,
    avgConfidence,
    pending,
    peaks,
    durationSec,
  };
}

function chordNameForTab(name: string): string {
  // 和弦库收录的直接用；未收录的在名字后加 '?'，diagram 交给 diagramOf 兜底 'xxxxxx'
  const known = diagramOf(name);
  return known === 'xxxxxx' && name.indexOf('?') < 0 ? `${name}?` : name;
}

function keyNameOrDefault(keyHint: string | undefined): Tab['key'] {
  if (!keyHint || keyHint === 'auto') return 'C';
  const allow = /^([A-G][#b]?)(m?)$/;
  if (!allow.test(keyHint)) return 'C';
  return keyHint as Tab['key'];
}
