/**
 * Worker 侧 ⑥ 指板 DP 映射（架构 §7.6，T-15）。
 *
 * 输入：NoteEvent[]（含同时发声组）+ 和弦段 + 拍信息。
 * 输出：每个保留事件的 (string, fret)、confidence、Top-3 候选。
 *
 * 硬约束（不满足则该组合代价 = +∞）：
 *   1. 同组内 string 互不相同（同弦同时最多一音）
 *   2. 组内音数 ≤ 4（超出优先保留 clarity 高者，其余标记 dropped → pending rhythm）
 *   3. 非横按跨度 ≤ 4 品（构成横按 —— ≥2 音同正品 —— 时放开）
 *   4. fret ∈ [0, 24]
 *
 * 纯函数、无浏览器 API。
 */
import type { StringNumber } from '@/types/tab';
import { MAX_FRET, clamp, round2 } from '@/core/constants';
import { allPositions } from '@/core/fretboard';
import { chromaVectorOf } from '@/core/chords';
import type { ChordSeg, NoteEvent } from '@/transcribe/worker/analysis';

export interface FretChoice {
  string: StringNumber;
  fret: number;
  cost: number;
}

export interface DpResultNote {
  /** NoteEvent 原始下标 */
  index: number;
  midi: number;
  string: StringNumber;
  fret: number;
  confidence: number;
  candidates: FretChoice[];
  /** 因超 4 音 / 无解被丢弃，进 pending（rhythm 类型） */
  dropped: boolean;
  clarity: number;
}

export interface FretboardOptions {
  /** 和弦段：取事件时刻所在段名用于一致性代价 */
  chordSegs: readonly ChordSeg[];
  /** 事件按 startSec 升序 */
  accompaniment?: boolean;
  maxFret?: number;
  /** 同组容差（秒），默认 25ms */
  groupToleranceSec?: number;
}

export const COST_MAX = 2.0;
export const GROUP_SIZE_LIMIT = 4;
export const SPAN_LIMIT = 4;

// ── 时间步分组 ────────────────────────────────────────────────────
/** 把同一时刻（容差 25ms）发声的事件归为一组，组内按 clarity 降序 */
export function groupIntoSteps(
  events: readonly NoteEvent[],
  toleranceSec = 0.025,
): { group: NoteEvent[]; groupIndex: number }[] {
  const steps: { group: NoteEvent[]; groupIndex: number }[] = [];
  let current: NoteEvent[] = [];
  let groupCounter = 0;
  for (const ev of events) {
    if (current.length > 0 && ev.startSec - current[current.length - 1].startSec > toleranceSec) {
      steps.push({ group: [...current].sort((a, b) => b.clarity - a.clarity), groupIndex: groupCounter });
      groupCounter += 1;
      current = [ev];
    } else {
      current.push(ev);
    }
  }
  if (current.length > 0) {
    steps.push({ group: [...current].sort((a, b) => b.clarity - a.clarity), groupIndex: groupCounter });
  }
  return steps;
}

/** 事件 → 全部可弹位置（string 1..6, fret 0..24） */
export function candidatesFor(midi: number, maxFret: number = MAX_FRET): { string: StringNumber; fret: number }[] {
  return allPositions(midi, maxFret);
}

// ── 代价 ──────────────────────────────────────────────────────────
function chordTones(name: string): Set<number> | null {
  if (!name) return null;
  const vec = chromaVectorOf(name);
  const set = new Set<number>();
  for (let i = 0; i < 12; i += 1) {
    if (vec[i] > 0) set.add(i);
  }
  return set.size > 0 ? set : null;
}

/** 发射代价（不含转移） */
export function emitCost(
  midi: number,
  string: StringNumber,
  fret: number,
  chordName: string,
  accompaniment: boolean,
): number {
  let cost = 0;
  if (fret === 0) cost += -0.3; // 空弦奖励
  else if (fret <= 12) cost += 0.06 * fret;
  else cost += 0.72 + 0.1 * (fret - 12);

  const tones = chordTones(chordName);
  if (tones) {
    const pc = ((midi % 12) + 12) % 12;
    if (!tones.has(pc)) cost += accompaniment ? 0.35 : 0.2;
  }
  return cost;
}

function interCost(a: { string: number; fret: number }, b: { string: number; fret: number }): number {
  return 0.08 * Math.abs(a.fret - b.fret) + 0.03 * Math.abs(a.string - b.string);
}

