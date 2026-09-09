/**
 * QA 独立复核：A-B 循环回跳后 store.currentMeasure 对齐（回归用例）。
 *
 * 背景：T-01 把「画布高亮」收敛到 overlay rAF 直读 currentTick（已正确），
 * 但 store 的 currentMeasure（非画布：右栏和弦预告 / 和弦视图高亮 / 标难点按钮）
 * 只在 play/seek/loadTab 时经 syncMeasureState() 回写，loop 回跳（roundEnd）未同步。
 *
 * 复现（fake clock，120BPM，4/4=1920 ticks/小节，loop=[1920,3840)）：
 *   进入第 2 小节（currentTick=1920）时：canvasHighlight=1，storeCurrentMeasure=0（滞留）
 *   越过 loop.end 回跳后：storeCurrentMeasure 仍 =0，而播放头在 measure1
 *
 * 期望修复：controller.handleBoundary 的 'roundEnd' 分支在回跳后同步
 *   currentMeasure = measureIndexOf(loop.start)，并重置 lastEmittedMeasure。
 *   注意 Transport.checkBoundaries 里 roundEnd 是在 anchor 回跳**之前** emit 的，
 *   所以不能用 transport.currentTick 现取（会取到 loop.end 附近），需用 loop.start。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ScheduledNote } from '@/types/app';
import { TransportImpl } from '@/audio/Transport';
import { TICKS_PER_BEAT } from '@/core/constants';
import { measureIndexOf } from '@/core/tick';

function note(tick: number, midi = 64): ScheduledNote {
  return { tick, midi, velocity: 0.85, durationTick: 240, string: 1, fret: 0 };
}

describe('QA 回归：A-B 循环回跳后 store currentMeasure 应对齐 loop.start', () => {
  it('循环回跳后 storeCurrentMeasure === measureIndexOf(loop.start)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
    try {
      const t = new TransportImpl();
      t.load([note(0), note(480), note(960)], {
        bpm: 120,
        timeSignature: [4, 4],
        ticksPerBeat: TICKS_PER_BEAT,
        totalTicks: 7680,
        loop: null,
      });

      let lastEmittedMeasure = -1;
      let storeCurrentMeasure = 0;
      const loop = { start: 1920, end: 3840 };

      // 与 practiceController.syncMeasureState(targetTick?) 语义一致：
      // 传入目标 tick 时按目标算，否则按 currentTick 现取。
      const syncMeasureState = (targetTick?: number) => {
        const mi = measureIndexOf(targetTick ?? t.currentTick, [4, 4], TICKS_PER_BEAT);
        lastEmittedMeasure = mi;
        storeCurrentMeasure = mi;
      };
      t.onBoundary((e) => {
        if (e.kind === 'measure' && (e.measureIndex ?? -1) > lastEmittedMeasure) {
          lastEmittedMeasure = e.measureIndex as number;
          storeCurrentMeasure = e.measureIndex as number;
        }
        // roundEnd 在 anchor 回跳前 emit，必须用回跳目标 loop.start；end 归 0。
        if (e.kind === 'roundEnd') syncMeasureState(loop.start);
        if (e.kind === 'end') syncMeasureState(0);
      });

      t.setLoop(loop);
      await t.play(0);
      syncMeasureState();

      vi.advanceTimersByTime(4000); // 越过 loop.end 至少一次，回到 measure1
      expect(measureIndexOf(t.currentTick, [4, 4], TICKS_PER_BEAT)).toBe(1);
      // 期望：store 镜像对齐回跳目标 measureIndexOf(loop.start)，而非滞留旧值
      expect(storeCurrentMeasure).toBe(measureIndexOf(loop.start, [4, 4], TICKS_PER_BEAT));
      expect(storeCurrentMeasure).toBe(1);
      t.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
