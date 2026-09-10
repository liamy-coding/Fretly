/**
 * 自动跟随滚动纯函数单测（架构 §6）：安全带 / 缓动 / **收敛性** / 边界 / 目标 x。
 * 全部 node 环境、无 DOM 依赖。
 */
import { describe, expect, it } from 'vitest';
import {
  DT_CLAMP_MAX,
  FRAME_MS,
  anchorRatioForWidth,
  currentFollowMeasureWidth,
  currentFollowTargetX,
  safeMeasureWidth,
  shouldFallbackToWrap,
  stepFollow,
  type FollowInput,
} from '@/ui/tab/follow';
import { layoutTab } from '@/ui/tab/tabRender';
import { MEASURE_W, ROW_H } from '@/ui/tab/tabRender';
import { FOLLOW_EASE, FOLLOW_EASE_SLOW, FOLLOW_MIN_STEP, SLOW_FOLLOW_RATIO } from '@/core/constants';
import type { TimeSignature } from '@/types/tab';

const TS: TimeSignature = [4, 4];
const PER_MEASURE = 1920;

/** 构造一个「小节左边界 + 安全带」典型场景：容器 900，锚点 1/3=300，安全带 450 */
function base(over: Partial<FollowInput> = {}): FollowInput {
  return {
    containerW: 900,
    contentW: 25000,
    anchorRatio: 1 / 3,
    targetX: 3000,
    scrollLeft: 0,
    dt: FRAME_MS,
    ratio: 1,
    ...over,
  };
}

describe('follow —— 安全带（deadband）', () => {
  it('|delta| ≤ 半屏：不滚动且 scrollLeft 原样返回', () => {
    // delta = 3000 - 300 - 0 = 2700 > 450 → 越界
    const far = stepFollow(base());
    expect(far.shouldScroll).toBe(true);
    expect(far.deadband).toBe(450);

    // 把 scrollLeft 挪到带内：delta = 3000-300-2400 = 300 ≤ 450
    const near = stepFollow(base({ scrollLeft: 2400 }));
    expect(near.shouldScroll).toBe(false);
    expect(near.nextScrollLeft).toBe(2400);
  });

  it('安全带边界：恰好等于半屏不滚，超过 1px 才滚', () => {
    // targetX - anchor - scrollLeft = ±450
    const onEdge = stepFollow(base({ scrollLeft: 2700 - 450 }));
    expect(onEdge.shouldScroll).toBe(false);
    const justOut = stepFollow(base({ scrollLeft: 2700 - 451 }));
    expect(justOut.shouldScroll).toBe(true);
  });

  it('deadband = containerW * 0.5（随容器缩放）', () => {
    expect(stepFollow(base({ containerW: 400 })).deadband).toBe(200);
    expect(stepFollow(base({ containerW: 1600 })).deadband).toBe(800);
  });
});

describe('follow —— 缓动系数（≤60% 减半）', () => {
  it('ratio=0.5（≤0.6）单帧位移严格小于 ratio=1', () => {
    const fast = stepFollow(base({ ratio: 1 }));
    const slow = stepFollow(base({ ratio: 0.5 }));
    expect(fast.shouldScroll).toBe(true);
    expect(slow.shouldScroll).toBe(true);
    const dFast = Math.abs(fast.nextScrollLeft - 0);
    const dSlow = Math.abs(slow.nextScrollLeft - 0);
    expect(dSlow).toBeLessThan(dFast);
  });

  it('慢速系数正好是正常系数的一半（数值不变式）', () => {
    expect(SLOW_FOLLOW_RATIO).toBe(0.6);
    expect(FOLLOW_EASE_SLOW).toBeCloseTo(FOLLOW_EASE / 2, 10);
    // delta*k 远大于最小步长时，位移比 = 系数比 = 2
    const fast = stepFollow(base({ ratio: 1 }));
    const slow = stepFollow(base({ ratio: 0.5 }));
    expect(Math.abs(fast.nextScrollLeft) / Math.abs(slow.nextScrollLeft)).toBeCloseTo(2, 5);
  });

  it('ratio 恰好 0.6 走慢档；0.61 走正常档', () => {
    const at = stepFollow(base({ ratio: 0.6 }));
    const above = stepFollow(base({ ratio: 0.61 }));
    expect(Math.abs(above.nextScrollLeft)).toBeGreaterThan(Math.abs(at.nextScrollLeft));
  });
});

