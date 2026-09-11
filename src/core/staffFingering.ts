/**
 * 五线谱 → 六线谱 指法分配（增量设计 §1.3，T-03）。
 *
 * 音高已知 → 只做「指法分配」，不做「指板 DP 扒谱」。
 * 复用 `fretboard.allPositions` / `OPEN_MIDI` / `STRING_NUMBERS`，
 * **不自写任何 `6 - x` 方向换算**（架构 R6）。
 *
 * 输出带 `confidence` 的 `Note[]`；stroke 由 `strokeInference` 注入。
 * 被 MusicXML 五线谱路径与未来 OMR 共用。
 *
 * 把位分配策略（v3）：把整条「旋律单音 + 和弦组」按 tick 排序成一个连贯的
 * 把位序列，用动态规划（Viterbi）在全局范围内选择每个节点的指法位置，
 * 最小化整条指向序列的**总把位代价 = Σ 转移代价 + Σ 绝对把位代价**：
 *   - 转移代价 `moveCost`：相邻节点间的手部位移（沿琴颈 + 跨弦）。
 *   - 绝对把位代价 `positionCost`：手位本身的代价（手臂延伸 + 无谓的上把位滞留），
 *     **与邻居无关**。这是修复「高把位漂移」的关键：没有绝对项时，DP 一旦被高音
 *     逼上高把位，就会顺着「就近转移」永久锁死在高把位盆地（同一音高在同一小节里
 *     落到 1 弦 5 品、4 弦 19 品、5 弦 24 品）。
 *   - 每个旋律音节点有 `allPositions` 给出的有限候选（每音 ≤6）。
 *   - 每个和弦节点枚举所有「弦互异」的合法指位（回溯）：**转移代价**用「把位代表点」
 *     （品重心）度量位移，**绝对把位代价**用声部「最高品位」度量手位（见 `chordCandidates`）。
 *   - 首节点锚定绝对代价最小的候选（旋律与和弦语义统一）。
 */
import type { Midi, Note, StringNumber, Stroke, Tick } from '@/types/tab';
import {
  HAND_SPAN_FRETS,
  MAX_FRET,
  OVER_REACH_PENALTY,
  POSITION_EXTENSION_COST,
  START_ANCHOR_PENALTY,
  clamp,
  round2,
} from '@/core/constants';
import { allPositions } from '@/core/fretboard';
import { newId } from '@/core/id';
import { inferChordStroke } from '@/core/strokeInference';

/** 吉他可弹 MIDI 区间：E2=40 … E6=88 */
export const LO = 40;
export const HI = 88;

/** 折叠惩罚（使超音域音符 confidence < 0.45，进待确认清单） */
const FOLD_COST = 0.6;

export interface FretPosition {
  string: StringNumber;
  fret: number;
}

/** 五线谱中间音符（MusicXML 与 OMR 共用） */
export interface StaffNote {
  midi: Midi;
  /** 相对本小节起始的 tick 偏移 */
  tick: Tick;
  durationTick: number;
  velocity?: number;
  /** 显式琶音方向（仅同 tick 和弦组生效）：up = 低→高（下扫 D）、down = 高→低（上扫 U） */
  arpeggiate?: 'up' | 'down' | null;
  /** 分解（跨 tick 逐个拨弦）→ stroke 'P' */
  decomposed?: boolean;
}

/**
 * 超界折叠八度：超出 [E2, E6] 时按整八度折叠回区间，并标记 octaveShifted（降 confidence）。
 */
export function foldIntoRange(midi: Midi): { midi: Midi; octaveShifted: boolean } {
  if (midi < LO) return { midi: midi + 12 * Math.ceil((LO - midi) / 12), octaveShifted: true };
  if (midi > HI) return { midi: midi - 12 * Math.ceil((midi - HI) / 12), octaveShifted: true };
  return { midi, octaveShifted: false };
}

/**
 * 相邻音符移动代价：0.5×|Δfret| + 0.12×|Δstring|，空弦轻微奖励（-0.3）。
 * 导出以支持测试独立校验「DP 总代价 ≤ 贪心总代价」。
 *
 * 这是**转移**代价（相对量）：只描述「从上一个位置挪到当前位置」的位移，
 * 不含任何绝对把位偏好；绝对把位偏好由 `positionCost` 承担。
 */
