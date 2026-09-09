/**
 * QA 边界回归 —— tick 数学 / A-B 循环跳转 / measure 跨节边界（独立于工程师用例）。
 *
 * 覆盖风险：
 *  1) 3/4 一小节 = 1440 ticks（measureTicks / measureIndexOf / nextMeasureLine）
 *  2) tick → 秒 换算与 BPM 线性
 *  3) loopJumpTarget：越过 loop.end → 回 loop.start 且标记 roundEnd；越曲尾 → 0
 *  4) nextMeasureLine：严格大于当前 tick 的下一条小节线（渐进提速在下一小节生效）
 */
import { describe, expect, it } from 'vitest';
import {
  loopJumpTarget,
  measureIndexOf,
  measureStartTick,
  measureTicks,
  nextMeasureLine,
  tickToSec,
  totalTicksOf,
  secToTick,
} from '@/core/tick';

describe('QA tick —— 数学', () => {
  it('tick→sec：sec = tick × 60 / (480 × bpm)', () => {
    expect(tickToSec(480, 120)).toBeCloseTo(0.5, 10);
    expect(tickToSec(1920, 60)).toBeCloseTo(4, 10);
    expect(tickToSec(0, 120)).toBe(0);
  });

  it('sec→tick 是 tick→sec 的逆', () => {
    expect(secToTick(0.5, 120)).toBeCloseTo(480, 10);
  });

  it('bpm <= 0 → 返回 0（防御）', () => {
    expect(tickToSec(480, 0)).toBe(0);
    expect(tickToSec(480, -5)).toBe(0);
  });
});

describe('QA measure —— 拍号边界', () => {
  it('4/4 = 1920 ticks，3/4 = 1440 ticks', () => {
    expect(measureTicks([4, 4])).toBe(1920);
    expect(measureTicks([3, 4])).toBe(1440);
  });

  it('measureIndexOf 在 [start, start+per) 内归属正确小节', () => {
    // 3/4: per=1440 → tick 1439 → measure0; tick 1440 → measure1
    expect(measureIndexOf(1439, [3, 4])).toBe(0);
    expect(measureIndexOf(1440, [3, 4])).toBe(1);
    expect(measureIndexOf(2879, [3, 4])).toBe(1);
    expect(measureIndexOf(2880, [3, 4])).toBe(2);
  });

  it('measureStartTick = index × per', () => {
    expect(measureStartTick(0, [3, 4])).toBe(0);
    expect(measureStartTick(2, [3, 4])).toBe(2880);
  });

  it('nextMeasureLine 严格大于当前 tick：4/4 tick 1919 → 1920；tick 1920 → 3840', () => {
    expect(nextMeasureLine(0, [4, 4])).toBe(1920);
    expect(nextMeasureLine(1919, [4, 4])).toBe(1920);
    expect(nextMeasureLine(1920, [4, 4])).toBe(3840);
    expect(nextMeasureLine(1921, [4, 4])).toBe(3840);
    // 3/4 每 1440
    expect(nextMeasureLine(1440, [3, 4])).toBe(2880);
  });
});

describe('QA A-B 循环 —— loopJumpTarget', () => {
  it('有循环且越过 loop.end → 回 loop.start，roundEnd=true', () => {
    const r = loopJumpTarget(1920, { start: 0, end: 1920 }, 7680);
    expect(r).toEqual({ tick: 0, roundEnd: true });
  });

  it('无循环且越曲尾 → 回 0，roundEnd=false', () => {
    const r = loopJumpTarget(7681, null, 7680);
    expect(r).toEqual({ tick: 0, roundEnd: false });
  });

  it('未越界 → null', () => {
    expect(loopJumpTarget(1000, { start: 0, end: 1920 }, 7680)).toBeNull();
    expect(loopJumpTarget(1919, { start: 0, end: 1920 }, 7680)).toBeNull();
  });
});

describe('QA —— totalTicksOf', () => {
  it('不小于 0', () => {
    expect(totalTicksOf({ totalTicks: 7680 })).toBe(7680);
    expect(totalTicksOf({ totalTicks: -10 })).toBe(0);
  });
});
