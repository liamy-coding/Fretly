import { describe, expect, it } from 'vitest';
import {
  enumerateBeats,
  loopJumpTarget,
  measureIndexOf,
  measureStartTick,
  measureTicks,
  nextMeasureLine,
  secToTick,
  tickToSec,
  timeSignatureKey,
} from '@/core/tick';
import { TICKS_PER_BEAT } from '@/core/constants';

describe('core/tick —— tick ↔ 秒', () => {
  it('TICKS_PER_BEAT 固定 480', () => {
    expect(TICKS_PER_BEAT).toBe(480);
  });

  it('tickToSec 遵循 tick × 60 / (480 × bpm)', () => {
    expect(tickToSec(480, 120)).toBeCloseTo(0.5, 10); // 一拍 0.5s
    expect(tickToSec(1920, 120)).toBeCloseTo(2, 10); // 4/4 整小节 = 4 拍 = 2s
    expect(tickToSec(480, 60)).toBeCloseTo(1, 10); // 60bpm 一拍 1s
    expect(tickToSec(240, 72)).toBeCloseTo((240 * 60) / (480 * 72), 10);
  });

  it('secToTick 是 tickToSec 的逆运算', () => {
    for (const bpm of [40, 72, 96, 120, 240]) {
      expect(secToTick(tickToSec(1234, bpm), bpm)).toBeCloseTo(1234, 6);
    }
  });

  it('不同 BPM 下同一 tick 的秒长与 BPM 成反比', () => {
    expect(tickToSec(960, 120) * 2).toBeCloseTo(tickToSec(960, 60), 10);
  });
});

describe('core/tick —— 小节', () => {
  it('4/4 一小节 = 1920 ticks，3/4 = 1440 ticks', () => {
    expect(measureTicks([4, 4])).toBe(1920);
    expect(measureTicks([3, 4])).toBe(1440);
  });

  it('measureIndexOf / measureStartTick 往返', () => {
    expect(measureIndexOf(0, [4, 4])).toBe(0);
    expect(measureIndexOf(1919, [4, 4])).toBe(0);
    expect(measureIndexOf(1920, [4, 4])).toBe(1);
    expect(measureStartTick(3, [3, 4])).toBe(4320);
    expect(measureIndexOf(measureStartTick(7, [3, 4]), [3, 4])).toBe(7);
  });

  it('nextMeasureLine 严格返回下一条小节线', () => {
    expect(nextMeasureLine(0, [4, 4])).toBe(1920);
    expect(nextMeasureLine(100, [4, 4])).toBe(1920);
    expect(nextMeasureLine(1920, [4, 4])).toBe(3840);
    expect(nextMeasureLine(0, [3, 4])).toBe(1440);
  });

  it('拍号 key 归一化', () => {
    expect(timeSignatureKey([3, 4])).toBe('3/4');
    expect(timeSignatureKey([4, 4])).toBe('4/4');
  });
});

describe('core/tick —— A-B 循环跳转', () => {
  it('越过 loop.end 回到 loop.start 并标记 roundEnd', () => {
    expect(loopJumpTarget(3840, { start: 1920, end: 3840 }, 7680)).toEqual({
      tick: 1920,
      roundEnd: true,
    });
  });

  it('区间内不跳转', () => {
    expect(loopJumpTarget(2000, { start: 1920, end: 3840 }, 7680)).toBeNull();
  });

  it('无循环越过曲尾回到 0', () => {
    expect(loopJumpTarget(7680, null, 7680)).toEqual({ tick: 0, roundEnd: false });
  });
});

describe('core/tick —— 拍点枚举', () => {
  it('4/4 subdivision=1 → 每 480 ticks 一拍，小节首拍 accent', () => {
    const beats = enumerateBeats({ fromTick: 0, toTick: 1920, timeSignature: [4, 4], subdivision: 1 });
    expect(beats.map((b) => b.tick)).toEqual([0, 480, 960, 1440]);
    expect(beats.filter((b) => b.accent)).toHaveLength(1);
    expect(beats[0].accent).toBe(true);
  });

  it('subdivision=4 → 每 120 ticks 一个细分点', () => {
    const beats = enumerateBeats({ fromTick: 0, toTick: 480, timeSignature: [4, 4], subdivision: 4 });
    expect(beats.map((b) => b.tick)).toEqual([0, 120, 240, 360]);
  });

  it('预备拍（负 tick）也能枚举且重音按小节首拍判定', () => {
    const beats = enumerateBeats({
      fromTick: -1920,
      toTick: 0,
      timeSignature: [4, 4],
      subdivision: 1,
    });
    expect(beats.map((b) => b.tick)).toEqual([-1920, -1440, -960, -480]);
    expect(beats[0].accent).toBe(true);
  });
});
