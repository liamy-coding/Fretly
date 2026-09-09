/**
 * staffFingering 全局把位 Viterbi（DP）改造的专项验证。
 *
 * 覆盖：
 *   1. 反例：DP 总移动代价 ≤ 贪心，且在构造的反例上严格更优
 *   2. 正确性不回归：单音/和弦既有用例仍通过
 *   3. 和弦间平滑：旋律 → 和弦 → 旋律 不突变
 *   4. DP 和弦回填不串位（round-trip）
 *   5. 边界：空、无合法位置、单音、纯和弦
 */
import { describe, expect, it } from 'vitest';
import {
  assignChord,
  assignFingering,
  assignMelody,
  moveCost,
  type FretPosition,
  type StaffNote,
} from '@/core/staffFingering';
import { allPositions, fretToMidi } from '@/core/fretboard';
import { MAX_FRET } from '@/core/constants';

function staff(midi: number, tick = 0, extra: Partial<StaffNote> = {}): StaffNote {
  return { midi, tick, durationTick: 480, ...extra };
}

/** 旧版逐音贪心（作为对比基准，独立复刻，不调用被测的 DP） */
function greedyMelody(midis: number[]): (FretPosition | null)[] {
  let prev: FretPosition | null = null;
  return midis.map((m) => {
    const cands = allPositions(m, MAX_FRET);
    if (cands.length === 0) return null;
    const best = prev ? cands.reduce((a, b) => (moveCost(a, prev!) < moveCost(b, prev!) ? a : b)) : cands[0];
    prev = best;
    return best;
  });
}

/** 连续非空位置的 moveCost 总和 */
function totalMoveCost(positions: (FretPosition | null)[]): number {
  let prev: FretPosition | null = null;
  let sum = 0;
  for (const p of positions) {
    if (p && prev) sum += moveCost(p, prev);
    if (p) prev = p;
  }
  return sum;
}

describe('staffFingering DP —— 全局 Viterbi 优于逐音贪心', () => {
  it('反例 D4-F4-A4：贪心局部最近导致大跳，DP 全局更省', () => {
    const midis = [62, 65, 69]; // D4, F4, A4（D 小三和弦分解上行）
    const dp = assignMelody(midis);
    const greedy = greedyMelody(midis);

    // 贪心：D4(2:3) → F4 贪近走 1:1 → A4 被迫 1:5（一次 4 品大跳）
    expect(greedy).toEqual([
      { string: 2, fret: 3 },
      { string: 1, fret: 1 },
      { string: 1, fret: 5 },
    ]);
    // DP：D4(2:3) → F4 留 2:6（多走一点）→ A4 顺接 1:5，省掉大跳
    expect(dp).toEqual([
      { string: 2, fret: 3 },
      { string: 2, fret: 6 },
      { string: 1, fret: 5 },
    ]);

    const greedyCost = totalMoveCost(greedy);
    const dpCost = totalMoveCost(dp);
    expect(dpCost).toBeLessThan(greedyCost);
    expect(greedyCost - dpCost).toBeCloseTo(1.0, 5);
  });

  it('DP 总代价永不超过贪心（同一首音锚定的搜索空间包含贪心路径）', () => {
    // 多组旋律，DP 结果代价必须 ≤ 贪心
    const cases: number[][] = [
      [64, 57],
      [40, 45, 50, 55],
      [60, 64, 67, 71],
      [67, 64, 60],
    ];
    for (const midis of cases) {
      const dpCost = totalMoveCost(assignMelody(midis));
      const greedyCost = totalMoveCost(greedyMelody(midis));
      expect(dpCost).toBeLessThanOrEqual(greedyCost);
    }
  });
});

describe('staffFingering DP —— 正确性不回归', () => {
  it('E4→弦1品0、A3→弦3品2、E2→弦6品0', () => {
    expect(assignMelody([64])).toEqual([{ string: 1, fret: 0 }]);
    expect(assignMelody([57])).toEqual([{ string: 3, fret: 2 }]);
    expect(assignMelody([40])).toEqual([{ string: 6, fret: 0 }]);
  });

  it('C4/E4/G4 和弦：弦互异、无同弦冲突、低把位', () => {
    const pos = assignChord([60, 64, 67]);
    const placed = pos.filter((p): p is NonNullable<typeof p> => p !== null);
    expect(placed).toHaveLength(3);
    expect(new Set(placed.map((p) => p.string)).size).toBe(3);
    const frets = placed.map((p) => p.fret);
    expect(Math.max(...frets) - Math.min(...frets)).toBeLessThanOrEqual(4);
  });
});

