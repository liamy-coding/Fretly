import { describe, expect, it } from 'vitest';
import type { PracticeStats, Tab } from '@/types/tab';
import type { PracticeSession } from '@/types/app';
import type { PracticeEvent } from '@/core/progressive';
import {
  accuracyFactor,
  aggregateSessions,
  averageSpeedPct,
  computeMasteryFactors,
  computeMasteryScore,
  computeStreak,
  coverageFactor,
  freshnessFactor,
  isCountedSession,
  masteryTier,
  recomputeMastery,
  recomputeMasteryHard,
  speedFactor,
} from '@/core/mastery';
import { reducePractice } from '@/core/progressive';
import { createEmptyTab } from '@/core/tabFactory';

const NOW = '2026-09-08T12:00:00.000Z';

function daysAgo(d: number): string {
  return new Date(Date.parse(NOW) - d * 86_400_000).toISOString();
}

function makeStats(patch: Partial<PracticeStats> = {}): PracticeStats {
  return {
    mastery: 0,
    masteryComputedAt: null,
    totalSeconds: 0,
    sessions: 0,
    lastPracticedAt: null,
    bestBpm: 0,
    targetBpm: 72,
    targetReachedAt: null,
    coveredMeasures: [],
    roundsTotal: 0,
    roundsPassed: 0,
    ...patch,
  };
}

