/**
 * QA 边界回归 —— 熟练度/渐进状态机（独立于工程师用例，双保险）。
 *
 * 覆盖风险（team-lead 点名 + PRD §6）：
 *  1) bestBpm 只在连续达标触发提速(TempoRaised)时更新，取**提速前** BPM
 *  2) roundsTotal 每轮 +1；roundsPassed 仅点「本轮过了」+1，且不超过 roundsTotal
 *  3) 连续达标 N 轮触发提速；未达标（registerFail）consecutive 归零
 *  4) currentBpm 已达 targetBpm → shouldRaise false / applyRaise 不再提速
 *  5) 熟练度只在 SessionEnded 重算一次；进行中事件不变更 mastery
 *  6) 新鲜度下限 0.5（长期不练最多只掉 5 分）
 *  7) PRD §6.1 算例：computed = 85；prev=70 → 81
 */
import { describe, expect, it } from 'vitest';
import type { PracticeStats, Tab } from '@/types/tab';
import { createEmptyTab } from '@/core/tabFactory';
import {
  accuracyFactor,
  computeMasteryFactors,
  computeMasteryScore,
  freshnessFactor,
  recomputeMastery,
  recomputeMasteryHard,
} from '@/core/mastery';
import {
  applyRaise,
  computeStartBpm,
  createProgressive,
  reducePractice,
  registerFail,
  registerPass,
  shouldRaise,
  type PracticeEvent,
  type ProgressiveConfig,
} from '@/core/progressive';

const NOW = '2026-09-08T12:00:00.000Z';

function daysAgo(d: number): string {
  return new Date(Date.parse(NOW) - d * 86_400_000).toISOString();
}

function makeTab(measures: number, bpm = 100): Tab {
  const tab = createEmptyTab({ bpm });
  tab.tracks[0].measures = Array.from({ length: measures }, (_, i) => ({
    index: i,
    startTick: i * 1920,
    ticks: 1920,
    chords: [],
    notes: [],
    sectionLabel: '',
  }));
  return tab;
}

function makeStats(patch: Partial<PracticeStats> = {}): PracticeStats {
  return {
    mastery: 0,
    masteryComputedAt: null,
    totalSeconds: 0,
    sessions: 0,
    lastPracticedAt: null,
    bestBpm: 0,
    targetBpm: 100,
    targetReachedAt: null,
    coveredMeasures: [],
    roundsTotal: 0,
    roundsPassed: 0,
    ...patch,
  };
}

const TAB_ID = 'tab_qa' as const;
const ended = (stats: PracticeStats, tab: Tab, effectiveSeconds: number, extra: Partial<Extract<PracticeEvent, { type: 'SessionEnded' }>> = {}): PracticeStats =>
  reducePractice(stats, tab, {
    type: 'SessionEnded',
    tabId: TAB_ID,
    at: NOW,
    startedAt: daysAgo(0),
    endedAt: NOW,
    effectiveSeconds,
    startBpm: 60,
    endBpm: 60,
    rounds: 0,
    passedRounds: 0,
    progressiveUsed: false,
    coveredMeasures: [],
    ...extra,
  });

