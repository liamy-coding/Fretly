/**
 * T-17 领域事件流测试（纯函数层）：reducePractice 事件流 + 熟练度一次重算 +
 * bestBpm 取提速前 BPM + coveredMeasures 跨小节合并 + 渐进状态机 raise。
 *
 * 不碰 AudioContext / IndexedDB / DOM：直接驱动 core/progressive 的纯函数。
 */
import { describe, expect, it } from 'vitest';
import type { PracticeStats, Tab } from '@/types/tab';
import { emptyPractice, createEmptyTab, cloneTab } from '@/core/tabFactory';
import {
  applyRaise,
  createProgressive,
  reducePractice,
  registerFail,
  registerPass,
  shouldRaise,
  type PracticeEvent,
  type ProgressiveConfig,
} from '@/core/progressive';

const AT = '2026-01-15T10:00:00.000Z';
const TAB_ID = 'tab_test' as const;

function makeTab(measuresCount = 8, bpm = 100): Tab {
  const tab = createEmptyTab({ id: TAB_ID, title: '练习曲', bpm });
  const track = tab.tracks[0]!;
  const ticks = 1920;
  const measures = Array.from({ length: measuresCount }, (_, i) => ({
    index: i,
    startTick: i * ticks,
    ticks,
    chords: [],
    notes: [],
    sectionLabel: '',
  }));
  return cloneTab({ ...tab, tracks: [{ ...track, measures }] });
}

function reduce(stats: PracticeStats, tab: Tab, e: PracticeEvent): PracticeStats {
  return reducePractice(stats, tab, e);
}

const base: PracticeStats = emptyPractice(100);

describe('T-17 reducePractice 事件流', () => {
  it('RoundCompleted 累计轮次，RoundPassed 累计达标且不超过总轮次', () => {
    const tab = makeTab();
    let s = reduce(base, tab, { type: 'RoundCompleted', tabId: TAB_ID, at: AT, bpm: 60, measureRange: [0, 1] });
    expect(s.roundsTotal).toBe(1);
    s = reduce(s, tab, { type: 'RoundPassed', tabId: TAB_ID, at: AT, bpm: 60 });
    expect(s.roundsPassed).toBe(1);
    // 连续点"本轮过了"不应使 passed 超过 total
    s = reduce(s, tab, { type: 'RoundPassed', tabId: TAB_ID, at: AT, bpm: 60 });
    expect(s.roundsPassed).toBe(1);
    // 失败轮不加通过数
    s = reduce(s, tab, { type: 'RoundFailed', tabId: TAB_ID, at: AT, bpm: 60 });
    expect(s.roundsTotal).toBe(1);
    expect(s.roundsPassed).toBe(1);
  });

  it('TempoRaised 更新 bestBpm 取“提速前”BPM，目标达到时写 targetReachedAt', () => {
    const tab = makeTab(8, 100);
    const s0 = { ...base, bestBpm: 55, targetBpm: 80 };
    const s = reduce(s0, tab, { type: 'TempoRaised', tabId: TAB_ID, at: AT, fromBpm: 70, toBpm: 75 });
    expect(s.bestBpm).toBe(70); // 不是 toBpm(75)
    expect(s.targetReachedAt).toBeNull();

    const reached = reduce(s, tab, { type: 'TempoRaised', tabId: TAB_ID, at: AT, fromBpm: 75, toBpm: 80 });
    expect(reached.bestBpm).toBe(75);
    expect(reached.targetReachedAt).toBe(AT);
    // 幂等：再次到目标不再覆盖时间
    const again = reduce(reached, tab, { type: 'TempoRaised', tabId: TAB_ID, at: '2026-01-16T00:00:00.000Z', fromBpm: 80, toBpm: 85 });
    expect(again.targetReachedAt).toBe(AT);
  });

  it('MeasureCovered / SessionEnded 跨小节合并去重排序 coveredMeasures', () => {
    const tab = makeTab(8);
    let s = base;
    s = reduce(s, tab, { type: 'MeasureCovered', tabId: TAB_ID, at: AT, measureIndex: 3 });
    s = reduce(s, tab, { type: 'MeasureCovered', tabId: TAB_ID, at: AT, measureIndex: 3 });
    s = reduce(s, tab, { type: 'MeasureCovered', tabId: TAB_ID, at: AT, measureIndex: 0 });
    expect(s.coveredMeasures).toEqual([0, 3]);

    const ended = reduce(s, tab, {
      type: 'SessionEnded',
      tabId: TAB_ID,
      at: AT,
      startedAt: AT,
      endedAt: AT,
      effectiveSeconds: 320,
      startBpm: 50,
      endBpm: 60,
      rounds: 2,
      passedRounds: 1,
      progressiveUsed: true,
      coveredMeasures: [2, 0, 6, 2],
    });
    expect(ended.coveredMeasures).toEqual([0, 2, 3, 6]);
    expect(ended.lastPracticedAt).toBe(AT);
    expect(ended.sessions).toBe(1);
    expect(ended.totalSeconds).toBe(320);
  });

  it('SessionEnded 熟练度只重算一次：masteryComputedAt 置为结束时刻', () => {
    const tab = makeTab(8, 100);
    // 先跑几轮 + 提速，让 S/A 因子非零
    let s = reduce(base, tab, { type: 'SessionStarted', tabId: TAB_ID, at: AT, bpm: 60 });
    s = reduce(s, tab, { type: 'MeasureCovered', tabId: TAB_ID, at: AT, measureIndex: 0 });
    s = reduce(s, tab, { type: 'RoundCompleted', tabId: TAB_ID, at: AT, bpm: 60, measureRange: [0, 1] });
    s = reduce(s, tab, { type: 'RoundPassed', tabId: TAB_ID, at: AT, bpm: 60 });
    s = reduce(s, tab, { type: 'TempoRaised', tabId: TAB_ID, at: AT, fromBpm: 60, toBpm: 65 });

    const ended = reduce(s, tab, {
      type: 'SessionEnded',
      tabId: TAB_ID,
      at: AT,
      startedAt: AT,
      endedAt: AT,
      effectiveSeconds: 320,
      startBpm: 50,
      endBpm: 65,
      rounds: 1,
      passedRounds: 1,
      progressiveUsed: true,
      coveredMeasures: [0],
    });
    // 一次重算：mastery ∈ [0,100] 且计算时间被写
    expect(ended.masteryComputedAt).toBe(AT);
    // S = 60/100=0.6, C = 1/8, A = 1, F = 1 → computed = 62（首次不走 EMA）
    expect(ended.mastery).toBe(62);
  });

  it('短会话（<300s）不计入 sessions/totalSeconds 但仍触发熟练度重算', () => {
    const tab = makeTab(4, 90);
    const s = reduce(base, tab, {
      type: 'SessionEnded',
      tabId: TAB_ID,
      at: AT,
      startedAt: AT,
      endedAt: AT,
      effectiveSeconds: 120,
      startBpm: 45,
      endBpm: 45,
      rounds: 0,
      passedRounds: 0,
      progressiveUsed: false,
      coveredMeasures: [0],
    });
    expect(s.sessions).toBe(0);
    expect(s.totalSeconds).toBe(0);
    expect(s.coveredMeasures).toEqual([0]);
    expect(s.masteryComputedAt).toBe(AT); // 熟练度照常重算
  });
});

