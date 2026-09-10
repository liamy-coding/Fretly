/**
 * 练习页「自动跟随滚动」纯函数（PRD §5，架构 §3.1）。
 *
 * 本模块刻意放在 ui 层（不是 core/）：
 *  - 它服务的是「视图滚动」这一 UI 关注点，core 层不得反向依赖 ui；
 *  - 纯函数无 DOM 依赖，可在 vitest node 环境直接单测。
 *
 * ── 两条写死的约定（防实现漂移）──────────────────────────────────
 * 1. **驱动量 = 当前小节左边界 x**（不是播放头 x）；**安全带判定用小节中心**。
 *    这样长小节下「小节完整处于视口内」更接近 PRD §7-1 的验收。
 * 2. **缓动绝不用对称指数 `1-e^(-λt)`**：它永不真正收敛到 0，会持续发出
 *    scroll 事件 → 触发自我解除跟随。改用「**最小步长 1px 支配**」：
 *    差值 < 1px 就一步到位，之后落回安全带、自然停手，天然无抖动。
 */
import type { TabRenderLayout } from '@/ui/tab/tabRender';
import type { Tick, TimeSignature } from '@/types/tab';
import { measureIndexOf, measureStartTick } from '@/core/tick';
import {
  FOLLOW_DEADBAND_RATIO,
  FOLLOW_EASE,
  FOLLOW_EASE_SLOW,
  FOLLOW_MIN_STEP,
  SLOW_FOLLOW_RATIO,
  clamp,
} from '@/core/constants';

/** 单帧基准时长（ms），用于帧率无关的缓动系数折算 */
export const FRAME_MS = 16.67;
/** dt 折算上限：切标签页回来时不一次跳一大截 */
export const DT_CLAMP_MAX = 3;

export interface FollowInput {
  /** 视口宽（container.clientWidth） */
  containerW: number;
  /** 谱面总宽（= renderW） */
  contentW: number;
  /** 锚点比例：桌面 1/3、移动 <1024px 1/2 */
  anchorRatio: number;
  /** 当前小节左边界在谱面坐标系中的绝对 x */
  targetX: number;
  /** 当前滚动位置（CSS px） */
  scrollLeft: number;
  /** 距上一帧的毫秒数 */
  dt: number;
  /** 播放比例；≤ SLOW_FOLLOW_RATIO 时缓动系数减半 */
  ratio: number;
}

export interface FollowOut {
  shouldScroll: boolean;
  nextScrollLeft: number;
  /** 半屏安全带宽度（调用方可复用它判「立即贴合」） */
  deadband: number;
}

/**
 * 纯：单帧跟随步进。
 * 安全带内不移动；越界则按「帧率无关比例缓动 + 最小步长 1px」逼近锚点。
 */
export function stepFollow(i: FollowInput): FollowOut {
  const containerW = Math.max(0, i.containerW);
  const contentW = Math.max(0, i.contentW);
  const maxScroll = Math.max(0, contentW - containerW);
  const scrollLeft = clamp(i.scrollLeft, 0, maxScroll);
  const anchorPx = containerW * i.anchorRatio;
  const delta = i.targetX - anchorPx - scrollLeft;
  const deadband = containerW * FOLLOW_DEADBAND_RATIO;

  if (Math.abs(delta) <= deadband) {
    return { shouldScroll: false, nextScrollLeft: scrollLeft, deadband };
  }

  const base = i.ratio <= SLOW_FOLLOW_RATIO ? FOLLOW_EASE_SLOW : FOLLOW_EASE;
  const k = base * clamp(i.dt / FRAME_MS, 0, DT_CLAMP_MAX);
  const eased = delta >= 0 ? Math.max(FOLLOW_MIN_STEP, delta * k) : Math.min(-FOLLOW_MIN_STEP, delta * k);
  const next = clamp(scrollLeft + eased, 0, maxScroll);
  if (next === scrollLeft) {
    // 已顶到边界（contentW < containerW 或已到 0/max）：不视为滚动，避免滚动事件空转
    return { shouldScroll: false, nextScrollLeft: scrollLeft, deadband };
  }
  return { shouldScroll: true, nextScrollLeft: next, deadband };
}

/**
 * 纯：当前小节左边界在谱面坐标系中的 x（跟随驱动量）。
 * `tick` 越界（曲尾）时返回最后一小节右边界，保证「播完停在末尾」视觉合理。
 */