describe('follow —— 收敛性（防抖动核心）', () => {
  it('连续迭代 200 帧：|delta| 单调不增，且最终 shouldScroll 恒为 false', () => {
    const containerW = 900;
    const anchorRatio = 1 / 3;
    const targetX = 3000;
    let scrollLeft = 0;
    let prevAbsDelta = Infinity;
    let firstStoppedAt = -1;
    let monotonic = true;

    for (let frame = 0; frame < 200; frame += 1) {
      const out = stepFollow({ containerW, contentW: 25000, anchorRatio, targetX, scrollLeft, dt: FRAME_MS, ratio: 1 });
      const absDelta = Math.abs(targetX - anchorRatio * containerW - out.nextScrollLeft);
      if (absDelta > prevAbsDelta + 1e-9) monotonic = false;
      prevAbsDelta = absDelta;
      scrollLeft = out.nextScrollLeft;
      if (!out.shouldScroll && firstStoppedAt < 0) firstStoppedAt = frame;
    }
    expect(monotonic, '|delta| 必须单调不增（否则会来回微动）').toBe(true);
    expect(firstStoppedAt, '必须真的停下来，不能永不收敛').toBeGreaterThanOrEqual(0);

    // 停手后继续迭代，恒为 false（无抖动）
    let stopped = scrollLeft;
    for (let i = 0; i < 50; i += 1) {
      const out = stepFollow({ containerW, contentW: 25000, anchorRatio, targetX, scrollLeft: stopped, dt: FRAME_MS, ratio: 1 });
      expect(out.shouldScroll).toBe(false);
      expect(out.nextScrollLeft).toBe(stopped);
      stopped = out.nextScrollLeft;
    }
  });

  it('最小步长支配：差值 < 1px 时一步到位并停手', () => {
    // 构造 delta 恰好越界一点点：deadband=450，令 delta = 450.5
    const containerW = 900;
    const scrollLeft = 3000 - 300 - 450.5;
    const first = stepFollow({ containerW, contentW: 25000, anchorRatio: 1 / 3, targetX: 3000, scrollLeft, dt: 0.01, ratio: 1 });
    expect(first.shouldScroll).toBe(true);
    expect(Math.abs(first.nextScrollLeft - scrollLeft)).toBeCloseTo(FOLLOW_MIN_STEP, 10);
    // 一步之后落回安全带
    const second = stepFollow({
      containerW,
      contentW: 25000,
      anchorRatio: 1 / 3,
      targetX: 3000,
      scrollLeft: first.nextScrollLeft,
      dt: FRAME_MS,
      ratio: 1,
    });
    expect(second.shouldScroll).toBe(false);
  });

  it('dt 上限 clamp：切标签页回来（dt=1e4）单帧位移不超过 3 倍正常帧', () => {
    const normal = stepFollow(base({ dt: FRAME_MS }));
    const huge = stepFollow(base({ dt: 10_000 }));
    const dNormal = Math.abs(normal.nextScrollLeft);
    const dHuge = Math.abs(huge.nextScrollLeft);
    expect(dHuge).toBeLessThanOrEqual(dNormal * DT_CLAMP_MAX + 1e-9);
  });

  it('dt=0：仍至少推进 FOLLOW_MIN_STEP（不会卡死）', () => {
    const out = stepFollow(base({ dt: 0 }));
    expect(out.shouldScroll).toBe(true);
    expect(Math.abs(out.nextScrollLeft)).toBeCloseTo(FOLLOW_MIN_STEP, 10);
  });
});

