/**
 * staffFingering 绝对把位代价（修复「五线谱 → 六线谱指法分配的高把位漂移」）专项验证。
 *
 * 缺陷背景（真实 MusicXML：`Mama who bore me.xml`，单谱表钢琴轨走五线谱回退路径）：
 * 旧目标函数只最小化相邻节点的**转移代价** `moveCost`，没有任何**绝对把位偏好**。
 * 于是 DP 一旦被高音（A5 只能落 1 弦 17 品 / 2 弦 22 品）逼上高把位，就会顺着
 * 「就近转移」永远滞留在高把位盆地——同一音高 A4 在第 1 小节里分别落到
 * 1 弦 5 品、4 弦 19 品、5 弦 24 品，全曲最高 24 品、小节内跨度平均 19.7 品。
 *
 * 修复：目标函数加入**绝对把位代价** `positionCost`（手位延伸 + 无谓上把位滞留），
 * 见 `src/core/constants.ts` 的 POSITION_EXTENSION_COST / HAND_SPAN_FRETS /
 * OVER_REACH_PENALTY。本文件验证：
 *   1. 【判别性】真实缺陷片段：高音结束后手位回落，不再滞留高把位（修复前必红）。
 *   2. 【反过拟合】非本文件的旋律：不该无谓地上高把位（旧目标会「整条滑上某根弦」）。
 *   3. 【不过度矫正】真正需要高把位的旋律不得被拖到低把位。
 *   4. 新目标（绝对把位代价 + 转移代价）下 DP 仍优于逐音贪心。
 */
import { describe, expect, it } from 'vitest';
import {
  assignFingering,
  assignMelody,
  chordRepresentative,
  melodyAssignmentCost,
  moveCost,
  type FretPosition,
  type StaffNote,
} from '@/core/staffFingering';
import { allPositions, fretToMidi } from '@/core/fretboard';
import { MAX_FRET } from '@/core/constants';

/**
 * 旧版逐音贪心（独立复刻，仅以导出的 `moveCost` 为局部标准）。
 * 作为「无全局规划」的对照基准。
 */
function greedyMelody(midis: number[]): (FretPosition | null)[] {
  let prev: FretPosition | null = null;
  return midis.map((m) => {
    const cands = allPositions(m, MAX_FRET);
    if (cands.length === 0) return null;
    const best = prev
      ? cands.reduce((a, b) => (moveCost(a, prev!) < moveCost(b, prev!) ? a : b))
      : cands[0];
    prev = best;
    return best;
  });
}

/** 取非空位置（测试断言用；本文件用例均无超界音，故不应有 null） */
function placed(pos: (FretPosition | null)[]): FretPosition[] {
  return pos.filter((p): p is FretPosition => p !== null);
}

/** 某个音高在结果里的所有品位 */
function fretsFor(midis: number[], positions: (FretPosition | null)[], midi: number): number[] {
  const out: number[] = [];
  positions.forEach((p, i) => {
    if (p && midis[i] === midi) out.push(p.fret);
  });
  return out;
}

// ── 1. 判别性用例：真实缺陷片段 ──────────────────────────────────
// 第 1 小节（14 个音，A 小三度琶音的钢琴谱），来自 `Mama who bore me.xml`。
const BAR_1 = [57, 69, 81, 69, 76, 69, 72, 60, 69, 81, 69, 79, 69, 72];

