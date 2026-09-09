/**
 * DSP 引擎单测（架构 §2.11 文件 60，T-15）。
 *
 * 用合成音频/事件构造 golden case：
 *  - 440Hz 正弦 → YIN-lite 基频误差 < 10 音分
 *  - C 大三和弦（滚奏）→ chroma 匹配命中 C
 *  - 120BPM 4/4 与 3/4 脉冲串 → 节拍/拍号估计
 *  - 指板 DP：同时 5 音 ≤4 且同弦唯一；跨度 >4 品的组合不被选中；confidence ∈ [0,1]；
 *    同一 midi 多个可行位置给出按代价升序的 Top-3
 */
import { describe, expect, it } from 'vitest';
import type { StringNumber } from '@/types/tab';
import {
  computeOnsets,
  estimateBeat,
  identifyChords,
  midiToPcName,
  pitchFrames,
  toNoteEvents,
  yinAt,
} from '@/transcribe/worker/analysis';
import type { NoteEvent } from '@/transcribe/worker/analysis';
import {
  candidatesFor,
  emitCost,
  groupIntoSteps,
  solveFretboard,
  topCandidates,
  COST_MAX,
  GROUP_SIZE_LIMIT,
  SPAN_LIMIT,
} from '@/transcribe/worker/fretboardDP';
import { decodePcm, qualityGate } from '@/transcribe/worker/decode';

const SR = 16000;

/** 生成一轨完整时间线正弦（startSec 前为静音） */
function tone(
  freq: number,
  durSec: number,
  totalSec: number,
  amp = 0.8,
  startSec = 0,
  fadeSec = 0.01,
): Float32Array {
  const out = new Float32Array(Math.ceil(totalSec * SR));
  const startSample = Math.round(startSec * SR);
  const len = Math.ceil(durSec * SR);
  const fadeSamples = Math.max(1, Math.round(fadeSec * SR));
  for (let i = 0; i < len; i += 1) {
    const idx = startSample + i;
    if (idx < 0 || idx >= out.length) continue;
    let env = 1;
    const fromStart = Math.min(i, len - i);
    if (fromStart < fadeSamples) env = fromStart / fadeSamples;
    out[idx] += amp * Math.sin((2 * Math.PI * freq * idx) / SR) * env;
  }
  return out;
}

/** 简单加性叠加（长度取最大者） */
function mix(...parts: Float32Array[]): Float32Array {
  const len = Math.max(0, ...parts.map((p) => p.length));
  const out = new Float32Array(len);
  for (const p of parts) {
    for (let i = 0; i < p.length; i += 1) out[i] += p[i];
  }
  return out;
}

/** 拍点/重音脉冲串（同一条时间线） */
function clickTrain(opts: { bpm: number; beatsPerGroup: number; durSec: number; beatAmp?: number; accentAmp?: number }): Float32Array {
  const beatSec = 60 / opts.bpm;
  const parts: Float32Array[] = [];
  let t = 0;
  let group = 0;
  while (t < opts.durSec) {
    const accent = group % opts.beatsPerGroup === 0;
    parts.push(
      tone(accent ? 1200 : 800, 0.03, opts.durSec, accent ? (opts.accentAmp ?? 1) : (opts.beatAmp ?? 0.6), t, 0.005),
    );
    t += beatSec;
    group += 1;
  }
  return mix(...parts);
}

/** 手造一个持续音 NoteEvent（用于 DP 测试） */
function ev(midi: number, startSec: number, durSec: number, clarity = 0.8): NoteEvent {
  return {
    midi,
    startSec,
    endSec: startSec + durSec,
    clarity,
    medianClarity: clarity,
  };
}

describe('decode / quality gate（T-14）', () => {
  it('decodePcm 长度保持并归一化', () => {
    const raw = tone(440, 0.3, 0.3, 0.5);
    const d = decodePcm(raw, SR);
    expect(d.pcm.length).toBeGreaterThan(SR * 0.2);
    expect(d.rms).toBeGreaterThan(0);
    expect(d.silenceRatio).toBeLessThan(0.5);
  });

  it('qualityGate 识别几乎无声', () => {
    const silent = new Float32Array(SR);
    const g = qualityGate(silent);
    expect(g.ok).toBe(false);
  });
});

describe('YIN-lite 音高（架构 §7.3，T-14）', () => {
  it('440Hz 正弦单音误差 < 10 音分', () => {
    const pcm = tone(440, 1.0, 1.0, 0.8);
    const frames = pitchFrames(pcm, SR);
    const voiced = frames.filter((f) => f.midi !== null && f.f0 !== null && f.clarity > 0.6);
    expect(voiced.length).toBeGreaterThan(10);
    const f0s = voiced.map((f) => f.f0 as number).sort((a, b) => a - b);
    const median = f0s[Math.floor(f0s.length / 2)];
    const cents = Math.abs(1200 * Math.log2(median / 440));
    expect(cents).toBeLessThan(10);
  });

  it('midi ≈ 69（A4=440Hz）', () => {
    const pcm = tone(440, 0.8, 0.8, 0.8);
    const r = yinAt(pcm, SR, Math.round(SR * 0.2));
    expect(r.midi).toBe(69);
    expect(midiToPcName(69)).toBe('A');
  });
});