export function moveCost(p: FretPosition, prev: FretPosition): number {
  return 0.5 * Math.abs(p.fret - prev.fret) + 0.12 * Math.abs(p.string - prev.string) + (p.fret === 0 ? -0.3 : 0);
}

/**
 * 绝对「把位代价」：把一个候选 (string, fret) 放在指板上的代价，**与相邻音符无关**。
 * 两项均有明确物理含义：
 *   1) `POSITION_EXTENSION_COST × fret`：手位越靠琴身，左臂前伸越多、静态张力越大。
 *   2) `OVER_REACH_PENALTY × max(0, fret − baseFret − HAND_SPAN_FRETS)`：「多余伸展」——
 *      候选比该节点自身最低可行把位 (`baseFret`) 高出一个手位跨度以外的部分，是**本可避免**
 *      的上把位滞留（该音在其最低把位完全弹得下），逐品计费。
 *
 * 第 2 项以节点自身最低品为基准（纯相对量），所以真正需要高把位的音不会被误罚。
 * `baseFret`：旋律音 = 该音的最低可行品；和弦 = 候选集里最低的「把位代表点」品位。
 */
function positionCost(p: FretPosition, baseFret: number): number {
  return (
    POSITION_EXTENSION_COST * p.fret +
    OVER_REACH_PENALTY * Math.max(0, p.fret - baseFret - HAND_SPAN_FRETS)
  );
}

/** 某音在指板上可用的最低品位（`allPositions` 已按品升序）；无合法位置返回 0 */
function lowestFeasibleFret(midi: Midi): number {
  const ps = allPositions(midi, MAX_FRET);
  return ps.length > 0 ? ps[0].fret : 0;
}

// ── 全局把位 Viterbi ──────────────────────────────────────────────

/** Viterbi 节点候选：一个「把位代表点」参与转移代价，外加该候选自身的绝对把位代价 */
interface ViterbiCandidate {
  representative: FretPosition | null;
  /** 该候选的绝对把位代价（`positionCost`）；无合法位置时为 0 */
  cost: number;
}

/** 由「旋律音的全部可弹位置」构造 Viterbi 候选（基准 = 该音最低可行品） */
function melodyCandidates(positions: FretPosition[]): ViterbiCandidate[] {
  if (positions.length === 0) return [{ representative: null, cost: 0 }];
  const baseFret = Math.min(...positions.map((p) => p.fret));
  return positions.map((p) => ({ representative: p, cost: positionCost(p, baseFret) }));
}

/**
 * 由「和弦的全部合法指位」构造 Viterbi 候选。
 *
 * 和弦的**绝对代价**以**声部最高品位**（该指位里最高的按弦品）为手位基准：
 * 手必须够到最高的那个按弦音，故「最高品」直接给出该声部所需的把位。
 * 空弦（品 0）天然不抬高 `max`，无需任何「排除空弦」的特判。
 * 基准 `baseFret` = 候选里最低的「最高品」（≈ 最高音自身的最低可行位）。
 *
 * 为什么不是「品重心」或「品差（跨度）」：
 *   - 品重心（`chordRepresentative`）会被空弦拉到低品，使「空弦 + 高品」的宽跨度声部
 *     显得位置很低而胜出（[40,64,72] 曾被选成 `1:0 2:13 6:0`，跨 13 品）。
 *   - 品差（跨度）把空弦也算作一个「位置」，使「空弦 + 1 品」(跨 1) 反而输给
 *     「5 品 + 5 品」(跨 0，小横按)，把双音/真实和弦整体推上高把位（R4 过校正）。
 *   - 最高品同时规避两者：它既不被空弦拉低，又因「品 ≥ 0 ⇒ 跨度 ≤ 最高品」而**天然
 *     压住跨度上限**；再叠加候选数组的排序（跨度小 → 代表点低 → 总品数小），
 *     同一最高品内由排列次序取到最小跨度声部，等价于「把位优先、跨度次之」的字典序，
 *     **无需任何额外权重**（故不再需要 `CHORD_SPAN_COST`）。
 *
 * 转移代价仍用代表点（品重心，`representative`）度量相邻节点的手部位移，语义不变：
 * 「手在哪（重心）」用于量位移，「手够多高（最高品）」用于量绝对把位，二者物理量不同、
 * 各司其职，不构成语义冲突。
 */