describe('把位代价 —— 真实缺陷片段：高把位不滞留', () => {
  it('[A4 A5 A4]：被 A5 逼上 17 品后，A4 回落，不落在 4 弦 19 品', () => {
    const [a4a, a5, a4b] = assignMelody([69, 81, 69]).map((p) => p!);
    // 首音锚定最低把位：A4 的最低可行位是 1 弦 5 品
    expect(a4a).toEqual({ string: 1, fret: 5 });
    // A5(81) 只能在 1 弦 17 品 / 2 弦 22 品 → 必取其最低可行位
    expect(a5).toEqual({ string: 1, fret: 17 });
    // 紧接的 A4 必须回到「自身最低可行品（1 弦 5 品）+ 一个手位跨度」以内，
    // 而不是为了贴近 A5 而滞留在 4 弦 19 品（修复前行为）。
    expect(a4b.fret).toBeLessThanOrEqual(10);
    expect(a4b.fret).toBeLessThan(a5.fret);
    // 修复前：A4 会落在 4 弦 19 品（fret 19 > 10）
  });

  it('第 1 小节全 14 音：最高不超过 A5 自身最低品（17），A4 只用 ≤2 个品位', () => {
    const pos = assignMelody(BAR_1);
    const frets = placed(pos).map((p) => p.fret);

    // 本小节最高的音是 A5(81)，其最低可行品即 17 → 不该出现任何 >17 的品。
    // 修复前：本小节用到 21/22/24 品。
    expect(Math.max(...frets)).toBeLessThanOrEqual(17);

    // 同一个音高 A4(69) 在本小节内不应横跨多个把位（修复前：5 / 19 / 24 品）。
    expect(new Set(fretsFor(BAR_1, pos, 69)).size).toBeLessThanOrEqual(2);
    expect(Math.max(...fretsFor(BAR_1, pos, 69))).toBeLessThanOrEqual(10);

    // C4(60) 的最低可行品是 2 弦 1 品；修复前被塞到 6 弦 20 品。
    expect(Math.max(...fretsFor(BAR_1, pos, 60))).toBeLessThanOrEqual(7);
  });

  it('[C4 C6 C4]：C6 只能 1 弦 20 品，随后 C4 不滞留在 6 弦 20 品', () => {
    const [c4a, c6, c4b] = assignMelody([60, 84, 60]).map((p) => p!);
    expect(c4a).toEqual({ string: 2, fret: 1 });
    expect(c6).toEqual({ string: 1, fret: 20 });
    expect(c4b.fret).toBeLessThanOrEqual(7); // 修复前：6 弦 20 品
  });
});

// ── 2. 反过拟合用例：不是来自本文件，同样检验「不该无谓上高把位」──
describe('把位代价 —— 反过拟合：通用旋律不上高把位', () => {
  it('C 大调音阶落在开放把位（不得整条滑上第 2 弦到 13 品）', () => {
    // C4 D4 E4 F4 G4 A4 B4 C5。旧目标把整条音阶塞到 2 弦 1–13 品（无跨弦即最省转移），
    // 这是「只优化转移、无绝对把位代价」的通用失效模式，与本文件无关。
    const scale = [60, 62, 64, 65, 67, 69, 71, 72];
    const pos = assignMelody(scale);
    expect(Math.max(...placed(pos).map((p) => p.fret))).toBeLessThanOrEqual(8);
    // 且与旧贪心的「整条滑上第 2 弦」明显不同
    expect(Math.max(...placed(greedyMelody(scale)).map((p) => p.fret))).toBeGreaterThanOrEqual(12);
  });

  it('下行 E4→A3 保持在开放把位（≤3 品）', () => {
    const pos = assignMelody([64, 62, 60, 59, 57]);
    expect(Math.max(...placed(pos).map((p) => p.fret))).toBeLessThanOrEqual(3);
  });
});

// ── 3. 不过度矫正：真正需要高把位的旋律不得被拖低 ────────────────
describe('把位代价 —— 不过度矫正', () => {
  it('E5/F5/G5/A5 高位旋律仍留在高把位（≥12 品），不被强行拖到低把位', () => {
    const pos = placed(assignMelody([76, 77, 79, 81, 76, 77, 79, 81]));
    expect(Math.min(...pos.map((p) => p.fret))).toBeGreaterThanOrEqual(12);
    // 音高必须逐一可弹（绝不改编音高）
    expect(pos).toHaveLength(8);
  });
});