describe('T-17 渐进加速状态机', () => {
  const cfg: ProgressiveConfig = { startRatio: 0.6, step: 5, passRounds: 2, targetRatio: 1 };

  it('两轮连续达标 → shouldRaise → applyRaise 提速并清零连续计数', () => {
    const tab = makeTab(8, 100);
    const p0 = { ...createProgressive(cfg, 100), active: true };
    expect(p0.startBpm).toBe(60);
    expect(p0.targetBpm).toBe(100);

    const p1 = registerPass(p0, 60, AT);
    expect(shouldRaise(p1)).toBe(false);
    const p2 = registerPass(p1, 60, AT);
    expect(shouldRaise(p2)).toBe(true);

    const { state, raised, fromBpm, toBpm } = applyRaise(p2, AT);
    expect(raised).toBe(true);
    expect(fromBpm).toBe(60);
    expect(toBpm).toBe(65);
    expect(state.currentBpm).toBe(65);
    expect(state.consecutive).toBe(0);
    expect(state.rounds).toHaveLength(2);

    // 提速前的 60 成为 bestBpm（事件流语义：TempoRaised.fromBpm = fromBpm）
    const ended = reduce(base, tab, {
      type: 'TempoRaised',
      tabId: TAB_ID,
      at: AT,
      fromBpm,
      toBpm,
    });
    expect(ended.bestBpm).toBe(60);
  });

  it('失败清零连续达标；到达目标后不再提速', () => {
    const p0 = { ...createProgressive(cfg, 100), active: true };
    const p1 = registerPass(registerPass(p0, 60, AT), 60, AT);
    const p2 = registerFail(p1, 60, AT);
    expect(p2.consecutive).toBe(0);
    expect(shouldRaise(p2)).toBe(false);

    // 模拟一路达标到 targetBpm
    let p = p0;
    for (let i = 0; i < 20 && !p.targetReachedAt; i += 1) {
      p = registerPass(p, p.currentBpm, AT);
      if (shouldRaise(p)) {
        const r = applyRaise(p, AT);
        p = r.state;
      }
    }
    expect(p.currentBpm).toBe(100);
    expect(p.targetReachedAt).not.toBeNull();
    // 到达目标后再 raise 不再变
    const again = applyRaise(p, AT);
    expect(again.raised).toBe(false);
    expect(again.toBpm).toBe(100);
  });
});
