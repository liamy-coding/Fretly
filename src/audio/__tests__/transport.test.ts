import { describe, expect, it, vi } from 'vitest';
import type { ScheduledNote, TransportLoadOptions } from '@/types/app';
import { TransportImpl, anchorTickToTime, anchorTimeToTick } from '@/audio/Transport';
import { TICKS_PER_BEAT } from '@/core/constants';
import { measureIndexOf } from '@/core/tick';

describe('audio/Transport —— 锚点映射（架构 §6.1）', () => {
  it('tickToCtx = a.ctxTime + (tick − a.tick) × 60 / (bpm × 480)', () => {
    const a = { ctxTime: 10, tick: 0, bpm: 120 };
    expect(anchorTickToTime(a, 480)).toBeCloseTo(10.5, 10);
    expect(anchorTickToTime(a, 1920)).toBeCloseTo(12, 10);
  });

  it('ctxToTick 是 tickToCtx 的逆运算', () => {
    const a = { ctxTime: 3.25, tick: 960, bpm: 96 };
    for (const tick of [0, 480, 1920, 7680]) {
      expect(anchorTimeToTick(a, anchorTickToTime(a, tick))).toBeCloseTo(tick, 6);
    }
  });

  it('变速只改斜率：同一 tick 距离在更高 BPM 下耗时更短（保音高，因为合成参数不变）', () => {
    const slow = { ctxTime: 0, tick: 0, bpm: 60 };
    const fast = { ctxTime: 0, tick: 0, bpm: 120 };
    expect(anchorTickToTime(fast, 960)).toBeCloseTo(anchorTickToTime(slow, 960) / 2, 10);
  });
});

function note(tick: number, midi = 64): ScheduledNote {
  return { tick, midi, velocity: 0.85, durationTick: 240, string: 1, fret: 0 };
}

describe('audio/Transport —— 装载 / 定位 / 订阅', () => {
  it('load 后 currentTick 从 0 起，seek 可跳转', () => {
    const t = new TransportImpl();
    t.load([note(0), note(480), note(960)], {
      bpm: 120,
      timeSignature: [4, 4],
      ticksPerBeat: TICKS_PER_BEAT,
      totalTicks: 1920,
      loop: null,
    });
    expect(t.currentTick).toBe(0);
    expect(t.currentBpm).toBe(120);
    t.seek(960);
    expect(t.currentTick).toBe(960);
    t.dispose();
  });

  it('setTempo(immediate) 立即改写锚点；默认模式只排队，跨小节线才生效', () => {
    const t = new TransportImpl();
    t.load([note(0)], {
      bpm: 120,
      timeSignature: [4, 4],
      ticksPerBeat: TICKS_PER_BEAT,
      totalTicks: 1920,
      loop: null,
    });
    t.setTempo(150); // 非 immediate：等下一个小节线
    expect(t.currentBpm).toBe(120);
    t.setTempo(150, { immediate: true });
    expect(t.currentBpm).toBe(150);
    t.dispose();
  });

  it('setLoop 会把播放头拉回区间起点', () => {
    const t = new TransportImpl();
    t.load([note(0)], {
      bpm: 120,
      timeSignature: [4, 4],
      ticksPerBeat: TICKS_PER_BEAT,
      totalTicks: 7680,
      loop: null,
    });
    t.seek(5000);
    t.setLoop({ start: 1920, end: 3840 });
    expect(t.currentTick).toBe(1920);
    t.dispose();
  });

  it('onSchedule / onBoundary 返回的取消函数可移除订阅', () => {
    const t = new TransportImpl();
    let calls = 0;
    const off = t.onSchedule(() => {
      calls += 1;
    });
    off();
    const off2 = t.onBoundary(() => {
      calls += 1;
    });
    off2();
    t.dispose();
    expect(calls).toBe(0);
  });

  it('3/4 拍号下小节线按 1440 ticks 推进', () => {
    const t = new TransportImpl();
    t.load([note(0)], {
      bpm: 96,
      timeSignature: [3, 4],
      ticksPerBeat: TICKS_PER_BEAT,
      totalTicks: 4320,
      loop: null,
    });
    const events: number[] = [];
    t.onBoundary((e) => {
      if (e.kind === 'measure') events.push(e.tick);
    });
    t.seek(1440);
    expect(events).toEqual([]);
    t.dispose();
  });
});

describe('audio/Transport —— currentMeasure 派生（T-01：播放头与高亮同源）', () => {
  const opts: TransportLoadOptions = {
    bpm: 120,
    timeSignature: [4, 4],
    ticksPerBeat: TICKS_PER_BEAT,
    totalTicks: 3840,
    loop: null,
  };

  it('load 后 currentMeasure 从 0 起（换曲首屏对齐）', () => {
    const t = new TransportImpl();
    t.load([note(0)], opts);
    expect(t.currentTick).toBe(0);
    expect(t.currentMeasure).toBe(0);
    t.dispose();
  });

  it('向后 seek 后 currentMeasure 立即对齐（4/4 每小节 1920 ticks）', () => {
    const t = new TransportImpl();
    t.load([note(0), note(480), note(960)], opts);
    t.seek(1920);
    expect(t.currentTick).toBe(1920);
    expect(t.currentMeasure).toBe(1);
    t.seek(2000);
    expect(t.currentMeasure).toBe(1); // floor(2000/1920)
    t.seek(3840);
    expect(t.currentMeasure).toBe(2);
    t.dispose();
  });

  it('stop() 后锚点归 0 → currentMeasure 归 0（重播前对齐）', () => {
    const t = new TransportImpl();
    t.load([note(0)], opts);
    t.seek(3000);
    expect(t.currentMeasure).toBe(1);
    t.stop();
    expect(t.currentTick).toBe(0);
    expect(t.currentMeasure).toBe(0);
    t.dispose();
  });

  it('换曲 load 后 currentMeasure 重置为 0', () => {
    const t = new TransportImpl();
    t.load([note(0)], opts);
    t.seek(1920);
    expect(t.currentMeasure).toBe(1);
    // 换曲：不同小节总数
    t.load([note(0), note(960)], { ...opts, totalTicks: 7680 });
    expect(t.currentMeasure).toBe(0);
    t.dispose();
  });

  it('交叉断言：currentMeasure === measureIndexOf(currentTick)（与 rAF 播放头同源）', () => {
    const t = new TransportImpl();
    t.load([note(0)], opts);
    for (const tick of [0, 480, 1919, 1920, 2000, 3839, 3840]) {
      t.seek(tick);
      expect(t.currentMeasure).toBe(measureIndexOf(t.currentTick, [4, 4], TICKS_PER_BEAT));
    }
    t.dispose();
  });

  it('播放中 currentMeasure 随 fake clock 推进（跨入下一小节不滞留）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
    try {
      const t = new TransportImpl();
      t.load([note(0), note(480)], opts);
      await t.play(0);
      expect(t.currentMeasure).toBe(0);

      // 120 BPM → 1 秒 = 960 ticks，仍在小节 0（4/4 = 1920 ticks）
      vi.advanceTimersByTime(1000);
      expect(t.currentTick).toBeGreaterThanOrEqual(900);
      expect(t.currentTick).toBeLessThan(1920);
      expect(t.currentMeasure).toBe(0);

      // 再 1 秒 → 1920 ticks，跨入第 1 小节
      vi.advanceTimersByTime(1000);
      expect(t.currentMeasure).toBe(1);
      t.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