// ── 4. 首节点锚定语义统一（旋律 / 和弦一致）─────────────────────
describe('把位代价 —— 首节点锚定：和弦与旋律同语义（取 positionCost 最小候选）', () => {
  const staff = (midi: number, tick = 0): StaffNote => ({ midi, tick, durationTick: 480 });

  it('同一双音 {C#5(73), A3(57)} 无论在小节首音还是中间音，都不被锚到高把位', () => {
    // 小节首音 = 被 viterbi 锚定的节点。旧实现取候选数组的 reps[0]，
    // 对和弦而言 =「品差最小」的 voicing = (3,18)+(6,17)（17/18 品）——
    // 同一个双音在小节中间时却由 positionCost 选到低把位，二者不一致。
    const leading = assignFingering([staff(73, 0), staff(57, 0)]);
    expect(leading).toHaveLength(2);
    expect(new Set(leading.map((n) => n.string)).size).toBe(2); // 弦互异
    expect(Math.max(...leading.map((n) => n.fret))).toBeLessThanOrEqual(12); // 旧：18

    // 同一双音出现在小节中间（前面有低把位旋律音）→ 同样落在低把位区间
    const mid = assignFingering([staff(69, 0), staff(73, 480), staff(57, 480)]);
    const midChord = mid.filter((n) => n.startTick === 480);
    expect(midChord).toHaveLength(2);
    expect(Math.max(...midChord.map((n) => n.fret))).toBeLessThanOrEqual(12); // 旧：18

    // 两处一致的 voicing（同一双音不因位置不同而漂移）
    const sortKey = (ns: typeof leading) => ns.map((n) => `${n.string}:${n.fret}`).join(' ');
    expect(sortKey(leading)).toBe(sortKey(midChord));
  });

  it('锚定不串位：首音双音两音各自 round-trip', () => {
    const notes = assignFingering([staff(73, 0), staff(57, 0)]);
    const got = notes.map((n) => fretToMidi(n.string, n.fret)).sort((a, b) => a - b);
    expect(got).toEqual([57, 73]);
  });

  it('旋律锚定零变化：首音仍取该音最低可行位（A4→1:5、A3→3:2、E4→1:0）', () => {
    expect(assignMelody([69, 81, 69])[0]).toEqual({ string: 1, fret: 5 });
    expect(assignMelody([57, 69])[0]).toEqual({ string: 3, fret: 2 });
    expect(assignMelody([64, 62])[0]).toEqual({ string: 1, fret: 0 });
  });
});

// ── 5. 新目标下 DP 仍优于逐音贪心 ────────────────────────────────
describe('把位代价 —— 新目标（绝对把位代价 + 转移代价）下 DP ≤ 贪心', () => {
  it('多组旋律：DP 目标代价 ≤ 贪心目标代价', () => {
    const cases: number[][] = [
      [64, 57],
      [40, 45, 50, 55],
      [60, 64, 67, 71],
      [67, 64, 60],
      BAR_1,
      [60, 62, 64, 65, 67, 69, 71, 72],
      [69, 81, 69],
    ];
    for (const midis of cases) {
      const dp = assignMelody(midis);
      const greedy = greedyMelody(midis);
      expect(melodyAssignmentCost(midis, dp)).toBeLessThanOrEqual(
        melodyAssignmentCost(midis, greedy) + 1e-9,
      );
    }
  });

  it('判别力：至少一条旋律上 DP 目标严格优于贪心', () => {
    // [A4 A5 A4]：贪心滞留在 4 弦 19 品，DP 回落到 2 弦 10 品
    const midis = [69, 81, 69];
    const dp = assignMelody(midis);
    const greedy = greedyMelody(midis);
    expect(melodyAssignmentCost(midis, dp)).toBeLessThan(melodyAssignmentCost(midis, greedy));
    // C 大调音阶：DP 停在 ≤8 品，贪心滑到 13 品（目标更差）
    const scale = [60, 62, 64, 65, 67, 69, 71, 72];
    expect(melodyAssignmentCost(scale, assignMelody(scale))).toBeLessThan(
      melodyAssignmentCost(scale, greedyMelody(scale)),
    );
  });
});

