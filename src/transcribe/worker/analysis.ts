/**
 * Worker 侧 ②③④⑤ DSP 分析（架构 §7.2–§7.5，T-14）。
 *
 * 全部纯计算、无浏览器 API。模块内不含 AudioContext / window。
 * 函数可独立单测（dsp.test.ts 直接构造合成音频调用）。
 *
 * 覆盖：
 *   ② 谱通量 onset 检测（帧 1024 / hop 256 / 汉宁窗 / radix-2 FFT）
 *   ③ YIN-lite 自相关音高（2× 降采样到 8k，τ ∈ [10,114]，CMND + 抛物线插值）
 *   ④ 12 维 chroma + 24 模板 Viterbi 和弦段
 *   ⑤ onset 包络自相关节拍 + 4/4 vs 3/4 拍号判定
 */
import { CHORD_TEMPLATES } from '@/data/chords';
import { clamp, round2 } from '@/core/constants';

// ── 基础常量 ──────────────────────────────────────────────────────
export const ONSET_FRAME = 1024;
export const ONSET_HOP = 256;
export const PITCH_FRAME = 2048;
export const PITCH_HOP = 512;
export const YIN_DOWNSAMPLE = 2;
export const YIN_TAU_MIN = 10;
export const YIN_TAU_MAX = 114;
export const YIN_WINDOW = 512;
export const YIN_THRESHOLD = 0.12;
export const YIN_CLARITY_FLOOR = 0.5;
export const CHROMA_WIN_SEC = 0.2;
export const CHROMA_HOP_SEC = 0.1;
export const MIN_NOTE_SEC = 0.06;
export const CHORD_SWITCH_COST_SOLO = 0.6;
export const CHORD_SWITCH_COST_ACCOMP = 1.0;

// ── 输出结构 ──────────────────────────────────────────────────────
export interface Onset {
  tSec: number;
  strength: number;
}

export interface PitchFrame {
  tSec: number;
  midi: number | null;
  clarity: number;
  f0: number | null;
}

export interface NoteEvent {
  /** MIDI 音高（0 为休止哨兵，不会进入此处） */
  midi: number;
  startSec: number;
  endSec: number;
  clarity: number;
  medianClarity: number;
}

export interface ChordCandidateAlt {
  name: string;
  score: number;
}

export interface ChordSeg {
  startSec: number;
  endSec: number;
  name: string;
  confidence: number;
  alts: ChordCandidateAlt[];
}

export interface BeatEstimate {
  bpm: number;
  timeSignature: [4, 4] | [3, 4];
  firstBeatSec: number;
  beats: number[];
  confidence: number;
}

export interface AnalysisOptions {
  instrument: 'solo' | 'accompaniment';
  keyHint?: string;
}

export interface AnalysisResult {
  onsets: Onset[];
  pitchFrames: PitchFrame[];
  noteEvents: NoteEvent[];
  chordSegs: ChordSeg[];
  beat: BeatEstimate;
}

// ── FFT（自实现迭代 radix-2，不引包）──────────────────────────────
function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * 就地计算复数 FFT（迭代 radix-2，bit-reversal 重排）。
 * re / im 长度必须相等且为 2 的幂。
 */
export function fftRadix2(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  if (n < 2) return;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k += 1) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + half] * curRe - im[i + k + half] * curIm;
        const bIm = re[i + k + half] * curIm + im[i + k + half] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + half] = aRe - bRe;
        im[i + k + half] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

export function hanning(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i += 1) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, n - 1));
  return w;
}

/** 一帧功率谱幅度（不含 DC 以下的低频防护由调用方按频段过滤） */
function spectrumMagnitudes(pcm: Float32Array, start: number, frameLen: number): Float32Array {
  const fftSize = nextPow2(frameLen);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const win = hanning(frameLen);
  for (let i = 0; i < frameLen; i += 1) re[i] = pcm[start + i] * win[i];
  fftRadix2(re, im);
  const half = fftSize >> 1;
  const mag = new Float32Array(half);
  for (let k = 0; k < half; k += 1) {
    mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  }
  return mag;
}

// ── ② 谱通量 onset ────────────────────────────────────────────────
export interface OnsetOptions {
  instrument?: 'solo' | 'accompaniment';
  /** 谱通量阈值系数：solo 1.4 / accompaniment 1.2 */
  thresholdFactor?: number;
  /** 最小间隔（秒）：solo 0.06 / accompaniment 0.04 */
  minGapSec?: number;
  /** 只保留 40Hz–6kHz 的有效频段，降低低频轰鸣误报 */
  minFreq?: number;
  maxFreq?: number;
}