describe('staffFingering DP —— 和弦间平滑', () => {
  it('旋律 → 和弦 → 旋律：和弦取紧凑把位、尾音同把位连贯', () => {
    const notes = assignFingering([
      staff(40, 0), // E2 低把位旋律
      staff(64, 480), // E4 ┐
      staff(67, 480), // G4 ┘ 和弦
      staff(67, 960), // G4 旋律
    ]);
    const chord = notes.filter((n) => n.startTick === 480).sort((a, b) => a.fret - b.fret);
    const tail = notes.find((n) => n.startTick === 960)!;

    // 和弦未为贴近 E2 而撑成 0–8 品，而是取紧凑把位（品差 ≤ 4）
    const frets = chord.map((n) => n.fret);
    expect(Math.max(...frets) - Math.min(...frets)).toBeLessThanOrEqual(4);

    // 尾音 G4 与和弦内 G4 同把位（1 弦 3 品），不跳把位
    expect(tail).toMatchObject({ string: 1, fret: 3 });
    expect(chord.some((n) => n.string === 1 && n.fret === 3)).toBe(true);
  });
});

describe('staffFingering DP —— 回填不串位', () => {
  it('DP 和弦结果逐项 round-trip 回原 midi（multiset 相等）', () => {
    const midis = [60, 64, 67];
    const notes = assignFingering(midis.map((m) => staff(m, 0)));
    const got = notes.map((n) => fretToMidi(n.string, n.fret)).sort((a, b) => a - b);
    expect(got).toEqual([...midis].sort((a, b) => a - b));
  });

  it('折叠音 + 正常音同 tick 和弦不串位（47 与 64 各自 round-trip）', () => {
    const notes = assignFingering([staff(35), staff(64)]);
    const got = notes.map((n) => fretToMidi(n.string, n.fret)).sort((a, b) => a - b);
    expect(got).toEqual([47, 64]);
  });
});

describe('staffFingering DP —— 边界', () => {
  it('空序列返回空', () => {
    expect(assignMelody([])).toEqual([]);
    expect(assignFingering([])).toEqual([]);
  });

  it('无合法位置返回 null 项', () => {
    expect(assignMelody([30])).toEqual([null]);
    expect(assignMelody([100])).toEqual([null]);
  });

  it('单音返回最低把位', () => {
    expect(assignMelody([64])).toEqual([{ string: 1, fret: 0 }]);
    const notes = assignFingering([staff(64)]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ string: 1, fret: 0, stroke: null });
  });

  it('纯和弦序列：各弦互异、round-trip、默认 D', () => {
    const notes = assignFingering([
      staff(60, 0),
      staff(64, 0),
      staff(67, 0),
      staff(62, 480),
      staff(65, 480),
      staff(69, 480),
    ]);
    expect(notes).toHaveLength(6);
    const byTick = new Map<number, typeof notes>();
    for (const n of notes) {
      if (!byTick.has(n.startTick)) byTick.set(n.startTick, []);
      byTick.get(n.startTick)!.push(n);
    }
    for (const [, grp] of byTick) {
      expect(grp.every((n) => n.stroke === 'D')).toBe(true);
      expect(new Set(grp.map((n) => n.string)).size).toBe(grp.length);
    }
  });
});

describe('staffFingering DP —— QA 复核回归修复', () => {
  it('Bug1：不可能互异弦分配（E2+G2 同 tick）优雅降级、不崩溃', () => {
    // E2(40) 与 G2(43) 都只能落 6 弦，无法互异分配
    const notes = assignFingering([staff(40, 0), staff(43, 0)]);
    expect(notes).toHaveLength(1);
    expect(notes[0].string).toBe(6);
    expect(fretToMidi(notes[0].string, notes[0].fret)).toBe(43);
  });

  it('Bug1：同 tick 超过 6 音（7 音）不崩溃，丢最低音、其余落位', () => {
    const midis = [60, 62, 64, 65, 67, 69, 71];
    const notes = assignFingering(midis.map((m) => staff(m, 0)));
    expect(notes).toHaveLength(6); // 7 音 > 6 弦，最低音 60 被丢弃
    expect(new Set(notes.map((n) => n.string)).size).toBe(6);
    const got = notes.map((n) => fretToMidi(n.string, n.fret)).sort((a, b) => a - b);
    expect(got).toEqual([62, 64, 65, 67, 69, 71]);
  });

  it('Bug2：跨和弦序列 [E2, G4/B4/D5, E2] 不选跨 12 品的不可弹把位', () => {
    const notes = assignFingering([
      staff(40, 0), // E2
      staff(67, 480), // G4 ┐
      staff(71, 480), // B4 ├ 和弦
      staff(74, 480), // D5 ┘
      staff(40, 960), // E2
    ]);
    const chord = notes.filter((n) => n.startTick === 480);
    expect(chord).toHaveLength(3);
    const frets = chord.map((n) => n.fret);
    // 不再选中品差 12 的离群把位，回到紧凑合理把位
    expect(Math.max(...frets) - Math.min(...frets)).toBeLessThanOrEqual(6);
    expect(Math.max(...frets) - Math.min(...frets)).toBeLessThanOrEqual(4);
    // round-trip 不串位
    const got = chord.map((n) => fretToMidi(n.string, n.fret)).sort((a, b) => a - b);
    expect(got).toEqual([67, 71, 74]);
  });
});