// ── 6. 和弦代表点 `chordRepresentative` 的 argmin 语义 ─────────────
// 缺陷背景：`chordRepresentative`（品重心「取距品均值最近者」）曾在 argmin 循环里
// 只更新 `rep` 却**忘记刷新 `bestDist`**：于是循环始终拿「初始阈值」（首个位置的
// 距离）做判据，只要后续位置距离小于**初始值**就覆盖 `rep`，最终停在「最后一个
// 距离仍小于初始阈值」的位置，而非真正的最近者。
//
// 该缺陷本身在旧路径下被「首节点取 reps[0]」掩盖（代表点只影响候选排序，不进目标
// 函数）；Round 2 引入「首节点取 positionCost 最小候选」后，代表点进入 `cost`，
// 缺陷被暴露：三音和弦 [56,60,64]（G#3/C4/E4）作为小节首音，被错选为
// (1,0)(2,1)(4,6)（跨度 6，需横跨 5 品），而正确答案是 (1,0)(2,1)(3,1)（跨度 1）。
describe('把位代价 —— 和弦代表点 argmin 语义（bestDist 必须随 rep 刷新）', () => {
  const staff = (midi: number, tick = 0): StaffNote => ({ midi, tick, durationTick: 480 });

  it('判别性：[56,60,64] 作为小节首音 → 紧凑 voicing（跨度 ≤1 且最高 ≤1 品）', () => {
    // 修复前（bestDist 不刷新）：代表点落到 (4,6) → viterbi 首节点锚到该候选，
    // 输出 1:0 2:1 4:6（fret 跨度 6）。修复后：代表点为 (3,1) → 输出 1:0 2:1 3:1。
    const notes = assignFingering([staff(56, 0), staff(60, 0), staff(64, 0)]);
    expect(notes).toHaveLength(3);
    expect(new Set(notes.map((n) => n.string)).size).toBe(3); // 弦互异
    const frets = notes.map((n) => n.fret).sort((a, b) => a - b);
    // 跨度（max−min）≤1：旧缺陷会得到 6。
    expect(Math.max(...frets) - Math.min(...frets)).toBeLessThanOrEqual(1);
    // 最高品 ≤1：旧缺陷会得到 6。
    expect(Math.max(...frets)).toBeLessThanOrEqual(1);
    // 音高保真：三音逐一 round-trip
    const got = notes.map((n) => fretToMidi(n.string, n.fret)).sort((a, b) => a - b);
    expect(got).toEqual([56, 60, 64]);
  });

  it('直接锁定语义：argmin 取真正离品均值最近者（非「最后一个仍小于初始阈值」者）', () => {
    // 品 = [10, 4, 7, 5]，均值 = 6.5：
    //   10 → 距 3.5（初始阈值）；4 → 2.5；7 → 0.5（真最小）；5 → 1.5。
    // 正确 = 7（品 7，弦 4）。缺陷版会把 rep 覆盖到「最后一个距离 < 3.5」的 5（弦 3）。
    const rep = chordRepresentative([
      { string: 6, fret: 10 },
      { string: 5, fret: 4 },
      { string: 4, fret: 7 },
      { string: 3, fret: 5 },
    ]);
    expect(rep).toEqual({ string: 4, fret: 7 });
    // 缺陷版会得到 { string: 3, fret: 5 } —— 显式排除，确保变异必红。
    expect(rep).not.toEqual({ string: 3, fret: 5 });
  });

  it('平局 tie-break：距均值相等时取弦号更大者（低音弦）', () => {
    // 品 = [6, 4]，均值 = 5，两位置距离均为 1 → 取弦号更大者（5 > 4）。
    const rep = chordRepresentative([
      { string: 4, fret: 6 },
      { string: 5, fret: 4 },
    ]);
    expect(rep).toEqual({ string: 5, fret: 4 });
  });

  it('退化输入：空数组返回 null，单元素返回自身', () => {
    expect(chordRepresentative([])).toBeNull();
    expect(chordRepresentative([null, null])).toBeNull();
    const only = [{ string: 2 as const, fret: 3 }];
    expect(chordRepresentative(only)).toEqual({ string: 2, fret: 3 });
    // 含 null 的混合输入：null 被忽略，代表点在有效位置中取
    expect(chordRepresentative([{ string: 1, fret: 2 }, null, { string: 3, fret: 2 }])).toEqual({
      string: 3,
      fret: 2,
    });
  });
});