/** 硬约束 3：非横按跨度 ≤ 4（≥2 音同正品时按横按放开） */
function withinSpan(assigns: readonly { string: number; fret: number }[]): boolean {
  if (assigns.length < 2) return true;
  const frets = assigns.map((a) => a.fret);
  const min = Math.min(...frets);
  const max = Math.max(...frets);
  if (max - min <= SPAN_LIMIT) return true;
  // 横按：存在 ≥2 个正品位相同
  const countByFret = new Map<number, number>();
  for (const f of frets) {
    if (f <= 0) continue;
    countByFret.set(f, (countByFret.get(f) ?? 0) + 1);
  }
  for (const [fret, count] of countByFret) {
    if (fret > 0 && count >= 2) return true;
  }
  return false;
}

// ── DP 主解 ───────────────────────────────────────────────────────
interface Assignment {
  event: NoteEvent;
  string: StringNumber;
  fret: number;
}

interface StepState {
  cost: number;
  assigns: Assignment[];
}

interface StepSolution {
  assigns: Assignment[];
  kept: NoteEvent[];
  dropped: NoteEvent[];
  totalCost: number;
}

function solveStep(
  group: NoteEvent[],
  prevStates: readonly StepState[],
  chordName: string,
  accompaniment: boolean,
  maxFret: number,
): StepSolution | null {
  // 保留候选：clarity 降序，取前 4
  const sorted = [...group].sort((a, b) => b.clarity - a.clarity);
  const keptPool = sorted.slice(0, GROUP_SIZE_LIMIT);
  const dropped = sorted.slice(GROUP_SIZE_LIMIT);

  const tryKeep = (kept: NoteEvent[]): StepState[] | null => {
    // 每个事件的可选位置
    const candidateLists = kept.map((ev) => candidatesFor(ev.midi, maxFret));
    if (candidateLists.some((list) => list.length === 0)) return null;

    let solutions: StepState[] = [];
    const usedStrings = new Set<StringNumber>();

    const recurse = (depth: number, assigns: Assignment[], costAcc: number): void => {
      if (depth === kept.length) {
        if (assigns.length === 0) {
          solutions.push({ cost: costAcc, assigns: [] });
          return;
        }
        if (!withinSpan(assigns)) return;
        // 内部连续弦序成本近似：按弦号升序两两相加
        const ordered = [...assigns].sort((a, b) => a.string - b.string);
        let intra = 0;
        for (let i = 1; i < ordered.length; i += 1) {
          const df = Math.abs(ordered[i].fret - ordered[i - 1].fret);
          if (df > 3) intra += 0.12 * (df - 3);
          intra += 0.03 * Math.abs(ordered[i].string - ordered[i - 1].string);
        }
        const intraShare = intra / Math.max(1, assigns.length);
        let trans = 0;
        if (prevStates.length > 0) {
          let bestTrans = Number.POSITIVE_INFINITY;
          for (const prev of prevStates) {
            let t = 0;
            for (const a of assigns) {
              let minFor = Number.POSITIVE_INFINITY;
              if (prev.assigns.length === 0) minFor = 0;
              else {
                for (const pa of prev.assigns) minFor = Math.min(minFor, interCost(pa, a));
              }
              t += minFor;
            }
            bestTrans = Math.min(bestTrans, t);
          }
          trans = bestTrans;
        }
        const withShare = assigns.map((a) => ({
          ...a,
          extra: emitCost(a.event.midi, a.string, a.fret, chordName, accompaniment) + intraShare,
        }));
        solutions.push({ cost: costAcc + trans + withShare.reduce((s, a) => s + a.extra, 0), assigns: withShare });
        return;
      }
      const ev = kept[depth];
      for (const pos of candidateLists[depth]) {
        if (usedStrings.has(pos.string)) continue; // 硬约束 1
        usedStrings.add(pos.string);
        recurse(depth + 1, [...assigns, { event: ev, string: pos.string, fret: pos.fret }], costAcc);
        usedStrings.delete(pos.string);
      }
    };
    recurse(0, [], 0);
    return solutions;
  };

  // 全量尝试 → 不行则逐个丢低 clarity 事件
  let pool = keptPool;
  let sols = tryKeep(pool);
  while ((!sols || sols.length === 0) && pool.length > 1) {
    const droppedOne = pool[pool.length - 1];
    pool = pool.slice(0, pool.length - 1);
    dropped.push(droppedOne);
    sols = tryKeep(pool);
  }
  if (!sols || sols.length === 0) {
    if (pool.length === 0) return null;
    // 最后兜底：独立贪心（每事件取品位最低合法位置）
    const assigns: Assignment[] = [];
    const used = new Set<StringNumber>();
    for (const ev of pool) {
      const cands = candidatesFor(ev.midi, maxFret).filter((p) => !used.has(p.string));
      if (cands.length === 0) {
        dropped.push(ev);
        continue;
      }
      const pick = cands[0];
      used.add(pick.string);
      assigns.push({ event: ev, string: pick.string, fret: pick.fret });
    }
    if (assigns.length === 0) return null;
    const totalCost = assigns.reduce(
      (s, a) => s + emitCost(a.event.midi, a.string, a.fret, chordName, accompaniment),
      0,
    );
    return { assigns, kept: pool, dropped, totalCost };
  }

  sols.sort((a, b) => a.cost - b.cost);
  const best = sols[0];
  return { assigns: best.assigns, kept: pool, dropped, totalCost: best.cost };
}