describe('QA §6.1 —— 熟练度边界', () => {
  it('最佳实践：computed = round(100 × (0.40S + 0.25C + 0.25A + 0.10F)) = 85（PRD 算例）', () => {
    const stats = makeStats({
      bestBpm: 58,
      targetBpm: 72,
      coveredMeasures: Array.from({ length: 16 }, (_, i) => i),
      roundsTotal: 10,
      roundsPassed: 7,
      lastPracticedAt: daysAgo(2),
    });
    const f = computeMasteryFactors(stats, 16, NOW);
    expect(computeMasteryScore(f)).toBe(85);
  });

  it('首次重算 mastery = computed（85），不走 EMA', () => {
    const stats = makeStats({
      bestBpm: 58,
      targetBpm: 72,
      coveredMeasures: Array.from({ length: 16 }, (_, i) => i),
      roundsTotal: 10,
      roundsPassed: 7,
      lastPracticedAt: daysAgo(2),
    });
    const next = recomputeMastery(stats, 16, NOW);
    expect(next.mastery).toBe(85);
  });

  it('prev=70 → round(0.7×85 + 0.3×70) = 81（EMA 平滑 α=0.7）', () => {
    const stats = makeStats({
      mastery: 70,
      masteryComputedAt: daysAgo(10),
      bestBpm: 58,
      targetBpm: 72,
      coveredMeasures: Array.from({ length: 16 }, (_, i) => i),
      roundsTotal: 10,
      roundsPassed: 7,
      lastPracticedAt: daysAgo(2),
    });
    const next = recomputeMastery(stats, 16, NOW);
    expect(next.mastery).toBe(81);
  });

  it('「重算」入口 recomputeMasteryHard 跳过 EMA，直接 computed', () => {
    const stats = makeStats({
      mastery: 70,
      masteryComputedAt: daysAgo(10),
      bestBpm: 58,
      targetBpm: 72,
      coveredMeasures: Array.from({ length: 16 }, (_, i) => i),
      roundsTotal: 10,
      roundsPassed: 7,
      lastPracticedAt: daysAgo(2),
    });
    expect(recomputeMasteryHard(stats, 16, NOW).mastery).toBe(85);
  });

  it('熟练度只发生在 SessionEnded：进行中的事件（MeasureCovered/RoundPassed/TempoRaised）不重算', () => {
    const tab = makeTab(8);
    let s = makeStats({ mastery: 0, masteryComputedAt: null });
    s = reducePractice(s, tab, { type: 'SessionStarted', tabId: TAB_ID, at: NOW, bpm: 60 });
    s = reducePractice(s, tab, { type: 'MeasureCovered', tabId: TAB_ID, at: NOW, measureIndex: 0 });
    s = reducePractice(s, tab, { type: 'RoundCompleted', tabId: TAB_ID, at: NOW, bpm: 60, measureRange: [0, 1] });
    s = reducePractice(s, tab, { type: 'RoundPassed', tabId: TAB_ID, at: NOW, bpm: 60 });
    s = reducePractice(s, tab, { type: 'TempoRaised', tabId: TAB_ID, at: NOW, fromBpm: 60, toBpm: 65 });
    // 上述事件只累积统计，不写 mastery / masteryComputedAt
    expect(s.mastery).toBe(0);
    expect(s.masteryComputedAt).toBeNull();
    // 只有 SessionEnded 一次重算
    const fin = ended(s, tab, 320, { rounds: 1, passedRounds: 1, coveredMeasures: [0] });
    expect(fin.masteryComputedAt).toBe(NOW);
  });

  it('SessionEnded 重算后二次 SessionEnded 会再次 EMA（每次会话结束时都重算一次）', () => {
    const tab = makeTab(8);
    const s1 = ended(makeStats({ mastery: 0, lastPracticedAt: null }), tab, 320);
    expect(s1.masteryComputedAt).toBe(NOW);
    // 第二会话：走 EMA，不会直接把 computed 当显示值
    const s2 = ended(s1, tab, 320);
    expect(s2.masteryComputedAt).toBe(NOW);
  });

  it('新鲜度：null → 0；d=7→1.00；d=90→0.50；d=100000→0.50（下限保底）', () => {
    expect(freshnessFactor(null, NOW)).toBe(0);
    expect(freshnessFactor(daysAgo(7), NOW)).toBeCloseTo(1, 10);
    expect(freshnessFactor(daysAgo(90), NOW)).toBeCloseTo(0.5, 10);
    expect(freshnessFactor(daysAgo(365 * 10), NOW)).toBe(0.5);
  });

  it('长期不练对 mastery 最多只掉 5 分（F 下限 0.5 × 权重 0.10）', () => {
    const s = (last: string | null, bestBpm = 72): PracticeStats =>
      makeStats({
        bestBpm,
        targetBpm: 72,
        coveredMeasures: Array.from({ length: 8 }, (_, i) => i),
        roundsTotal: 8,
        roundsPassed: 8,
        lastPracticedAt: last,
      });
    const fresh = recomputeMastery(s(daysAgo(2)), 8, NOW);
    const stale = recomputeMastery(s(daysAgo(400)), 8, NOW);
    // 速度/覆盖/达标率都满分时，新鲜度从 1.0→0.5 只影响 10%×0.5=5 分
    expect(fresh.mastery - stale.mastery).toBeLessThanOrEqual(5);
  });

  it('A = roundsTotal >= 1 ? roundsPassed / roundsTotal : 0', () => {
    expect(accuracyFactor(0, 0)).toBe(0);
    expect(accuracyFactor(10, 7)).toBeCloseTo(0.7, 10);
  });
});