function frameFluxSeries(pcm: Float32Array, sampleRate: number): { flux: number[] } {
  const frameLen = ONSET_FRAME;
  const hop = ONSET_HOP;
  const nFrames = Math.max(1, Math.floor((pcm.length - frameLen) / hop) + 1);
  const flux: number[] = [];
  let prev: Float32Array | null = null;
  const minBin = Math.max(1, Math.floor((40 * frameLen) / sampleRate));
  const maxBin = Math.min(frameLen >> 1, Math.ceil((6000 * frameLen) / sampleRate));

  for (let f = 0; f < nFrames; f += 1) {
    const start = f * hop;
    const mag = spectrumMagnitudes(pcm, start, frameLen);
    let sum = 0;
    const usable = Math.min(maxBin, mag.length - 1);
    for (let k = minBin; k <= usable; k += 1) {
      const cur = mag[k];
      const before = prev ? prev[k] : cur;
      sum += cur > before ? cur - before : 0;
    }
    flux.push(sum);
    prev = mag;
  }
  return { flux };
}

/**
 * 谱通量 onset（架构 §7.2）。
 * 半波整流 → ±20 帧局部归一化 → 阈值 1.4×median + 0.02 → 局部最大 → 最小间隔去重。
 */
export function computeOnsets(pcm: Float32Array, sampleRate = 16000, opts: OnsetOptions = {}): Onset[] {
  const thresholdFactor = opts.thresholdFactor ?? (opts.instrument === 'accompaniment' ? 1.2 : 1.4);
  const minGapSec = opts.minGapSec ?? (opts.instrument === 'accompaniment' ? 0.04 : 0.06);
  const { flux } = frameFluxSeries(pcm, sampleRate);
  if (flux.length === 0) return [];

  const half = 20;
  const norm: number[] = flux.map((v, i) => {
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(flux.length - 1, i + half); j += 1) {
      s += flux[j];
      c += 1;
    }
    return v / (s / Math.max(1, c) + 1e-6);
  });

  const median = (arr: number[]): number => {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  };

  const threshold: number[] = norm.map((_, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(norm.length - 1, i + half);
    const local = norm.slice(lo, hi + 1);
    return thresholdFactor * median(local) + 0.02;
  });

  const raw: Onset[] = [];
  for (let i = 1; i < norm.length - 1; i += 1) {
    if (norm[i] > threshold[i] && norm[i] >= norm[i - 1] && norm[i] > norm[i + 1]) {
      raw.push({ tSec: (i * ONSET_HOP) / sampleRate, strength: norm[i] });
    }
  }

  // 最小间隔去重（保留 strength 最大者）
  const out: Onset[] = [];
  for (const o of raw) {
    const last = out.length > 0 ? out[out.length - 1] : null;
    if (!last || o.tSec - last.tSec >= minGapSec) {
      out.push(o);
    } else if (o.strength > last.strength) {
      out[out.length - 1] = o;
    }
  }
  return out;
}

// ── ③ YIN-lite 音高 ───────────────────────────────────────────────
export interface YinResult {
  f0: number | null;
  midi: number | null;
  clarity: number;
  tau: number;
  cmndValue: number;
}

