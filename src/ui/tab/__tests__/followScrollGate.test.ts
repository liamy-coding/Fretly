// @vitest-environment jsdom
/**
 * 三道闸时序契约单测（架构 §6「组件层」）。
 *
 * 不引入 @testing-library：直接 `document.createElement` 手写 DOM，
 * 绑定与 `TabCanvas` **完全同构**的监听器（passive scroll / wheel / pointerdown），
 * 复现「程序写入 scrollLeft 不自我解除」与「用户滚动立即解除」的时序契约。
 * 闸的判定核心 `shouldTreatScrollAsUser` 是纯函数，这里再补一层集成验证。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROGRAM_SCROLL_GRACE_MS, USER_SCROLL_EPSILON } from '@/core/constants';
import { shouldTreatScrollAsUser, type ScrollGateInput } from '@/ui/tab/follow';

/**
 * 与 TabCanvas 同构的最小滚动控制器（仅供测试）。
 * 真实组件里这三个量都是 ref，这里用普通变量等价替换。
 */
function createGate() {
  const el = document.createElement('div');
  // jsdom 不做真实布局，手动维护 scrollLeft / clientWidth
  let scrollLeft = 0;
  Object.defineProperty(el, 'scrollLeft', {
    get: () => scrollLeft,
    set: (v: number) => {
      scrollLeft = v;
      el.dispatchEvent(new Event('scroll'));
    },
    configurable: true,
  });

  let followEnabled = true;
  let programmatic = false;
  let lastWritten = 0;
  let lastWriteAt = 0;
  let dragging = false;
  let nowMs = 0;

  const onScroll = () => {
    if (!followEnabled) return;
    const wasProgrammatic = programmatic;
    if (wasProgrammatic) programmatic = false;
    const isUser = shouldTreatScrollAsUser({
      programmatic: wasProgrammatic,
      dragging,
      scrollLeft: el.scrollLeft,
      lastWritten,
      lastWriteAt,
      now: nowMs,
      graceMs: PROGRAM_SCROLL_GRACE_MS,
      epsilon: USER_SCROLL_EPSILON,
    });
    if (isUser) followEnabled = false;
  };

  el.addEventListener('scroll', onScroll, { passive: true });
  el.addEventListener(
    'wheel',
    (e) => {
      const we = e as WheelEvent;
      const horizontal = Math.abs(we.deltaX) > Math.abs(we.deltaY) || we.shiftKey;
      if (horizontal) followEnabled = false;
    },
    { passive: true },
  );
  el.addEventListener('pointerdown', () => { dragging = true; followEnabled = false; }, { passive: true });

  return {
    el,
    get followEnabled() {
      return followEnabled;
    },
    setNow(ms: number) {
      nowMs = ms;
    },
    /** 模拟 rAF 内程序写入 */
    writeProgrammatic(target: number) {
      programmatic = true;
      lastWritten = target;
      lastWriteAt = nowMs;
      el.scrollLeft = target;
    },
    /** 模拟用户拖动（外部改 scrollLeft，不置标志位） */
    userScrollTo(target: number) {
      el.dispatchEvent(new Event('pointerdown'));
      el.scrollLeft = target;
    },
    endDrag() {
      dragging = false;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('三道闸（jsdom 时序契约）', () => {
  it('闸 1：程序写入 scrollLeft 触发的事件被标志位消费，不解除跟随', () => {
    const g = createGate();
    g.setNow(1000);
    g.writeProgrammatic(300);
    expect(g.el.scrollLeft).toBe(300);
    expect(g.followEnabled, '程序写入不得自我解除跟随').toBe(true);
  });

  it('闸 1 幂等：连续 60 帧程序写入仍保持跟随（模拟整段跟随滚动）', () => {
    const g = createGate();
    let x = 0;
    for (let f = 0; f < 60; f += 1) {
      g.setNow(1000 + f * 16.67);
      x += 20;
      g.writeProgrammatic(x);
    }
    expect(g.el.scrollLeft).toBe(1200);
    expect(g.followEnabled).toBe(true);
  });

  it('闸 3：横向滚轮（触控板 deltaX 主导）立即解除跟随', () => {
    const g = createGate();
    g.setNow(1000);
    g.writeProgrammatic(300);
    expect(g.followEnabled).toBe(true);
    g.el.dispatchEvent(new WheelEvent('wheel', { deltaX: 40, deltaY: 0 }));
    expect(g.followEnabled).toBe(false);
  });

  it('闸 3：Shift+竖向滚轮（浏览器横向映射）也解除跟随', () => {
    const g = createGate();
    g.setNow(1000);
    g.writeProgrammatic(300);
    g.el.dispatchEvent(new WheelEvent('wheel', { deltaX: 0, deltaY: 100, shiftKey: true }));
    expect(g.followEnabled).toBe(false);
  });

  it('闸 3（反向）：纯竖向滚轮（页面纵向滚动 overscroll）不解除跟随', () => {
    const g = createGate();
    g.setNow(1000);
    g.writeProgrammatic(300);
    g.el.dispatchEvent(new WheelEvent('wheel', { deltaX: 0, deltaY: 120 }));
    expect(g.followEnabled, '页面上下滚动不应夺走跟随').toBe(true);
  });

  it('闸 3：pointerdown（拖动 / 滚动条 / 移动端触摸）立即解除跟随', () => {
    const g = createGate();
    g.setNow(1000);
    g.writeProgrammatic(300);
    expect(g.followEnabled).toBe(true);
    g.el.dispatchEvent(new Event('pointerdown'));
    expect(g.followEnabled).toBe(false);
  });

  it('闸 2：拖动中外部改 scrollLeft 不参与差值判定（由 pointerdown 负责解除）', () => {
    const g = createGate();
    g.setNow(1000);
    g.writeProgrammatic(300);
    g.el.dispatchEvent(new Event('pointerdown'));
    expect(g.followEnabled).toBe(false);
    // 拖动过程中即使还有程序写入残留事件，也不应产生额外副作用
    g.userScrollTo(900);
    expect(g.el.scrollLeft).toBe(900);
    expect(g.followEnabled).toBe(false);
  });
});

describe('shouldTreatScrollAsUser —— 闸的判定表（纯函数）', () => {
  const base: ScrollGateInput = {
    programmatic: false,
    dragging: false,
    scrollLeft: 0,
    lastWritten: 0,
    lastWriteAt: 0,
    now: 10_000,
    graceMs: PROGRAM_SCROLL_GRACE_MS,
    epsilon: USER_SCROLL_EPSILON,
  };

  it('programmatic=true → 不是用户滚动（且优先于其它条件）', () => {
    expect(shouldTreatScrollAsUser({ ...base, programmatic: true, dragging: true, scrollLeft: 9999 })).toBe(false);
  });

  it('dragging=true → 不是用户滚动（短路）', () => {
    expect(shouldTreatScrollAsUser({ ...base, dragging: true, scrollLeft: 9999 })).toBe(false);
  });

  it('宽限窗口内 → 视为程序写入的迟到事件，不是用户滚动', () => {
    expect(
      shouldTreatScrollAsUser({ ...base, lastWritten: 100, lastWriteAt: 10_000, now: 10_000 + PROGRAM_SCROLL_GRACE_MS - 1, scrollLeft: 500 }),
    ).toBe(false);
  });

  it('窗口外且位移超阈值 → 是用户滚动', () => {
    expect(
      shouldTreatScrollAsUser({ ...base, lastWritten: 100, lastWriteAt: 10_000, now: 10_000 + PROGRAM_SCROLL_GRACE_MS + 1, scrollLeft: 500 }),
    ).toBe(true);
  });

  it('窗口外但位移在阈值内 → 不是用户滚动（亚像素抖动容忍）', () => {
    expect(
      shouldTreatScrollAsUser({
        ...base,
        lastWritten: 100,
        lastWriteAt: 10_000,
        now: 10_000 + PROGRAM_SCROLL_GRACE_MS + 1,
        scrollLeft: 100 + USER_SCROLL_EPSILON,
      }),
    ).toBe(false);
  });

  it('从未程序写入过（lastWriteAt=0）→ 只要位移超阈值即判为用户滚动', () => {
    expect(shouldTreatScrollAsUser({ ...base, lastWriteAt: 0, scrollLeft: 400 })).toBe(true);
    expect(shouldTreatScrollAsUser({ ...base, lastWriteAt: 0, scrollLeft: 0 })).toBe(false);
  });
});