function chordCandidates(cands: ChordCandidate[]): ViterbiCandidate[] {
  const topFrets = cands.map((c) => {
    const fr = c.positions.filter((p): p is FretPosition => p !== null).map((p) => p.fret);
    return fr.length > 0 ? Math.max(...fr) : null;
  });
  const finite = topFrets.filter((f): f is number => f !== null);
  const baseFret = finite.length > 0 ? Math.min(...finite) : 0;
  return cands.map((c, i) => {
    const top = topFrets[i];
    return {
      representative: c.representative,
      cost:
        top === null
          ? 0
          : positionCost({ string: c.representative?.string ?? 1, fret: top }, baseFret),
    };
  });
}

/**
 * 对「把位序列」做 Viterbi 回溯，返回每个节点选中的候选下标。
 *
 * 目标函数 = Σ（绝对把位代价 `cost`） + Σ（相邻代表点的 `moveCost`）。
 * 转移代价：两代表点都存在时 = moveCost，否则 = 0（无合法位置不惩罚邻居）。
 *
 * **首节点锚定**：整条序列只能从「绝对把位代价最小」的首候选出发（旋律与和弦语义统一）。
 * 实现上给节点 0 的其余候选加 `START_ANCHOR_PENALTY`（有限大值），**不重排/不截断候选数组**，
 * 故 `path[0]` 仍直接索引原候选数组。
 *
 * 末节点并列时取下标最小（保持低把位优先的确定性）。
 */
function viterbi(nodes: ViterbiCandidate[][]): number[] {
  const n = nodes.length;
  if (n === 0) return [];

  const dp: number[][] = new Array(n);
  const back: number[][] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    // 首节点无入边，其累积代价即自身绝对把位代价；i≥1 在下面被覆盖。
    dp[i] = nodes[i].map((c) => c.cost);
    back[i] = new Array(nodes[i].length).fill(-1);
  }

  // 首节点锚定：只允许从绝对把位代价最小的候选出发（旋律/和弦统一）。
  // 用有限大惩罚压低其余候选，候选数组保持原样，回填下标不受影响。
  if (nodes[0].length > 1) {
    let best = 0;
    for (let j = 1; j < nodes[0].length; j += 1) {
      if (nodes[0][j].cost < nodes[0][best].cost) best = j;
    }
    for (let j = 0; j < nodes[0].length; j += 1) {
      if (j !== best) dp[0][j] += START_ANCHOR_PENALTY;
    }
  }

  for (let i = 1; i < n; i += 1) {
    const prevCands = nodes[i - 1];
    const curCands = nodes[i];
    for (let j = 0; j < curCands.length; j += 1) {
      const cur = curCands[j].representative;
      let best = Number.POSITIVE_INFINITY;
      let bestK = -1;
      for (let k = 0; k < prevCands.length; k += 1) {
        const prev = prevCands[k].representative;
        const step = cur !== null && prev !== null ? moveCost(cur, prev) : 0;
        const val = dp[i - 1][k] + step;
        if (val < best) {
          best = val;
          bestK = k;
        }
      }
      dp[i][j] = best + curCands[j].cost;
      back[i][j] = bestK;
    }
  }

  // 回溯：末节点取最小代价，并列取第一个（低把位优先）
  const path = new Array<number>(n).fill(0);
  let bestJ = 0;
  for (let j = 1; j < dp[n - 1].length; j += 1) {
    if (dp[n - 1][j] < dp[n - 1][bestJ]) bestJ = j;
  }
  path[n - 1] = bestJ;
  for (let i = n - 1; i >= 1; i -= 1) {
    path[i - 1] = back[i][path[i]];
  }
  return path;
}