/** 帧内差分函数累计（8k 域），返回 d[0..tauMax+1] */
function differenceFunction(x: Float32Array, windowLen: number, tauMax: number): Float32Array {
  const d = new Float32Array(tauMax + 2);
  for (let tau = 1; tau <= tauMax; tau += 1) {
    let sum = 0;
    const w = Math.min(windowLen, x.length - tau);
    for (let j = 0; j < w; j += 1) {
      const diff = x[j] - x[j + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }
  return d;
}

/**
 * 单帧 YIN-lite。
 * frameLen 个原始采样（16k）经 2× 降采样到 8k，随后在 τ ∈ [10,114] 找首个
 * CMND 局部最小（<0.12），抛物线插值得 τ*，f0 = 8000/τ*。
 */
export function yinAt(
  pcm: Float32Array,
  sampleRate: number,
  startSample: number,
): YinResult {
  const frameLen = PITCH_FRAME;
  const ds = YIN_DOWNSAMPLE;
  const downRate = sampleRate / ds;
  const take = Math.min(frameLen, pcm.length - startSample);
  if (take < (YIN_TAU_MAX + YIN_WINDOW) * ds) {
    return { f0: null, midi: null, clarity: 0, tau: 0, cmndValue: 1 };
  }

  // 2× 降采样（简单平均相邻两采样，带抗混叠）
  const dl = Math.floor(take / ds);
  const x = new Float32Array(dl);
  for (let i = 0; i < dl; i += 1) {
    const a = pcm[startSample + i * ds];
    const b = pcm[startSample + i * ds + 1];
    x[i] = (a + b) * 0.5;
  }

  const tauMax = Math.min(YIN_TAU_MAX, x.length - 2);
  const windowLen = Math.min(YIN_WINDOW, Math.max(128, x.length - tauMax - 1));
  const d = differenceFunction(x, windowLen, tauMax);

  // CMND 归一化
  const cmnd = new Float32Array(tauMax + 2);
  let prefix = 0;
  for (let tau = 1; tau <= tauMax; tau += 1) {
    prefix += d[tau];
    cmnd[tau] = d[tau] / (prefix / tau + 1e-9);
  }

  let bestTau = 0;
  let bestVal = Number.POSITIVE_INFINITY;
  for (let tau = YIN_TAU_MIN + 1; tau < tauMax; tau += 1) {
    const v = cmnd[tau];
    if (v < YIN_THRESHOLD && v < cmnd[tau - 1] && v < cmnd[tau + 1]) {
      bestTau = tau;
      bestVal = v;
      break;
    }
    if (v < bestVal) {
      bestVal = v;
      bestTau = tau;
    }
  }
  if (bestTau === 0) {
    return { f0: null, midi: null, clarity: 0, tau: 0, cmndValue: 1 };
  }

  // 抛物线插值
  const y0 = cmnd[bestTau - 1];
  const y1 = cmnd[bestTau];
  const y2 = cmnd[bestTau + 1];
  const denom = y0 - 2 * y1 + y2;
  let delta = denom !== 0 ? (y0 - y2) / (2 * denom) : 0;
  if (!Number.isFinite(delta) || Math.abs(delta) > 1) delta = 0;
  const tauStar = bestTau + delta;
  const f0 = downRate / tauStar;
  const clarity = clamp(1 - y1, 0, 1);

  if (clarity < YIN_CLARITY_FLOOR || f0 < 70 || f0 > 800) {
    return { f0: null, midi: null, clarity, tau: bestTau, cmndValue: y1 };
  }
  const midi = Math.round(69 + 12 * Math.log2(f0 / 440));
  return { f0, midi, clarity, tau: bestTau, cmndValue: y1 };
}

/** 全曲音高帧（帧 2048 / hop 512 = 32ms） */
export function pitchFrames(pcm: Float32Array, sampleRate = 16000): PitchFrame[] {
  const out: PitchFrame[] = [];
  const step = PITCH_HOP;
  const maxStart = Math.max(0, pcm.length - PITCH_FRAME);
  for (let s = 0; s <= maxStart; s += step) {
    const r = yinAt(pcm, sampleRate, s);
    out.push({
      tSec: s / sampleRate,
      midi: r.midi,
      clarity: r.clarity,
      f0: r.f0,
    });
  }
  return out;
}

/** 音符事件化：合并连续同 midi 帧，丢弃 <60ms；clarity 取中位数 */
export function toNoteEvents(frames: readonly PitchFrame[]): NoteEvent[] {
  const events: NoteEvent[] = [];
  let run: PitchFrame[] = [];

  const flush = () => {
    if (run.length === 0) return;
    const first = run[0];
    const last = run[run.length - 1];
    const midi = first.midi;
    const sorted = run.map((f) => f.clarity).sort((a, b) => a - b);
    const median = sorted.length > 0 ? sorted[sorted.length >> 1] : 0;
    const durSec = last.tSec + (PITCH_HOP / 16000) - first.tSec;
    if (midi !== null && midi > 0 && durSec >= MIN_NOTE_SEC) {
      events.push({
        midi,
        startSec: first.tSec,
        endSec: last.tSec + (PITCH_HOP / 16000),
        clarity: median,
        medianClarity: clamp(round2(median), 0, 1),
      });
    }
    run = [];
  };

  for (const frame of frames) {
    if (frame.midi === null) {
      flush();
      continue;
    }
    const last = run.length > 0 ? run[run.length - 1] : null;
    const gapOk = !last || frame.tSec - last.tSec <= (PITCH_HOP / 16000) * 2.5;
    if (last && (last.midi !== frame.midi || !gapOk)) flush();
    run.push(frame);
  }
  flush();
  return events;
}

// ── ④ chroma 与和弦 Viterbi ───────────────────────────────────────
const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function accumulateNote(chroma: number[], midi: number, weight: number): void {
  if (weight <= 0) return;
  const pc = ((midi % 12) + 12) % 12;
  chroma[pc] += weight; // 根音
  chroma[(pc + 7) % 12] += weight * 0.25; // 纯五度
  chroma[(pc + 12) % 12] += weight * 0.5; // 八度
}

function windowChroma(
  events: readonly NoteEvent[],
  fromSec: number,
  toSec: number,
): number[] {
  const chroma = new Array<number>(12).fill(0);
  for (const ev of events) {
    const overlapStart = Math.max(ev.startSec, fromSec);
    const overlapEnd = Math.min(ev.endSec, toSec);
    if (overlapEnd <= overlapStart) continue;
    const frac = clamp((overlapEnd - overlapStart) / Math.max(1e-6, CHROMA_WIN_SEC), 0, 1);
    accumulateNote(chroma, ev.midi, clamp(ev.medianClarity, 0, 1) * frac);
  }
  const norm = Math.sqrt(chroma.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? chroma.map((v) => v / norm) : chroma;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * chroma 窗序列（0.2s / hop 0.1s），每窗给出观测余弦向量。
 * 返回 { chromas, startSecs, cosines } 供 Viterbi 使用。
 */
export function chromaSeries(
  events: readonly NoteEvent[],
  durationSec: number,
): { chromas: number[][]; startSecs: number[]; cosines: number[][] } {
  const chromas: number[][] = [];
  const startSecs: number[] = [];
  const cosines: number[][] = [];
  const hop = CHROMA_HOP_SEC;
  const win = CHROMA_WIN_SEC;
  for (let t = 0; t < durationSec - 1e-6; t += hop) {
    const c = windowChroma(events, t, Math.min(durationSec, t + win));
    const scores = CHORD_TEMPLATES.map((tp) => cosine(c, tp.chroma));
    chromas.push(c);
    startSecs.push(t);
    cosines.push(scores);
  }
  return { chromas, startSecs, cosines };
}

/** Viterbi：24 模板观测 + 切换代价 → 每窗最优和弦下标 */
export function viterbiChords(
  cosines: number[][],
  instrument: 'solo' | 'accompaniment',
): { path: number[]; total: number } {
  const nTpl = CHORD_TEMPLATES.length;
  const nWin = cosines.length;
  if (nWin === 0) return { path: [], total: 0 };
  const switchCost = instrument === 'accompaniment' ? CHORD_SWITCH_COST_ACCOMP : CHORD_SWITCH_COST_SOLO;

  const dp: number[][] = Array.from({ length: nWin }, () => new Array<number>(nTpl).fill(0));
  const back: number[][] = Array.from({ length: nWin }, () => new Array<number>(nTpl).fill(0));

  for (let t = 0; t < nTpl; t += 1) {
    dp[0][t] = 1 - cosines[0][t];
  }

  for (let w = 1; w < nWin; w += 1) {
    for (let cur = 0; cur < nTpl; cur += 1) {
      let best = Number.POSITIVE_INFINITY;
      let bestPrev = 0;
      for (let prev = 0; prev < nTpl; prev += 1) {
        const cost = dp[w - 1][prev] + (prev === cur ? 0 : switchCost);
        if (cost < best) {
          best = cost;
          bestPrev = prev;
        }
      }
      dp[w][cur] = (1 - cosines[w][cur]) + best;
      back[w][cur] = bestPrev;
    }
  }

  let bestLast = 0;
  let bestVal = Number.POSITIVE_INFINITY;
  for (let t = 0; t < nTpl; t += 1) {
    if (dp[nWin - 1][t] < bestVal) {
      bestVal = dp[nWin - 1][t];
      bestLast = t;
    }
  }

  const path = new Array<number>(nWin).fill(0);
  path[nWin - 1] = bestLast;
  for (let w = nWin - 1; w > 0; w -= 1) path[w - 1] = back[w][path[w]];
  return { path, total: bestVal };
}

/** 合并连续同和弦窗 → ChordSeg[] */
export function segsFromPath(
  path: readonly number[],
  startSecs: readonly number[],
  cosines: number[][],
  durationSec: number,
): ChordSeg[] {
  if (path.length === 0) return [];
  const segs: ChordSeg[] = [];
  const nWin = path.length;
  const totalSwitches = path.reduce((acc, cur, i) => (i > 0 && cur !== path[i - 1] ? acc + 1 : acc), 0);
  const switchDensity = clamp(totalSwitches / Math.max(1, nWin), 0, 1);

  let segStart = 0;
  for (let i = 1; i <= nWin; i += 1) {
    if (i < nWin && path[i] === path[segStart]) continue;
    const idx = path[segStart];
    const name = CHORD_TEMPLATES[idx].name;
    const windowEnd = i < nWin ? startSecs[i] : Math.max(durationSec, startSecs[startSecs.length - 1] + CHROMA_HOP_SEC);
    const meanCos =
      cosines.slice(segStart, i).reduce((acc, row) => acc + row[idx], 0) / Math.max(1, i - segStart);
    const confidence = clamp(round2(0.7 * meanCos + 0.3 * (1 - switchDensity)), 0, 1);
    // 近似：用窗平均余弦对全部模板评分得到 Top-3 备选
    const altRows = cosines.slice(segStart, i);
    const meanScores = CHORD_TEMPLATES.map((_, t) => {
      let s = 0;
      for (const row of altRows) s += row[t];
      return s / Math.max(1, altRows.length);
    });
    const alts: ChordCandidateAlt[] = CHORD_TEMPLATES.map((tp, t) => ({
      name: tp.name,
      score: round2(meanScores[t]),
    }))
      .filter((a) => a.name !== name)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, 3);
    segs.push({
      startSec: startSecs[segStart],
      endSec: windowEnd,
      name,
      confidence,
      alts,
    });
    segStart = i;
  }
  return segs;
}

/** ④ 主入口 */
export function identifyChords(
  noteEvents: readonly NoteEvent[],
  durationSec: number,
  opts: AnalysisOptions,
): ChordSeg[] {
  const { cosines, startSecs } = chromaSeries(noteEvents, durationSec);
  const { path } = viterbiChords(cosines, opts.instrument);
  return segsFromPath(path, startSecs, cosines, durationSec);
}

// ── ⑤ 节拍与拍号 ──────────────────────────────────────────────────
const BEAT_HOP = 256;

/** 将 onset 落到 16ms 能量网格 */
function onsetEnvelope(pcm: Float32Array, onsets: readonly Onset[], sampleRate: number): Float32Array {
  const len = Math.max(1, Math.floor(pcm.length / BEAT_HOP) + 1);
  const env = new Float32Array(len);
  for (const o of onsets) {
    const idx = Math.min(len - 1, Math.max(0, Math.round((o.tSec * sampleRate) / BEAT_HOP)));
    env[idx] = Math.max(env[idx], o.strength);
  }
  // 3 点平滑
  const out = new Float32Array(len);
  for (let i = 0; i < len; i += 1) {
    const a = i > 0 ? env[i - 1] : 0;
    const b = env[i];
    const c = i + 1 < len ? env[i + 1] : 0;
    out[i] = (a + 2 * b + c) / 4;
  }
  return out;
}

/**
 * 在 [0, periodSec) 上按网格相位扫描，返回使「组首时刻的 onset 能量均值」最大
 * 的相位（组首时刻序列 = φ + k×periodSec）。hwFrac 控制三角形窗口半宽。
 */
function bestGridPhase(
  onsets: readonly Onset[],
  periodSec: number,
  subdiv = 64,
): { phase: number; mean: number; gridCount: number } {
  if (onsets.length === 0 || periodSec <= 0) return { phase: 0, mean: 0, gridCount: 0 };
  // 三角形窗口半宽：约 1/10 周期（容忍检测抖动 ±0.05s 量级，同时拒绝相邻拍）
  const halfW = Math.max(0.05, periodSec / 10);
  const maxSec = Math.max(0, ...onsets.map((o) => o.tSec));
  const gridCount = Math.max(1, Math.floor(maxSec / periodSec) + 1);
  let best = -1;
  let bestMean = -1;
  for (let k = 0; k < subdiv; k += 1) {
    const phi = (periodSec * k) / subdiv;
    let s = 0;
    for (const o of onsets) {
      let rel = (o.tSec - phi) % periodSec;
      if (rel < 0) rel += periodSec;
      const dist = Math.min(rel, periodSec - rel);
      const w = dist <= halfW ? 1 - dist / halfW : 0;
      s += o.strength * w;
    }
    const mean = s / gridCount;
    if (mean > bestMean) {
      bestMean = mean;
      best = phi;
    }
  }
  return { phase: best, mean: bestMean, gridCount };
}

/** onset 附近的局部 RMS（80ms 窗口，容忍检测 ±0.02s 抖动），用于保留强弱拍差异 */
function localRmsAt(pcm: Float32Array, sampleRate: number, tSec: number, winSec = 0.08): number {
  const i0 = Math.max(0, Math.round((tSec - 0.02) * sampleRate));
  const win = Math.max(1, Math.round(winSec * sampleRate));
  let sum = 0;
  let n = 0;
  const end = Math.min(pcm.length, i0 + win);
  for (let i = i0; i < end; i += 1) {
    sum += pcm[i] * pcm[i];
    n += 1;
  }
  return n > 0 ? Math.sqrt(sum / n) : 0;
}

/**
 * 节拍估计：onset 包络自相关（BPM ∈ [60,200]），倍频修正，
 * 相位对齐取 firstBeatSec，再对 4/4 与 3/4 打分。
 */
export function estimateBeat(
  pcm: Float32Array,
  sampleRate = 16000,
  onsets?: readonly Onset[],
): BeatEstimate {
  const detected = onsets ?? computeOnsets(pcm, sampleRate);
  const env = onsetEnvelope(pcm, detected, sampleRate);

  const lagMin = Math.max(1, Math.floor((sampleRate * 60) / (200 * BEAT_HOP)));
  const lagMax = Math.max(lagMin + 1, Math.ceil((sampleRate * 60) / (60 * BEAT_HOP)));
  const maxLag = Math.min(lagMax, env.length - 2);

  let bestLag = lagMin;
  let bestAcf = -1;
  for (let lag = lagMin; lag <= maxLag; lag += 1) {
    let s = 0;
    let n = 0;
    for (let i = 0; i + lag < env.length; i += 1) {
      s += env[i] * env[i + lag];
      n += 1;
    }
    const acf = n > 0 ? s / n : 0;
    if (acf > bestAcf) {
      bestAcf = acf;
      bestLag = lag;
    }
  }

  let bpm0 = (60 * sampleRate) / (bestLag * BEAT_HOP);
  if (bpm0 < 70) bpm0 *= 2;
  else if (bpm0 > 160) bpm0 /= 2;
  const bpm = clamp(Math.round(bpm0), 40, 240);
  const beatSec = 60 / bpm;

  // 用局部 RMS 重加权 onsets，保留重拍/弱拍差异后再判拍号
  const accents: Onset[] = detected.map((o) => ({
    tSec: o.tSec,
    strength: Math.max(0.05, localRmsAt(pcm, sampleRate, o.tSec)),
  }));

  const g4 = bestGridPhase(accents, beatSec * 4).mean;
  const g3 = bestGridPhase(accents, beatSec * 3).mean;
  const timeSignature: BeatEstimate['timeSignature'] = g3 > g4 ? [3, 4] : [4, 4];
  const beatsPerMeasure = timeSignature[0];

  // 小节下拍相位（供 3/4 小节边界更稳）
  const measureSec = beatSec * beatsPerMeasure;
  const { phase: anchorPhase } = bestGridPhase(accents, measureSec);
  const anchorSec = anchorPhase;

  const beats: number[] = [];
  const maxSec = pcm.length / sampleRate;
  for (let b = anchorSec; b < maxSec; b += beatSec) beats.push(b);

  return {
    bpm,
    timeSignature,
    firstBeatSec: anchorSec,
    beats,
    confidence: clamp(round2(bestAcf / (1 + bestAcf)), 0, 1),
  };
}

/** 和弦段内某时间点的和弦名 */
export function chordNameAt(chordSegs: readonly ChordSeg[], tSec: number): string {
  for (const seg of chordSegs) {
    if (tSec >= seg.startSec && tSec < seg.endSec) return seg.name;
  }
  return '';
}

// ── 汇总 ──────────────────────────────────────────────────────────
export function analyze(
  pcm: Float32Array,
  sampleRate = 16000,
  opts: AnalysisOptions,
): AnalysisResult {
  const onsets = computeOnsets(pcm, sampleRate, { instrument: opts.instrument });
  const frames = pitchFrames(pcm, sampleRate);
  const noteEvents = toNoteEvents(frames);
  const durationSec = pcm.length / sampleRate;
  const chordSegs = identifyChords(noteEvents, durationSec, opts);
  const beat = estimateBeat(pcm, sampleRate, onsets);
  return { onsets, pitchFrames: frames, noteEvents, chordSegs, beat };
}

/** 把 MIDI 转音名（测试与调试用） */
export function midiToPcName(midi: number): string {
  const idx = ((Math.round(midi) % 12) + 12) % 12;
  return PC_NAMES[idx];
}