// ── 7. 和弦绝对代价基准 = 声部「最高品位」（把位）──────────────────
// 缺陷背景：和弦的绝对代价若用「品重心」代表点，含空弦的宽跨度声部会把重心拉到
// 低品 → 代价低 → 胜出，哪怕该声部要跨十几品：
//   [40,64,72] 曾被选成 `1:0 2:13 6:0`（跨 13 品，代表点品 0）而非 `1:8 2:5 6:0`。
// 若改用「品差（跨度）」作代价，又会把空弦也算作一个「位置」→「空弦 + 1 品」(跨 1)
// 输给「5 品 + 5 品」(跨 0) → 双音/真实和弦被整体推上高把位（见第 8 节，R4 过校正）。
// 终解：绝对代价以**声部最高品位**为手位基准（手必须够到最高按弦音）；空弦天然不抬高
// `max`；且「品 ≥ 0 ⇒ 跨度 ≤ 最高品」，压低最高品即压住跨度上限；同一最高品内由候选
// 排序（跨度小优先）取最小跨度声部 → 等价「把位优先、跨度次之」，无需任何额外权重。
describe('和弦绝对代价 —— 以声部最高品位为基准', () => {
  const staff = (midi: number, tick = 0): StaffNote => ({ midi, tick, durationTick: 480 });
  const keyOf = (ns: { string: number; fret: number }[]): string =>
    [...ns].sort((a, b) => a.string - b.string).map((n) => `${n.string}:${n.fret}`).join(' ');

  it('判别性：[40,64,72] 作为首音和弦 → 紧凑声部（跨度 ≤8），不选跨 13 品的声部', () => {
    const notes = assignFingering([staff(40, 0), staff(64, 0), staff(72, 0)]);
    expect(notes).toHaveLength(3);
    expect(new Set(notes.map((n) => n.string)).size).toBe(3); // 弦互异
    const frets = notes.map((n) => n.fret);
    expect(Math.max(...frets) - Math.min(...frets)).toBeLessThanOrEqual(8);
    // 只按品重心会误选 `1:0 2:13 6:0`（跨 13）——显式排除。
    expect(keyOf(notes)).not.toBe('1:0 2:13 6:0');
    expect(notes.map((n) => fretToMidi(n.string, n.fret)).sort((a, b) => a - b)).toEqual([40, 64, 72]);
  });

  it('语义锁定：宽跨度声部的重心确实更低，但算法仍不选它（因为它的最高品更高）', () => {
    const wide: FretPosition[] = [
      { string: 1, fret: 0 },
      { string: 2, fret: 13 },
      { string: 6, fret: 0 },
    ];
    const compact: FretPosition[] = [
      { string: 1, fret: 8 },
      { string: 2, fret: 5 },
      { string: 6, fret: 0 },
    ];
    // 「陷阱」成立：宽跨度声部代表点品（0）低于紧凑声部（5）——只按重心会误选它。
    expect(chordRepresentative(wide)!.fret).toBeLessThan(chordRepresentative(compact)!.fret);
    // 但宽跨度声部的**最高品**（13）高于紧凑声部（8）→ 以最高品为基准时紧凑声部胜出。
    expect(Math.max(...wide.map((p) => p.fret))).toBeGreaterThan(Math.max(...compact.map((p) => p.fret)));
    const chosen = assignFingering([staff(40, 0), staff(64, 0), staff(72, 0)]);
    expect(keyOf(chosen)).toBe('1:8 2:5 6:0');
  });

  it('不倒退：Round-2/3 的两处修复仍成立', () => {
    // ① [56,60,64] 首音仍取最紧凑声部（跨 1 品）
    expect(keyOf(assignFingering([staff(56, 0), staff(60, 0), staff(64, 0)]))).toBe('1:0 2:1 3:1');
    // ② M19 双音 {C#5(73), A3(57)} 仍落低把位 1:9 4:7，不被压回 17/18 品
    expect(keyOf(assignFingering([staff(73, 0), staff(57, 0)]))).toBe('1:9 4:7');
  });

  it('旋律零影响：只改和弦候选，旋律指法逐条不变', () => {
    expect(assignMelody([69, 81, 69])[0]).toEqual({ string: 1, fret: 5 });
    expect(assignMelody([57, 69])[0]).toEqual({ string: 3, fret: 2 });
    expect(assignMelody([64, 62])[0]).toEqual({ string: 1, fret: 0 });
  });
});