/**
 * 旋律（单音序列）指法：全局 Viterbi（把位连贯性 + 绝对把位代价）。
 * 返回与输入同序的 (string, fret) 序列；无合法位置时为 null。
 * 首音由 `viterbi` 锚定到最低把位候选（该音最低可行品），与旧贪心一致。
 */
export function assignMelody(midis: Midi[]): (FretPosition | null)[] {
  if (midis.length === 0) return [];
  const candsPer = midis.map((m) => allPositions(m, MAX_FRET));
  const nodes: ViterbiCandidate[][] = candsPer.map((cands) => melodyCandidates(cands));
  const path = viterbi(nodes);
  return midis.map((_, i) => {
    const cands = candsPer[i];
    return cands.length > 0 ? cands[path[i]] : null;
  });
}

/**
 * 一条**旋律**指法序列在 DP 目标函数下的总代价：
 * `Σ 绝对把位代价(positionCost) + Σ 相邻转移代价(moveCost)`。
 *
 * 与 `assignMelody` 内部的目标完全一致，导出以便测试独立校验
 * 「DP 目标 ≤ 贪心目标」——在**新目标**（而非旧的纯移动代价）下仍然成立。
 * 无合法位置的音（null）不贡献绝对代价，也不参与相邻转移（与 DP 一致）。
 */
export function melodyAssignmentCost(midis: Midi[], positions: (FretPosition | null)[]): number {
  let prev: FretPosition | null = null;
  let sum = 0;
  for (let i = 0; i < midis.length; i += 1) {
    const p = positions[i];
    if (!p) continue;
    sum += positionCost(p, lowestFeasibleFret(midis[i]));
    if (prev) sum += moveCost(p, prev);
    prev = p;
  }
  return sum;
}

/**
 * 和弦（同 tick 多音）指法：按 MIDI 降序贪心分配不同弦（低音→低弦、低把位优先）。
 * 返回与输入同序的 (string, fret) 序列（内部按降序分配，但结果按原下标回填）。
 * 说明：`assignFingering` 的全局 DP 使用更丰富的 `enumerateChordCandidates`；
 * 本函数保持导出兼容，供外部单点和弦分配复用。
 */
export function assignChord(midis: Midi[]): (FretPosition | null)[] {
  const used = new Set<StringNumber>();
  const out: (FretPosition | null)[] = new Array(midis.length).fill(null);
  const order = midis.map((m, i) => ({ m, i })).sort((a, b) => b.m - a.m);
  for (const { m, i } of order) {
    const pick = allPositions(m, MAX_FRET).find((c) => !used.has(c.string)) ?? null;
    if (pick) used.add(pick.string);
    out[i] = pick;
  }
  return out;
}

function fretSpread(positions: (FretPosition | null)[]): number {
  const frets = positions.filter((p): p is FretPosition => p !== null).map((p) => p.fret);
  if (frets.length <= 1) return 0;
  return Math.max(...frets) - Math.min(...frets);
}

/** 和弦内所有有效位置的总品数（用于候选排序的确定性 tie-break） */
function chordFretSum(positions: (FretPosition | null)[]): number {
  return positions.reduce((sum, p) => sum + (p ? p.fret : 0), 0);
}

// ── 和弦候选枚举（全局 DP 用）────────────────────────────────────

/** 一个和弦指位候选：各音的位置（按原下标）+ 对外把位代表点 */
interface ChordCandidate {
  positions: (FretPosition | null)[];
  representative: FretPosition | null;
}

/**
 * 和弦把位代表点：品重心——取「距品均值最近」的音的位置（并列取最低音弦，弦号最大）。
 * 相比「最低品」，重心更能反映手部实际把位，避免为贴近相邻低音而撑开过大的和弦跨度。
 *
 * 注意：`bestDist` 必须随 `rep` 一同刷新——否则循环会一直用「初始阈值」判距离，
 * 把代表点换成「最后一个距离仍小于初始值」的位置，而非真正的最近者。
 * 导出以便测试直接锁定该语义。
 */