/** 单事件候选 Top-3（按代价升序） */
export function topCandidates(
  midi: number,
  chordName: string,
  accompaniment: boolean,
  maxFret: number = MAX_FRET,
  prevRef?: { string: number; fret: number } | null,
): FretChoice[] {
  return candidatesFor(midi, maxFret)
    .map((pos) => {
      const e = emitCost(midi, pos.string, pos.fret, chordName, accompaniment);
      const t = prevRef ? interCost(prevRef, pos) : 0;
      return { string: pos.string, fret: pos.fret, cost: round2(e + t) };
    })
    .sort((a, b) => a.cost - b.cost || a.string - b.string)
    .slice(0, 3);
}

/**
 * ⑥ 主入口：按组串行 DP，返回全部事件结果（含 dropped）。
 * events 需按 startSec 升序。
 */
export function solveFretboard(events: readonly NoteEvent[], opts: FretboardOptions): DpResultNote[] {
  const accompaniment = opts.accompaniment ?? false;
  const maxFret = opts.maxFret ?? MAX_FRET;
  const steps = groupIntoSteps(events, opts.groupToleranceSec ?? 0.025);

  const chordAt = (tSec: number): string => {
    for (const seg of opts.chordSegs) {
      if (tSec >= seg.startSec && tSec < seg.endSec) return seg.name;
    }
    return '';
  };

  let prevStates: StepState[] = [{ cost: 0, assigns: [] }];
  const results: (DpResultNote | null)[] = new Array<DpResultNote | null>(events.length).fill(null);

  const putResult = (ev: NoteEvent, r: DpResultNote): void => {
    const idx = events.indexOf(ev);
    if (idx >= 0) results[idx] = r;
  };

  for (const { group } of steps) {
    const tRef = group[0]?.startSec ?? 0;
    const chordName = chordAt(tRef);
    const solution = solveStep(group, prevStates, chordName, accompaniment, maxFret);
    if (!solution) {
      // 无解（理论不该发生）：整组标 dropped
      for (const ev of group) {
        putResult(ev, {
          index: events.indexOf(ev),
          midi: ev.midi,
          string: 6,
          fret: 0,
          confidence: 0.2,
          candidates: [],
          dropped: true,
          clarity: ev.clarity,
        });
      }
      continue;
    }

    for (const a of solution.assigns) {
      const prevRef = prevStates[0]?.assigns[0] ?? null;
      const cands = topCandidates(a.event.midi, chordName, accompaniment, maxFret, prevRef);
      const chosenCost = clamp(
        emitCost(a.event.midi, a.string, a.fret, chordName, accompaniment) +
          (prevRef ? interCost(prevRef, a) : 0),
        0,
        COST_MAX,
      );
      const clarity = clamp(a.event.clarity, 0, 1);
      const confidence = clamp(round2((1 - chosenCost / COST_MAX) * (0.5 + 0.5 * clarity)), 0, 1);
      putResult(a.event, {
        index: events.indexOf(a.event),
        midi: a.event.midi,
        string: a.string,
        fret: a.fret,
        confidence,
        candidates: cands,
        dropped: false,
        clarity,
      });
    }

    for (const ev of solution.dropped) {
      putResult(ev, {
        index: events.indexOf(ev),
        midi: ev.midi,
        string: 6,
        fret: 0,
        confidence: 0.2,
        candidates: [],
        dropped: true,
        clarity: clamp(ev.clarity, 0, 1),
      });
    }

    prevStates = solution.assigns.length > 0 ? [{ cost: solution.totalCost, assigns: solution.assigns }] : prevStates;
  }

  // 按原始顺序输出（理论每个事件都应有结果；防御性兜底 dropped）
  return events.map((ev, idx) => {
    const r = results[idx];
    if (r) return r;
    return {
      index: idx,
      midi: ev.midi,
      string: 6 as StringNumber,
      fret: 0,
      confidence: 0.2,
      candidates: [],
      dropped: true,
      clarity: clamp(ev.clarity, 0, 1),
    };
  });
}
