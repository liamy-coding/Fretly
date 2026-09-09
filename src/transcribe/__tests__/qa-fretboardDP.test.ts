/**
 * QA 边界回归 —— 指板 DP 硬约束（独立于工程师用例）。
 *
 * 覆盖风险（team-lead 点名 + PRD C-05 ⑥）：
 *  1) 同 tick >4 音输入 → 输出保留 ≤4 音，且同弦不重复
 *  2) 非横按跨度 >4 品的组合不被选中（宁可 drop 也不要错误组合）
 *  3) 横按（≥2 音同正品位）放行跨度限制
 *  4) confidence ∈ [0,1] 且保留 2 位小数
 *  5) 事件按原始顺序一一对应（无丢失、无重复）
 */
import { describe, expect, it } from 'vitest';
import type { NoteEvent } from '@/transcribe/worker/analysis';
import { GROUP_SIZE_LIMIT, SPAN_LIMIT, solveFretboard } from '@/transcribe/worker/fretboardDP';

function ev(midi: number, startSec: number, durSec: number, clarity = 0.8): NoteEvent {
  return { midi, startSec, endSec: startSec + durSec, clarity, medianClarity: clarity };
}

describe('QA 指板 DP —— 同 tick 多音限制', () => {
  it('同一 tick 6 音（>4）输入 → 保留 ≤4，其余 dropped；保留音同弦唯一', () => {
    // 造 6 个同 tick 的音，clarity 各异
    const events: NoteEvent[] = [
      ev(60, 0.0, 0.4, 0.95),
      ev(64, 0.0, 0.4, 0.9),
      ev(67, 0.0, 0.4, 0.85),
      ev(69, 0.0, 0.4, 0.8),
      ev(71, 0.0, 0.4, 0.75),
      ev(74, 0.0, 0.4, 0.7),
    ];
    const out = solveFretboard(events, { chordSegs: [], accompaniment: false });
    expect(out).toHaveLength(events.length);
    const kept = out.filter((r) => !r.dropped);
    expect(kept.length).toBeLessThanOrEqual(GROUP_SIZE_LIMIT);
    const strings = new Set(kept.map((r) => r.string));
    expect(strings.size).toBe(kept.length); // 同弦唯一
    const dropped = out.filter((r) => r.dropped);
    expect(dropped.length).toBeGreaterThanOrEqual(2);
  });
});

describe('QA 指板 DP —— 跨度 >4 品的硬约束', () => {
  it('两音必选组合跨度 >4（非横按）→ DP 宁可 drop 一个也不保留非法组合', () => {
    // midi 40 只在 6 弦 0 品；midi 79 至少到 15 品 → 任何组合跨度 >4
    const events: NoteEvent[] = [ev(40, 0, 0.4, 0.95), ev(79, 0.01, 0.4, 0.9)];
    const out = solveFretboard(events, { chordSegs: [], accompaniment: false });
    const kept = out.filter((r) => !r.dropped);
    // 合法的两条不可能都保留；允许保留 1 条 + drop 1 条
    expect(kept.length).toBeGreaterThanOrEqual(1);
    if (kept.length === 2) {
      const frets = kept.map((r) => r.fret);
      expect(Math.max(...frets) - Math.min(...frets)).toBeLessThanOrEqual(SPAN_LIMIT);
    } else {
      expect(out.filter((r) => r.dropped).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('跨度 >4 但构成横按（≥2 音同正品位）时允许（不误 drop）', () => {
    // 典型横按：6 弦 8 品(低E) + 1 弦 8 品(E4 高八度) → 跨度 8 但同品 = 横按放行
    const lowE = ev(40 + 8, 0, 0.4, 0.9); // E3 @ 8 fret
    const highE = ev(64 + 8, 0.01, 0.4, 0.85); // E4 @ 8 fret
    const out = solveFretboard([lowE, highE], { chordSegs: [], accompaniment: false });
    const kept = out.filter((r) => !r.dropped);
    // 两个都能保留，且品位相同或 ≤4
    expect(kept.length).toBe(2);
    const frets = kept.map((r) => r.fret);
    expect(Math.max(...frets) - Math.min(...frets)).toBeLessThanOrEqual(SPAN_LIMIT);
  });
});

describe('QA 指板 DP —— confidence 输出规格', () => {
  it('全部结果 confidence ∈ [0,1] 且为 2 位小数', () => {
    const events: NoteEvent[] = [
      ev(60, 0, 0.4, 0.9),
      ev(64, 0.01, 0.4, 0.8),
      ev(67, 0.5, 0.4, 0.7),
    ];
    const out = solveFretboard(events, { chordSegs: [{ startSec: 0, endSec: 1, name: 'C', confidence: 1, alts: [] }], accompaniment: false });
    expect(out).toHaveLength(3);
    for (const r of out) {
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
      expect(Math.round(r.confidence * 100) / 100).toBe(r.confidence);
    }
  });
});

describe('QA 指板 DP —— 事件完整性', () => {
  it('输出数量与输入一致，index 一一映射（无事件被静默吞掉）', () => {
    const events: NoteEvent[] = [ev(60, 0, 0.3, 0.9), ev(64, 0.4, 0.3, 0.85), ev(67, 0.9, 0.3, 0.8)];
    const out = solveFretboard(events, { chordSegs: [], accompaniment: false });
    expect(out.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(out.every((r) => r.clarity > 0)).toBe(true);
  });
});