export function chordRepresentative(positions: (FretPosition | null)[]): FretPosition | null {
  const ps = positions.filter((p): p is FretPosition => p !== null);
  if (ps.length === 0) return null;
  const avg = ps.reduce((sum, p) => sum + p.fret, 0) / ps.length;
  let rep = ps[0];
  let bestDist = Math.abs(rep.fret - avg);
  for (const p of ps.slice(1)) {
    const d = Math.abs(p.fret - avg);
    if (d < bestDist || (d === bestDist && p.string > rep.string)) {
      rep = p;
      bestDist = d;
    }
  }
  return rep;
}

/** 人手可跨的最大品差：超过此跨度的和弦把位视为物理不可弹，直接过滤（除非别无选择） */
const MAX_CHORD_SPAN = 6;

/**
 * 枚举同 tick 和弦的所有「弦互异」合法指位（回溯分配不同弦）。
 * 每音候选 ≤6，注入映射总数 ≤ 6!/(6−n)!（n≤6 时 ≤720），无需裁剪。
 * 无合法位置的音返回 null。
 *
 * 两个不变量（QA 复核）：
 *   1. 若无任何完整「弦互异」分配（两音只能落同弦 / 同 tick 超过 6 音），退回旧
 *      `assignChord` 贪心语义兜底：可落位音正常落位、冲突音置 null 丢弃，绝不返回空。
 *   2. 过滤品差 > MAX_CHORD_SPAN 的过宽把位，避免 DP 为「贴近相邻低音」选中跨 12 品的
 *      不可弹和弦；仅当全部候选都超限时才保留兜底。
 * 排序按「品差小优先 → 代表点低把位优先 → 总品数小」保证确定性。
 */
function enumerateChordCandidates(midis: Midi[]): ChordCandidate[] {
  const perNote = midis.map((m) => allPositions(m, MAX_FRET));
  const out: ChordCandidate[] = [];
  const assign: (FretPosition | null)[] = new Array(midis.length).fill(null);
  const used = new Set<StringNumber>();

  const dfs = (i: number): void => {
    if (i === midis.length) {
      out.push({ positions: [...assign], representative: chordRepresentative(assign) });
      return;
    }
    const cands = perNote[i];
    if (cands.length === 0) {
      assign[i] = null;
      dfs(i + 1);
      return;
    }
    for (const c of cands) {
      if (used.has(c.string)) continue;
      used.add(c.string);
      assign[i] = c;
      dfs(i + 1);
      used.delete(c.string);
      assign[i] = null;
    }
  };
  dfs(0);

  // Bug1 降级：无任何完整分配时退回 assignChord 语义，保证候选集非空、不崩溃。
  if (out.length === 0) {
    const fallback = assignChord(midis);
    out.push({ positions: fallback, representative: chordRepresentative(fallback) });
  }

  // Bug2 过滤：剔除物理不可弹的过宽把位；全部超限才保留（兜底）。
  const playable = out.filter((c) => fretSpread(c.positions) <= MAX_CHORD_SPAN);
  if (playable.length > 0) {
    out.length = 0;
    out.push(...playable);
  }

  out.sort((a, b) => {
    // 紧凑把位优先（品差小）→ 低把位优先 → 总品数小优先（确定性）
    const sa = fretSpread(a.positions);
    const sb = fretSpread(b.positions);
    if (sa !== sb) return sa - sb;
    const fa = a.representative?.fret ?? Number.POSITIVE_INFINITY;
    const fb = b.representative?.fret ?? Number.POSITIVE_INFINITY;
    if (fa !== fb) return fa - fb;
    return chordFretSum(a.positions) - chordFretSum(b.positions);
  });
  return out;
}

/**
 * confidence = clamp(1 − cost, 0.3, 1)
 * cost：fret≥12 → +0.15；fret>15 → +0.25；octaveShifted → +0.6；和弦品差>4 → +0.15
 */
function confidenceFor(pos: FretPosition | null, folded: boolean, spreadExcess: boolean): number {
  if (!pos) return 0.3;
  let cost = 0;
  if (pos.fret >= 12) cost += 0.15;
  if (pos.fret > 15) cost += 0.25;
  if (folded) cost += FOLD_COST;
  if (spreadExcess) cost += 0.15;
  return round2(clamp(1 - cost, 0.3, 1));
}