function makeTab(measures: number): Tab {
  const tab = createEmptyTab({ bpm: 72 });
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

describe('core/mastery —— 四因子（PRD §6.1）', () => {
  it('S = clamp(bestBpm / targetBpm, 0, 1)', () => {
    expect(speedFactor(58, 72)).toBeCloseTo(58 / 72, 10);
    expect(speedFactor(100, 72)).toBe(1);
    expect(speedFactor(0, 72)).toBe(0);
  });

  it('C = coveredMeasures.length / totalMeasures', () => {
    expect(coverageFactor(16, 16)).toBe(1);
    expect(coverageFactor(4, 16)).toBe(0.25);
    expect(coverageFactor(4, 0)).toBe(0);
  });

  it('A = roundsTotal >= 1 ? roundsPassed / roundsTotal : 0', () => {
    expect(accuracyFactor(10, 7)).toBeCloseTo(0.7, 10);
    expect(accuracyFactor(0, 0)).toBe(0);
  });

  it('新鲜度分段：d=2 → 1.00，d=20 → 0.9152，d=60 → 0.675，d=200 → 0.50', () => {
    expect(freshnessFactor(daysAgo(2), NOW)).toBeCloseTo(1, 6);
    expect(freshnessFactor(daysAgo(7), NOW)).toBeCloseTo(1, 6);
    expect(freshnessFactor(daysAgo(20), NOW)).toBeCloseTo(1 - (0.15 * 13) / 23, 6);
    expect(freshnessFactor(daysAgo(30), NOW)).toBeCloseTo(0.85, 6);
    expect(freshnessFactor(daysAgo(60), NOW)).toBeCloseTo(0.675, 6);
    expect(freshnessFactor(daysAgo(90), NOW)).toBeCloseTo(0.5, 6);
    expect(freshnessFactor(daysAgo(200), NOW)).toBeCloseTo(0.5, 6);
  });

  it('从未练习（lastPracticedAt = null）时新鲜度为 0', () => {
    expect(freshnessFactor(null, NOW)).toBe(0);
  });
});

describe('core/mastery —— PRD §6.1 算例', () => {
  const stats = makeStats({
    bestBpm: 58,
    targetBpm: 72,
    coveredMeasures: Array.from({ length: 16 }, (_, i) => i),
    roundsTotal: 10,
    roundsPassed: 7,
    lastPracticedAt: daysAgo(2),
  });

  it('computed = 85', () => {
    const f = computeMasteryFactors(stats, 16, NOW);
    expect(f.S).toBeCloseTo(58 / 72, 10);
    expect(f.C).toBe(1);
    expect(f.A).toBeCloseTo(0.7, 10);
    expect(f.F).toBe(1);
    expect(computeMasteryScore(f)).toBe(85);
  });

  it('首次重算（masteryComputedAt = null）→ mastery = 85，不走 EMA', () => {
    const next = recomputeMastery(stats, 16, NOW);
    expect(next.mastery).toBe(85);
    expect(next.masteryComputedAt).toBe(NOW);
  });

  it('prevMastery = 70 → round(0.7 × 85 + 0.3 × 70) = 81', () => {
    const next = recomputeMastery({ ...stats, mastery: 70, masteryComputedAt: daysAgo(2) }, 16, NOW);
    expect(next.mastery).toBe(81);
  });

  it('「重算」按钮跳过 EMA，直接取 computed', () => {
    const next = recomputeMasteryHard({ ...stats, mastery: 70, masteryComputedAt: daysAgo(2) }, 16, NOW);
    expect(next.mastery).toBe(85);
  });

  it('显示分档：<40 灰 / 40–69 蓝 / 70–89 绿 / ≥90 金', () => {
    expect(masteryTier(0)).toBe('gray');
    expect(masteryTier(39)).toBe('gray');
    expect(masteryTier(40)).toBe('blue');
    expect(masteryTier(69)).toBe('blue');
    expect(masteryTier(70)).toBe('green');
    expect(masteryTier(89)).toBe('green');
    expect(masteryTier(90)).toBe('gold');
  });
});

describe('core/progressive —— reducePractice', () => {
  it('MeasureCovered 去重并升序', () => {
    let s = makeStats();
    s = reducePractice(s, makeTab(4), { type: 'MeasureCovered', tabId: 'tab_x', at: NOW, measureIndex: 2 });
    s = reducePractice(s, makeTab(4), { type: 'MeasureCovered', tabId: 'tab_x', at: NOW, measureIndex: 0 });
    s = reducePractice(s, makeTab(4), { type: 'MeasureCovered', tabId: 'tab_x', at: NOW, measureIndex: 2 });
    expect(s.coveredMeasures).toEqual([0, 2]);
  });

  it('RoundCompleted 每轮 +1；RoundPassed 才 +1 达标数', () => {
    let s = makeStats();
    s = reducePractice(s, makeTab(4), {
      type: 'RoundCompleted',
      tabId: 'tab_x',
      at: NOW,
      bpm: 72,
      measureRange: [0, 4],
    });
    s = reducePractice(s, makeTab(4), { type: 'RoundPassed', tabId: 'tab_x', at: NOW, bpm: 72 });
    s = reducePractice(s, makeTab(4), {
      type: 'RoundCompleted',
      tabId: 'tab_x',
      at: NOW,
      bpm: 72,
      measureRange: [0, 4],
    });
    expect(s.roundsTotal).toBe(2);
    expect(s.roundsPassed).toBe(1);
  });

  it('bestBpm 只在 TempoRaised 时更新，且取提速**前**的 BPM', () => {
    let s = makeStats({ bestBpm: 0, targetBpm: 72 });
    s = reducePractice(s, makeTab(4), { type: 'RoundPassed', tabId: 'tab_x', at: NOW, bpm: 60 });
    expect(s.bestBpm).toBe(0);
    s = reducePractice(s, makeTab(4), {
      type: 'TempoRaised',
      tabId: 'tab_x',
      at: NOW,
      fromBpm: 60,
      toBpm: 65,
    });
    expect(s.bestBpm).toBe(60);
    // 已记录更高的值时不回退
    s = reducePractice(s, makeTab(4), {
      type: 'TempoRaised',
      tabId: 'tab_x',
      at: NOW,
      fromBpm: 50,
      toBpm: 55,
    });
    expect(s.bestBpm).toBe(60);
  });

  it('到达 targetBpm 且首次达标时写入 targetReachedAt', () => {
    let s = makeStats({ targetBpm: 72, targetReachedAt: null });
    s = reducePractice(s, makeTab(4), {
      type: 'TempoRaised',
      tabId: 'tab_x',
      at: NOW,
      fromBpm: 67,
      toBpm: 72,
    });
    expect(s.targetReachedAt).toBe(NOW);
    const before = s.targetReachedAt;
    s = reducePractice(s, makeTab(4), {
      type: 'TempoRaised',
      tabId: 'tab_x',
      at: '2030-01-01T00:00:00.000Z',
      fromBpm: 72,
      toBpm: 72,
    });
    expect(s.targetReachedAt).toBe(before);
  });

  it('SessionEnded：有效时长 < 300s 不计入 totalSeconds / sessions', () => {
    const short: PracticeEvent = {
      type: 'SessionEnded',
      tabId: 'tab_x',
      at: NOW,
      startedAt: daysAgo(0),
      endedAt: NOW,
      effectiveSeconds: 120,
      startBpm: 60,
      endBpm: 60,
      rounds: 1,
      passedRounds: 0,
      progressiveUsed: false,
      coveredMeasures: [0, 1],
    };
    const after = reducePractice(makeStats(), makeTab(4), short);
    expect(after.totalSeconds).toBe(0);
    expect(after.sessions).toBe(0);
    expect(after.coveredMeasures).toEqual([0, 1]);
    expect(after.masteryComputedAt).toBe(NOW);
  });

  it('SessionEnded：≥300s 计入时长与会话数，并只在这一次重算熟练度', () => {
    const before = makeStats({
      lastPracticedAt: daysAgo(2),
      coveredMeasures: [0, 1, 2, 3],
      roundsTotal: 10,
      roundsPassed: 7,
      bestBpm: 58,
      targetBpm: 72,
    });
    const after = reducePractice(before, makeTab(4), {
      type: 'SessionEnded',
      tabId: 'tab_x',
      at: NOW,
      startedAt: daysAgo(0),
      endedAt: NOW,
      effectiveSeconds: 600,
      startBpm: 60,
      endBpm: 65,
      rounds: 2,
      passedRounds: 1,
      progressiveUsed: true,
      coveredMeasures: [],
    });
    expect(after.totalSeconds).toBe(600);
    expect(after.sessions).toBe(1);
    expect(after.mastery).toBe(85); // 首次重算，不走 EMA
  });
});

describe('core/mastery —— 打卡与档案聚合（PRD §6.3）', () => {
  it('isCountedSession：≥300s 才算有效', () => {
    expect(isCountedSession(300)).toBe(true);
    expect(isCountedSession(299)).toBe(false);
  });

  it('连续打卡：今日有练习从今日数，断一天归零', () => {
    expect(computeStreak(['2026-09-08', '2026-09-07', '2026-09-06'], '2026-09-08')).toBe(3);
    // 今日无练习但昨日有 → 从昨日数
    expect(computeStreak(['2026-09-07', '2026-09-06'], '2026-09-08')).toBe(2);
    // 前天有、昨日无 → 归零
    expect(computeStreak(['2026-09-06'], '2026-09-08')).toBe(0);
    expect(computeStreak([], '2026-09-08')).toBe(0);
  });

  it('aggregateSessions 汇总本周分钟 / 在练曲目 / 连续天数', () => {
    // 用本地正午构造，避免测试机时区把 UTC 时间推到相邻自然日
    const day = (d: number) => new Date(2026, 8, d, 12, 0, 0).toISOString();
    const sessions: PracticeSession[] = [
      { id: 'ses_1', tabId: 'tab_1', startedAt: day(8), endedAt: day(8), effectiveSeconds: 600, counted: true, startBpm: 60, endBpm: 60, rounds: 1, passedRounds: 1, progressiveUsed: false, coveredMeasures: [] },
      { id: 'ses_2', tabId: 'tab_2', startedAt: day(7), endedAt: day(7), effectiveSeconds: 300, counted: true, startBpm: 60, endBpm: 60, rounds: 1, passedRounds: 1, progressiveUsed: false, coveredMeasures: [] },
      { id: 'ses_3', tabId: 'tab_1', startedAt: day(8), endedAt: day(8), effectiveSeconds: 100, counted: false, startBpm: 60, endBpm: 60, rounds: 1, passedRounds: 0, progressiveUsed: false, coveredMeasures: [] },
    ];
    const agg = aggregateSessions(sessions, new Date(2026, 8, 8, 18, 0, 0));
    expect(agg.minutesByDay['2026-09-08']).toBe(10); // 600s，未达标的 100s 不计
    expect(agg.minutesByDay['2026-09-07']).toBe(5); // 300s
    expect(agg.activeTabs).toBe(2);
    expect(agg.streak).toBe(2);
    // 2026-09-08 是周二 → 本周从 09-07（周一）起，两天都算进本周
    expect(agg.weekMinutes).toBe(15);
  });

  it('averageSpeedPct = mean(bestBpm / targetBpm) × 100', () => {
    expect(averageSpeedPct([{ bestBpm: 58, targetBpm: 72 }, { bestBpm: 72, targetBpm: 72 }])).toBe(
      Math.round(((58 / 72 + 1) / 2) * 100),
    );
    expect(averageSpeedPct([])).toBe(0);
  });
});