export function currentFollowTargetX(layout: TabRenderLayout, tick: number, timeSignature: TimeSignature): number {
  const rows = layout.rows;
  if (rows.length === 0) return 0;
  const all = rows.flatMap((r) => r.measures).sort((a, b) => a.index - b.index);
  if (all.length === 0) return 0;
  const mi = measureIndexOf(tick, timeSignature);
  const box = all.find((b) => b.index === mi);
  if (box) return box.x;
  const last = all[all.length - 1];
  const totalMeasures = last.index + 1;
  if (measureStartTick(totalMeasures, timeSignature) <= tick) return last.x + last.w;
  // 数据缺失（measureCount 与布局不一致）：退化到首小节
  return all[0].x;
}

/**
 * 纯：当前小节宽度（安全带判定用小节中心时使用）。
 * 布局缺失时退化为 0（调用方会把中心视作左边界）。
 */
export function currentFollowMeasureWidth(layout: TabRenderLayout, tick: number, timeSignature: TimeSignature): number {
  const mi = measureIndexOf(tick, timeSignature);
  for (const row of layout.rows) {
    const box = row.measures.find((b) => b.index === mi);
    if (box) return box.w;
  }
  return 0;
}

/** 纯：根据视口宽决定锚点比例（<1024px 居中，否则左 1/3） */
export function anchorRatioForWidth(containerW: number, mobileMaxW: number): number {
  return containerW > 0 && containerW <= mobileMaxW
    ? 1 / 2
    : 1 / 3;
}

/**
 * 纯：单行模式下的降级判定 —— 小节数超过 maxSingleRowMeasures 时回退折行。
 * 抽出便于单测（TabCanvas 只消费结果）。
 */
export function shouldFallbackToWrap(measureCount: number, maxSingleRowMeasures: number): boolean {
  return measureCount > maxSingleRowMeasures;
}

/**
 * 纯：单行模式小节宽上限保护。
 * `layoutTab` 是纯函数、不读视口，故「弹性小节宽」不在此处实现（保持默认行为逐字节不变）；
 * 这里只做 canvas 尺寸上限的降级保护：单行总宽超出 canvas 上限时按整数倍收窄。
 * 返回实际可用的每小节宽度（px）。
 */
export function safeMeasureWidth(measureW: number, measureCount: number, canvasMaxPx: number): number {
  const total = measureW * measureCount;
  if (total <= canvasMaxPx) return measureW;
  const byCount = canvasMaxPx / Math.max(1, measureCount);
  return Math.max(1, Math.min(measureW, Math.floor(byCount)));
}

// ── 三道闸：区分「程序滚动」与「用户滚动」（架构 §3.2）────────────

export interface ScrollGateInput {
  /** 闸 1：本次 scroll 是否由我们刚写入 scrollLeft 触发（标志位） */
  programmatic: boolean;
  /** 拖动中（pointerdown 之后、pointerup 之前）→ 一律短路 */
  dragging: boolean;
  /** 当前容器 scrollLeft */
  scrollLeft: number;
  /** 我们上次写入的 scrollLeft */
  lastWritten: number;
  /** 上次程序写入的时间戳（performance.now()；0 = 从未写过） */
  lastWriteAt: number;
  /** 本次 scroll 事件的时间戳（performance.now()） */
  now: number;
  /** 事件宽限窗口（ms） */
  graceMs: number;
  /** 位移阈值（px） */
  epsilon: number;
}

/**
 * 纯：闸 1 + 闸 2 的判定 —— 该 scroll 事件是否应判定为「用户滚动」。
 *
 * 与 `TabCanvas` 的 onScroll 一一对应（抽出来是为了可单测时序契约）：
 *  1. `programmatic` → 消费标志位，判为程序滚动；
 *  2. `dragging` → 事件交织，短路保护，不判为用户滚动；
 *  3. 时间窗内（`now - lastWriteAt <= graceMs`）→ 视为程序写入的迟到事件；
 *  4. 否则若 |scrollLeft - lastWritten| > epsilon → 判为用户滚动。
 *
 * 说明：这里**不依赖 `scrollend`**（Safari < 17 不支持）。
 */
export function shouldTreatScrollAsUser(i: ScrollGateInput): boolean {
  if (i.programmatic) return false; // 闸 1
  if (i.dragging) return false; // 拖动中一律短路
  const withinGrace = i.lastWriteAt !== 0 && i.now - i.lastWriteAt <= i.graceMs; // 闸 2 时间窗
  if (withinGrace) return false;
  return Math.abs(i.scrollLeft - i.lastWritten) > i.epsilon; // 闸 2 位移比对
}

export { FOLLOW_EASE, FOLLOW_EASE_SLOW, FOLLOW_MIN_STEP, SLOW_FOLLOW_RATIO, FOLLOW_DEADBAND_RATIO };
export type { Tick };