describe('QA §6.2 —— 渐进加速边界', () => {
  const cfg: ProgressiveConfig = { startRatio: 0.6, step: 5, passRounds: 2, targetRatio: 1 };

  it('createProgressive：base 100 → startBpm 60 / targetBpm 100 / currentBpm 60', () => {
    const p = createProgressive(cfg, 100);
    expect(p.startBpm).toBe(60);
    expect(p.targetBpm).toBe(100);
    expect(p.currentBpm).toBe(60);
    expect(p.consecutive).toBe(0);
    expect(p.rounds).toEqual([]);
  });

  it('连续达标 N 轮：consecutive 达标后才应提速；未达标 registerFail 归零', () => {
    const p0 = { ...createProgressive(cfg, 100), active: true };
    const p1 = registerPass(p0, 60, NOW);
    expect(p1.consecutive).toBe(1);
    expect(shouldRaise(p1)).toBe(false); // 1/2
    const p2 = registerPass(p1, 60, NOW);
    expect(p2.consecutive).toBe(2);
    expect(shouldRaise(p2)).toBe(true); // 2/2 → 提速
    const fail = registerFail(p2, 60, NOW);
    expect(fail.consecutive).toBe(0);
    expect(shouldRaise(fail)).toBe(false);
  });

  it('applyRaise 提速：fromBpm=60 → toBpm=65，consecutive 清零；bestBpm 记 fromBpm（提速前）', () => {
    const p0 = { ...createProgressive(cfg, 100), active: true };
    const p2 = registerPass(registerPass(p0, 60, NOW), 60, NOW);
    const r = applyRaise(p2, NOW);
    expect(r.raised).toBe(true);
    expect(r.fromBpm).toBe(60);
    expect(r.toBpm).toBe(65);
    expect(r.state.currentBpm).toBe(65);
    expect(r.state.consecutive).toBe(0);

    const stats = reducePractice(makeStats({ bestBpm: 0 }), makeTab(8), {
      type: 'TempoRaised',
      tabId: TAB_ID,
      at: NOW,
      fromBpm: r.fromBpm,
      toBpm: r.toBpm,
    });
    expect(stats.bestBpm).toBe(60); // 提速前的 BPM，不是 65
  });

  it('到达 targetBpm 后不再提速（shouldRaise false；applyRaise.raised false）', () => {
    const p0 = { ...createProgressive(cfg, 100), active: true };
    // 手动推到 target
    let p = p0;
    let guard = 0;
    while (p.currentBpm < p.targetBpm && guard++ < 50) {
      p = registerPass(p, p.currentBpm, NOW);
      if (shouldRaise(p)) p = applyRaise(p, NOW).state;
    }
    expect(p.currentBpm).toBe(100);
    const again = applyRaise(p, NOW);
    expect(again.raised).toBe(false);
    expect(again.toBpm).toBe(100);
    expect(shouldRaise(p)).toBe(false);
  });

  it('targetBpm 超小（< 40）时 computeStartBpm 直接等于 targetBpm', () => {
    expect(computeStartBpm(30, 0.6)).toBe(30);
    expect(computeStartBpm(38, 1)).toBe(38);
  });

  it('round(targetBpm × startRatio) < 40 时 startBpm = 40', () => {
    expect(computeStartBpm(50, 0.5)).toBe(40);
  });

  it('roundsTotal 每轮 +1（无论达标与否）；roundsPassed 仅点击通过 +1 且不超 total', () => {
    const tab = makeTab(8);
    let s = makeStats();
    // 第 1 轮完成但没过
    s = reducePractice(s, tab, { type: 'RoundCompleted', tabId: TAB_ID, at: NOW, bpm: 60, measureRange: [0, 1] });
    expect(s.roundsTotal).toBe(1);
    expect(s.roundsPassed).toBe(0);
    // 第 2 轮完成且过
    s = reducePractice(s, tab, { type: 'RoundCompleted', tabId: TAB_ID, at: NOW, bpm: 60, measureRange: [0, 1] });
    s = reducePractice(s, tab, { type: 'RoundPassed', tabId: TAB_ID, at: NOW, bpm: 60 });
    expect(s.roundsTotal).toBe(2);
    expect(s.roundsPassed).toBe(1);
    // 连续点击通过不超 total（幂等保护）
    s = reducePractice(s, tab, { type: 'RoundPassed', tabId: TAB_ID, at: NOW, bpm: 60 });
    s = reducePractice(s, tab, { type: 'RoundPassed', tabId: TAB_ID, at: NOW, bpm: 60 });
    expect(s.roundsPassed).toBe(2);
  });
});