// ── 8. R4 过校正回归防护：双音 / 真实和弦不得被推上高把位 ─────────
// R4 曾以「品差（跨度）」为和弦绝对代价的一部分，且把空弦（品 0）也算作一个位置，
// 于是「空弦 + 1 品」(跨 1) 输给「5 品 + 5 品」(跨 0) → 双音/真实和弦整体被推上高把位：
//   [60,64] → `2:5 3:5`、[76,80] → `2:21 3:21`、[55,62,67,71] → `2:12 3:12 4:12 5:10`。
// 本组用例锁死这一类不再复发（R5 改为「最高品」基准后全部回落）。
describe('和弦绝对代价 —— 双音/真实和弦不得被推上高把位（R4 过校正回归）', () => {
  const staff = (midi: number, tick = 0): StaffNote => ({ midi, tick, durationTick: 480 });
  const keyOf = (ns: { string: number; fret: number }[]): string =>
    [...ns].sort((a, b) => a.string - b.string).map((n) => `${n.string}:${n.fret}`).join(' ');
  const maxFretOf = (ms: number[]): number =>
    Math.max(...assignFingering(ms.map((m) => staff(m, 0))).map((n) => n.fret));

  it('[60,64] C4+E4 首音双音 → 1:0 2:1（maxFret ≤1），不选 2:5 3:5', () => {
    expect(keyOf(assignFingering([staff(60, 0), staff(64, 0)]))).toBe('1:0 2:1');
    expect(maxFretOf([60, 64])).toBeLessThanOrEqual(1);
  });

  it('[76,80] E5+G#5 → maxFret ≤17（R4 会到 21）', () => {
    expect(maxFretOf([76, 80])).toBeLessThanOrEqual(17);
  });

  it('[55,62,67,71] 真实主义四音 → maxFret ≤8（R4 会到 12）', () => {
    expect(maxFretOf([55, 62, 67, 71])).toBeLessThanOrEqual(8);
  });

  it('[64,68] / [48,64] / [72,76] 亦不被推高', () => {
    expect(maxFretOf([64, 68])).toBeLessThanOrEqual(5);
    expect(maxFretOf([48, 64])).toBeLessThanOrEqual(8);
    expect(maxFretOf([72, 76])).toBeLessThanOrEqual(13);
  });

  it('音高保真：以上用例逐一 round-trip，绝不改编音高', () => {
    for (const ms of [
      [60, 64],
      [76, 80],
      [55, 62, 67, 71],
      [64, 68],
      [48, 64],
      [72, 76],
    ]) {
      const got = assignFingering(ms.map((m) => staff(m, 0)))
        .map((n) => fretToMidi(n.string, n.fret))
        .sort((a, b) => a - b);
      expect(got).toEqual([...ms].sort((a, b) => a - b));
    }
  });
});