function velocityForStroke(stroke: Stroke): number {
  if (stroke === 'D') return 0.85;
  if (stroke === 'U') return 0.65;
  return 0.75; // 'P' 分解 / null 旋律
}

interface FoldedStaffNote extends StaffNote {
  foldedMidi: Midi;
  folded: boolean;
}

function buildNote(n: FoldedStaffNote, pos: FretPosition | null, stroke: Stroke, spreadExcess: boolean): Note | null {
  if (!pos) return null;
  return {
    id: newId('n'),
    string: pos.string,
    fret: clamp(pos.fret, 0, MAX_FRET),
    startTick: Math.max(0, n.tick),
    durationTick: Math.max(1, Math.round(n.durationTick)),
    velocity: n.velocity ?? velocityForStroke(stroke),
    techniques: [],
    confidence: confidenceFor(pos, n.folded, spreadExcess),
    finger: null,
    stroke,
  };
}

/** 把位序列节点：旋律单音 或 和弦组（二者按 tick 顺序交替） */
type SeqNode =
  | { kind: 'melody'; note: FoldedStaffNote; positions: FretPosition[] }
  | { kind: 'chord'; notes: FoldedStaffNote[]; candidates: ChordCandidate[] };

/**
 * 把一小节内的五线谱音符映射为六线谱 Note[]（含 confidence / stroke）。
 * 分组规则：同 tick ≥2 音 = 和弦（D/U，方向由 arpeggiate）；单音 = 旋律（null）；decomposed = 分解（P）。
 * 全局 Viterbi：旋律单音与和弦组作为统一节点，最小化整条把位序列的移动代价。
 */
export function assignFingering(notes: StaffNote[]): Note[] {
  if (notes.length === 0) return [];

  // 1) 音域折叠
  const folded: FoldedStaffNote[] = notes.map((n) => {
    const { midi, octaveShifted } = foldIntoRange(n.midi);
    return { ...n, foldedMidi: midi, folded: octaveShifted };
  });

  // 2) 按 tick 分组（保序）
  const groups = new Map<number, FoldedStaffNote[]>();
  const order: number[] = [];
  for (const n of folded) {
    if (!groups.has(n.tick)) {
      groups.set(n.tick, []);
      order.push(n.tick);
    }
    groups.get(n.tick)!.push(n);
  }

  // 3) 构造把位序列节点（旋律单音 + 和弦组）
  const seq: SeqNode[] = [];
  for (const tick of order) {
    const grp = groups.get(tick)!;
    if (grp.length > 1) {
      seq.push({ kind: 'chord', notes: grp, candidates: enumerateChordCandidates(grp.map((g) => g.foldedMidi)) });
    } else {
      seq.push({ kind: 'melody', note: grp[0], positions: allPositions(grp[0].foldedMidi, MAX_FRET) });
    }
  }

  // 4) 全局 Viterbi：首节点锚定到绝对把位代价最小的候选；目标 = 转移代价 + 绝对把位代价
  const nodes: ViterbiCandidate[][] = seq.map((nd) =>
    nd.kind === 'melody' ? melodyCandidates(nd.positions) : chordCandidates(nd.candidates),
  );
  const path = viterbi(nodes);

  // 5) 回填 Note（和弦内部按选定候选的原下标回填，不串位）
  const out: Note[] = [];
  seq.forEach((nd, i) => {
    if (nd.kind === 'melody') {
      const pos = nd.positions.length > 0 ? nd.positions[path[i]] : null;
      const stroke: Stroke = nd.note.decomposed ? 'P' : null;
      const note = buildNote(nd.note, pos, stroke, false);
      if (note) out.push(note);
    } else {
      const chosen = nd.candidates[path[i]];
      const spreadExcess = fretSpread(chosen.positions) > 4;
      const stroke = inferChordStroke(nd.notes[0].arpeggiate ?? null);
      nd.notes.forEach((g, idx) => {
        const note = buildNote(g, chosen.positions[idx], stroke, spreadExcess);
        if (note) out.push(note);
      });
    }
  });

  return out.sort((a, b) => a.startTick - b.startTick || a.string - b.string);
}