describe('follow —— 边界', () => {
  it('contentW < containerW（短曲）：不滚动', () => {
    const out = stepFollow({ containerW: 1200, contentW: 800, anchorRatio: 1 / 3, targetX: 700, scrollLeft: 0, dt: FRAME_MS, ratio: 1 });
    expect(out.shouldScroll).toBe(false);
    expect(out.nextScrollLeft).toBe(0);
  });

  it('scrollLeft 永不被 clamp 到负数，也不超 maxScroll', () => {
    // 目标在左侧，极其靠左 → 仍以 0 为下界
    const left = stepFollow({ containerW: 900, contentW: 25000, anchorRatio: 1 / 3, targetX: 0, scrollLeft: 5000, dt: FRAME_MS, ratio: 1 });
    expect(left.nextScrollLeft).toBeGreaterThanOrEqual(0);

    // 极端输入
    const neg = stepFollow({ containerW: 900, contentW: 25000, anchorRatio: 1 / 3, targetX: 0, scrollLeft: -100, dt: FRAME_MS, ratio: 1 });
    expect(neg.nextScrollLeft).toBeGreaterThanOrEqual(0);
    expect(neg.nextScrollLeft).toBeLessThanOrEqual(25000 - 900);

    const over = stepFollow({ containerW: 900, contentW: 25000, anchorRatio: 1 / 3, targetX: 999999, scrollLeft: 999999, dt: FRAME_MS, ratio: 1 });
    expect(over.nextScrollLeft).toBeLessThanOrEqual(25000 - 900);
  });

  it('containerW=0：不产生 NaN / Infinity', () => {
    const out = stepFollow({ containerW: 0, contentW: 25000, anchorRatio: 1 / 3, targetX: 3000, scrollLeft: 0, dt: FRAME_MS, ratio: 1 });
    expect(Number.isFinite(out.nextScrollLeft)).toBe(true);
    expect(out.deadband).toBe(0);
  });
});

describe('follow —— 目标 x 与锚点', () => {
  it('currentFollowTargetX：tick 落在第 5 小节（index=4）时返回该小节左边界', () => {
    const layout = layoutTab(30, { singleRow: true });
    const tick = 4 * PER_MEASURE + 100;
    expect(currentFollowTargetX(layout, tick, TS)).toBe(4 * MEASURE_W);
    expect(currentFollowMeasureWidth(layout, tick, TS)).toBe(MEASURE_W);
  });

  it('currentFollowTargetX：tick 越界（曲尾）返回最后一小节右边界', () => {
    const layout = layoutTab(10, { singleRow: true });
    const afterEnd = 10 * PER_MEASURE + 5;
    expect(currentFollowTargetX(layout, afterEnd, TS)).toBe(9 * MEASURE_W + MEASURE_W);
  });

  it('currentFollowTargetX：tick=0 返回 0；空布局返回 0', () => {
    expect(currentFollowTargetX(layoutTab(10, { singleRow: true }), 0, TS)).toBe(0);
    expect(currentFollowTargetX(layoutTab(0), 0, TS)).toBe(0);
  });

  it('折行布局也能定位（编辑器兼容）', () => {
    const layout = layoutTab(9); // 3 行 × 3 小节（末行 1 小节）
    // index=5 → 第 2 行第 2 个 → x = 250
    expect(currentFollowTargetX(layout, 5 * PER_MEASURE, TS)).toBe(MEASURE_W);
  });

  it('anchorRatioForWidth：≤1023 居中，>1023 左 1/3', () => {
    expect(anchorRatioForWidth(375, 1023)).toBe(1 / 2);
    expect(anchorRatioForWidth(1023, 1023)).toBe(1 / 2);
    expect(anchorRatioForWidth(1024, 1023)).toBe(1 / 3);
    expect(anchorRatioForWidth(1920, 1023)).toBe(1 / 3);
    // 未知宽度（0）退化为桌面
    expect(anchorRatioForWidth(0, 1023)).toBe(1 / 3);
  });
});

describe('follow —— 单行降级与宽度保护', () => {
  it('shouldFallbackToWrap：>120 降级，≤120 保留单行', () => {
    expect(shouldFallbackToWrap(120, 120)).toBe(false);
    expect(shouldFallbackToWrap(121, 120)).toBe(true);
    expect(shouldFallbackToWrap(0, 120)).toBe(false);
  });

  it('safeMeasureWidth：总宽不超上限时原样返回；超限时收窄到不越界', () => {
    expect(safeMeasureWidth(250, 120, 32000)).toBe(250); // 120*250 = 30000 ≤ 32000
    expect(safeMeasureWidth(250, 132, 32000)).toBe(242); // 132*250 = 33000 超限 → floor(32000/132) = 242
    const narrowed = safeMeasureWidth(250, 200, 32000); // 200*250 = 50000 超限
    expect(narrowed).toBe(160); // floor(32000/200)
    expect(narrowed * 200).toBeLessThanOrEqual(32000);
  });

  it('ROW_H 单行高度与布局行高一致（组件 min-h 复用该常量）', () => {
    const layout = layoutTab(50, { singleRow: true });
    expect(layout.rowH).toBe(ROW_H);
    expect(layout.rows.length * ROW_H).toBe(ROW_H);
  });
});