describe('chroma / 和弦识别（架构 §7.4，T-14）', () => {
  it('C 大三和弦（滚奏 C4-E4-G4）命中 C', () => {
    const total = 1.15;
    const c4 = tone(261.63, 0.35, total, 0.7, 0.0);
    const e4 = tone(329.63, 0.35, total, 0.7, 0.4);
    const g4 = tone(392.0, 0.35, total, 0.7, 0.8);
    const pcm = mix(c4, e4, g4);
    const frames = pitchFrames(pcm, SR);
    const events = toNoteEvents(frames);
    expect(events.length).toBeGreaterThanOrEqual(2);
    const segs = identifyChords(events, pcm.length / SR, { instrument: 'solo' });
    expect(segs.length).toBeGreaterThan(0);
    expect(segs.some((s) => s.name === 'C')).toBe(true);
  });
});

describe('节拍与拍号估计（架构 §7.5，T-14）', () => {
  it('120BPM 4/4（每 4 拍重音）→ bpm ∈ [118,122] 且 4/4', () => {
    const pcm = clickTrain({ bpm: 120, beatsPerGroup: 4, durSec: 9.6, beatAmp: 0.6, accentAmp: 1 });
    const onsets = computeOnsets(pcm, SR, { instrument: 'solo' });
    expect(onsets.length).toBeGreaterThan(5);
    const beat = estimateBeat(pcm, SR, onsets);
    expect(beat.bpm).toBeGreaterThanOrEqual(118);
    expect(beat.bpm).toBeLessThanOrEqual(122);
    expect(beat.timeSignature).toEqual([4, 4]);
  });

  it('120BPM 3/4（每 3 拍重音）→ 判定 3/4', () => {
    const pcm = clickTrain({ bpm: 120, beatsPerGroup: 3, durSec: 9.6, beatAmp: 0.6, accentAmp: 1 });
    const onsets = computeOnsets(pcm, SR, { instrument: 'solo' });
    const beat = estimateBeat(pcm, SR, onsets);
    expect(beat.bpm).toBeGreaterThanOrEqual(118);
    expect(beat.bpm).toBeLessThanOrEqual(122);
    expect(beat.timeSignature).toEqual([3, 4]);
  });
});

describe('指板 DP（架构 §7.6，T-15）', () => {
  it('候选生成：同一 midi 有多个可行位置', () => {
    const cands = candidatesFor(64); // E4
    expect(cands.length).toBeGreaterThanOrEqual(3);
    expect(cands[0].string).toBe(1);
    expect(cands[0].fret).toBe(0);
  });

  it('同时 5 音 → 输出 ≤4 且同弦唯一、无 dropped 之外多余', () => {
    // C4/E4/G4/A4/B4 同刻发声，clarity 各异
    const notes = [
      ev(60, 0, 0.4, 0.9),
      ev(64, 0, 0.4, 0.85),
      ev(67, 0, 0.4, 0.8),
      ev(69, 0, 0.4, 0.75),
      ev(71, 0, 0.4, 0.7),
    ];
    const out = solveFretboard(notes, { chordSegs: [], accompaniment: false });
    const kept = out.filter((r) => !r.dropped);
    expect(kept.length).toBeLessThanOrEqual(GROUP_SIZE_LIMIT);
    const strings = new Set(kept.map((r) => r.string));
    expect(strings.size).toBe(kept.length);
    const droppedCount = out.filter((r) => r.dropped).length;
    expect(droppedCount).toBeGreaterThanOrEqual(1); // 至少丢 1 个
  });

  it('跨度 >4 品的组合不被选中（无可行解时宁可 drop）', () => {
    // midi40 只能在 6 弦 0 品；midi79 至少要到 15 品 → 跨度必然 >4
    const notes = [ev(40, 0, 0.4, 0.95), ev(79, 0.01, 0.4, 0.9)];
    const out = solveFretboard(notes, { chordSegs: [], accompaniment: false });
    const kept = out.filter((r) => !r.dropped);
    expect(kept.length).toBeGreaterThanOrEqual(1);
    // 任意一个保留组合都满足跨度约束
    if (kept.length === 2) {
      const frets = kept.map((r) => r.fret);
      const span = Math.max(...frets) - Math.min(...frets);
      expect(span).toBeLessThanOrEqual(SPAN_LIMIT);
    } else {
      // 只能保留一个（跨度无解 → 另一个被丢弃）
      expect(out.some((r) => r.dropped)).toBe(true);
    }
  });

  it('confidence ∈ [0,1] 且保留 2 位', () => {
    const notes = [ev(64, 0, 0.4, 0.9), ev(59, 0.01, 0.4, 0.8)];
    const out = solveFretboard(notes, { chordSegs: [], accompaniment: false });
    for (const r of out) {
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
      expect(Math.round(r.confidence * 100) / 100).toBe(r.confidence);
    }
  });

  it('Top-3 候选按代价升序', () => {
    const cands = topCandidates(64, 'C', false);
    expect(cands.length).toBeLessThanOrEqual(3);
    expect(cands.length).toBeGreaterThan(0);
    for (let i = 1; i < cands.length; i += 1) {
      expect(cands[i].cost).toBeGreaterThanOrEqual(cands[i - 1].cost - 1e-9);
    }
  });

  it('groupIntoSteps 把 25ms 内同刻事件聚类', () => {
    const steps = groupIntoSteps([ev(60, 0, 0.3), ev(64, 0.01, 0.3), ev(67, 0.5, 0.3)], 0.025);
    expect(steps.length).toBe(2);
    expect(steps[0].group.length).toBe(2);
  });

  it('emitCost 空弦有奖励、高把位代价更高', () => {
    const open = emitCost(64, 1 as StringNumber, 0, 'C', false);
    const high = emitCost(64, 4 as StringNumber, 14, 'C', false);
    expect(open).toBeLessThan(high);
    expect(high).toBeGreaterThan(COST_MAX * 0.4);
  });
});
