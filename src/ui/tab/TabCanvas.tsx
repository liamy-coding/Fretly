/**
 * 双 Canvas 六线谱组件（架构 §2.10-47，T-19）。
 * 静态层：曲谱（低频重绘）；overlay：循环区底色 + 播放头（rAF 高频，直读 Transport）。
 * 滚动共享一个 overflow 容器；命中测试调用 tabRender 纯函数。
 *
 * 播放器化改造（PRD §5，架构 §1/§3.2/§4）：
 *  - `singleRow`：单行横向谱面（仅练习页传；编辑器不传 → 行为零变化）。
 *  - 自动跟随滚动：`scrollLeft` 只在 rAF 内直写 DOM，**不进任何 state**；
 *    `followEnabled` 是本组件局部 state（不进 store）；跨层「恢复跟随」走 `resetNonce`。
 *  - 三道闸区分「程序滚动 / 用户滚动」：标志位 + 位移比对时间窗 + 意图事件
 *    （wheel / pointerdown）。任何监听器都不 `preventDefault`。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { Tab } from '@/types/tab';
import { measureIndexOf } from '@/core/tick';
import {
  contentXOf,
  drawTab,
  hitTest,
  layoutTab,
  MEASURE_W,
  stringYOf,
  totalTabSize,
  type MeasureBox,
} from '@/ui/tab/tabRender';
import {
  anchorRatioForWidth,
  currentFollowMeasureWidth,
  currentFollowTargetX,
  safeMeasureWidth,
  shouldFallbackToWrap,
  shouldTreatScrollAsUser,
  stepFollow,
} from '@/ui/tab/follow';
import {
  FOLLOW_MOBILE_MAX_W,
  MAX_SINGLE_ROW_MEASURES,
  PROGRAM_SCROLL_GRACE_MS,
  SINGLE_ROW_FILL_RATIO,
  USER_SCROLL_EPSILON,
  COPY,
} from '@/core/constants';
import { useAppStore } from '@/state/useAppStore';
import { usePracticeStore } from '@/state/usePracticeStore';
import { cn, useRaf } from '@/ui/kit';

/** canvas 尺寸硬上限（各浏览器 32767 左右，取保守值） */
const CANVAS_MAX_PX = 32000;
/** 单行模式下每隔多少小节重复画弦名 + 小节号 */
const STRING_LABEL_EVERY = 4;

export interface TabCanvasProps {
  tab: Tab;
  mode: 'practice' | 'editor';
  /** rAF overlay 播放头 provider；缺省为静止 0 */
  playheadTick?: () => number;
  onSeek?: (tick: number) => void;
  onNoteClick?: (noteId: string | null, measureIndex: number) => void;
  selectedNoteId?: string | null;
  highlightMeasure?: number | null;
  loop?: { start: number; end: number } | null;
  showConfidence?: boolean;
  showFinger?: boolean;
  className?: string;
  /** 单行横向谱面（仅练习页 true） */
  singleRow?: boolean;
  /** 是否启用自动跟随滚动（仅 practice + singleRow 生效） */
  follow?: boolean;
  /** 跟随状态上报（父层只读，不回流） */
  onFollowChange?: (enabled: boolean) => void;
  /** 强制恢复跟随信号：+1 触发（回开头 / 换曲 / focusMarker / togglePlay） */
  resetNonce?: number;
}

export function TabCanvas({
  tab,
  mode,
  playheadTick,
  onSeek,
  onNoteClick,
  selectedNoteId = null,
  highlightMeasure = null,
  loop = null,
  showConfidence = false,
  showFinger = false,
  className,
  singleRow = false,
  follow = false,
  onFollowChange,
  resetNonce,
}: TabCanvasProps) {
  const measureCount = tab.tracks[0]?.measures.length ?? 0;
  /** 容器宽度（低频 state，仅供弹性小节宽派生；rAF 内仍用 containerWRef 避免强制布局） */
  const [containerW, setContainerW] = useState(0);
  // 尺寸上限降级：超过 MAX_SINGLE_ROW_MEASURES 直接回退折行（架构 §2 兜底防线）
  const wantsSingleRow = singleRow && mode === 'practice';
  const effectiveSingleRow = wantsSingleRow && !shouldFallbackToWrap(measureCount, MAX_SINGLE_ROW_MEASURES);
  /**
   * 单行总宽 250×N 必须不超 canvas 上限，否则降级折行。
   * `MAX_SINGLE_ROW_MEASURES=120` 时最大 30000px < 32000px 上限，正常不触发；
   * 若将来调大上限常量，这里仍能兜住（画出来是降级而非崩画布）。
   */
  const singleRowOversize = effectiveSingleRow && safeMeasureWidth(250, measureCount, CANVAS_MAX_PX) < 250;
  const singleRowSafe = effectiveSingleRow && !singleRowOversize;

  /**
   * 弹性小节宽（单行模式）：让谱面尽量占满视口，短曲不再左侧留大片空白。
   * 目标 = 视口宽 × SINGLE_ROW_FILL_RATIO / 小节数，夹在 [MEASURE_W, 上限] 内；
   * 超过 canvas 尺寸上限时由 safeMeasureWidth 收窄兜底。折行模式恒为 MEASURE_W。
   */
  const desiredMeasureW = useMemo(() => {
    if (!singleRowSafe) return undefined;
    const target = (containerW * SINGLE_ROW_FILL_RATIO) / Math.max(1, measureCount);
    return Math.max(MEASURE_W, Math.floor(target));
  }, [singleRowSafe, containerW, measureCount]);

  const layout = useMemo(
    () => layoutTab(measureCount, { singleRow: singleRowSafe, measureW: desiredMeasureW }),
    [measureCount, singleRowSafe, desiredMeasureW],
  );
  const { w, h } = useMemo(() => totalTabSize(layout), [layout]);
  const staticRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [dpr] = useState(() => (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1));
  const latest = useRef({ tab, layout, loop, showConfidence, showFinger, selectedNoteId, highlightMeasure, playheadTick, mode });
  latest.current = { tab, layout, loop, showConfidence, showFinger, selectedNoteId, highlightMeasure, playheadTick, mode };

  const followActive = follow && singleRowSafe;

  // 播放态与播放比例（低速时缓动减半）：低频订阅，不进 rAF
  const isPlaying = usePracticeStore((s) => s.isPlaying);
  const ratio = usePracticeStore((s) => s.ratio);
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;

  // ── 跟随状态（本组件局部，不入 store）──────────────────────────
  const [followEnabled, setFollowEnabled] = useState<boolean>(true);
  const followRef = useRef(followEnabled);
  followRef.current = followEnabled;

  /** 程序写入的标记（闸 1）：写 scrollLeft 前置 true，onScroll 消费 */
  const programmaticRef = useRef(false);
  const lastWrittenRef = useRef(0);
  const lastAutoWriteAtRef = useRef(0);
  /** 拖动中（pointerdown 之后、pointerup 之前）：一律短路，不看差值 */
  const draggingRef = useRef(false);
  /** 容器宽缓存（避免 rAF 内 getBoundingClientRect 触发强制布局） */
  const containerWRef = useRef(0);
  /** 单行宽度计算用的视口宽（同样来自缓存的 clientWidth） */
  const contentWRef = useRef(0);

  const disableFollow = useCallback(() => {
    if (followRef.current) {
      followRef.current = false;
      setFollowEnabled(false);
      // 同步 ref，避免同一帧内多次判定时读到旧值
    } else {
      followRef.current = false;
    }
  }, []);

  const enableFollow = useCallback(() => {
    followRef.current = true;
    setFollowEnabled(true);
  }, []);

  useEffect(() => {
    onFollowChange?.(followEnabled);
  }, [followEnabled, onFollowChange]);

  // ── 容器宽度缓存（仅在挂载 / 尺寸变化 / 内容变化时更新）─────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const sync = () => {
      containerWRef.current = el.clientWidth;
      contentWRef.current = el.scrollWidth;
      // 同步到 state 以驱动弹性小节宽（低频，仅尺寸变化时触发重渲染）
      setContainerW(el.clientWidth);
    };
    sync();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(sync);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, [w, h, singleRowSafe]);

  // ── 强制恢复跟随 + 平滑复位（resetNonce 是唯一入口）────────────
  // 触发点：resetNonce(+1) / 挂载 / 换曲（tab.id 变）。注意这里**不含 followActive**，
  // 否则「切到和弦视图再切回」会重建 effect 并误复位滚动位（PRD §5.3 只要求上述三处复位）。
  useEffect(() => {
    if (!followActive) return;
    enableFollow();
    const el = scrollRef.current;
    if (!el) return;
    programmaticRef.current = true;
    lastWrittenRef.current = 0;
    lastAutoWriteAtRef.current = performance.now();
    el.scrollLeft = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetNonce, followActive, tab.id]);

  // ── 三道闸监听器（全部 passive，绝不 preventDefault）───────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      if (!followActive) return;
      const now = performance.now();
      // 闸 1：标志位 —— 程序写入的滚动事件在此被精确消费（同步 emit，标志位必被消费）
      const wasProgrammatic = programmaticRef.current;
      if (wasProgrammatic) programmaticRef.current = false;
      // 闸 2 + 拖动短路：抽成纯函数 shouldTreatScrollAsUser（可单测）
      const isUser = shouldTreatScrollAsUser({
        programmatic: wasProgrammatic,
        dragging: draggingRef.current,
        scrollLeft: el.scrollLeft,
        lastWritten: lastWrittenRef.current,
        lastWriteAt: lastAutoWriteAtRef.current,
        now,
        graceMs: PROGRAM_SCROLL_GRACE_MS,
        epsilon: USER_SCROLL_EPSILON,
      });
      if (isUser) disableFollow();
    };
    // 闸 3a：滚轮 —— 立即解除。
    // ★ 只认「横向意图」：触控板横向滑动（deltaX 主导）或 Shift+滚轮（浏览器把竖轮映射为横向）。
    //   纯竖向滚轮落在此事件上说明容器已滚到头（overscroll 不滚动），属于页面纵向滚动，
    //   不应夺走跟随，否则「页面上下滚一下」就会误判为用户在看谱面。
    const onWheel = (e: WheelEvent) => {
      if (!followActive) return;
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey;
      if (horizontal) disableFollow();
    };
    // 闸 3b：指针按下（拖动 / 滚动条 / 移动端触摸唯一可靠信号）—— 立即解除
    const onPointerDown = () => {
      if (followActive) disableFollow();
    };
    const onPointerUp = () => {
      draggingRef.current = false;
    };
    const onPointerCancel = () => {
      draggingRef.current = false;
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('pointerup', onPointerUp, { passive: true });
    window.addEventListener('pointercancel', onPointerCancel, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
    };
  }, [followActive, disableFollow]);

  // 降级提示（仅 practice 单行意图被降级时提示一次）
  const warnedRef = useRef(false);
  useEffect(() => {
    if (!wantsSingleRow || effectiveSingleRow || warnedRef.current) return;
    warnedRef.current = true;
    useAppStore.getState().toast('info', COPY.singleRowTooLong);
  }, [wantsSingleRow, effectiveSingleRow]);

  // ── 静态层重绘（低频）───────────────────────────────────────────
  useEffect(() => {
    const canvas = staticRef.current;
    if (!canvas) return;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawTab(ctx, tab, layout, {
      showFinger,
      showConfidence,
      selectedNoteId,
      // practice 模式的小节高亮移到 overlay rAF（与播放头同源）；highlightMeasure 仅保留给 editor 选区
      highlightMeasure: mode === 'editor' ? highlightMeasure : null,
      stringLabelEvery: singleRowSafe ? STRING_LABEL_EVERY : undefined,
    });
  }, [tab, layout, w, h, dpr, showFinger, showConfidence, selectedNoteId, highlightMeasure, mode, singleRowSafe]);

  /**
   * overlay 画布尺寸缓存 —— ★既有隐患修复★
   * 原实现每帧执行 `canvas.width = w * dpr`，单行下 w 会从 ~1000 膨胀到 ~30000，
   * 每帧重设会分配巨型后备缓冲 → 必然卡死。改为「只在尺寸变化时重设」。
   */
  const overlaySizeRef = useRef({ w: 0, h: 0, dpr: 0 });

  // Overlay 层：播放头 + 循环区（rAF）
  useRaf((_now, dt) => {
    const canvas = overlayRef.current;
    const L = latest.current;
    if (!canvas) return;
    const size = overlaySizeRef.current;
    if (size.w !== w || size.h !== h || size.dpr !== dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      overlaySizeRef.current = { w, h, dpr };
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 循环区
    if (L.loop) {
      ctx.fillStyle = 'rgba(37,99,235,0.10)';
      const x0 = tickToGlobalX(L.tab, L.layout, L.loop.start);
      const x1 = tickToGlobalX(L.tab, L.layout, L.loop.end);
      if (x1 >= x0) ctx.fillRect(x0, 0, x1 - x0, h);
    }
    // 播放头 + 当前小节高亮（同源：都从 playheadTick() 派生的 tick 计算）
    const getTick = L.playheadTick;
    const tick = getTick ? getTick() : 0;
    if (getTick) {
      // 当前小节底：与播放头同帧、同 tick 派生，消除 seek/回跳/换曲后的色块滞留
      const mi = measureIndexOf(tick, L.tab.timeSignature);
      const box = findMeasureBox(L.layout, mi);
      if (box) {
        ctx.fillStyle = 'rgba(37,99,235,0.06)';
        ctx.fillRect(box.x + 1, box.y, box.w - 1, box.h);
      }
      if (tick > 0 || (L.loop && L.loop.end > 0)) {
        const x = tickToGlobalX(L.tab, L.layout, tick);
        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
    }

    // ── 自动跟随滚动（仅 practice + singleRow，且 followEnabled）──
    if (!followActive || !followRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const containerW = containerWRef.current || el.clientWidth;
    if (containerW <= 0) return;
    const contentW = contentWRef.current || el.scrollWidth || w;
    // 驱动量 = 当前小节左边界 x；安全带判定用小节中心
    const boxLeft = currentFollowTargetX(L.layout, tick, L.tab.timeSignature);
    const boxW = currentFollowMeasureWidth(L.layout, tick, L.tab.timeSignature);
    const centerX = boxLeft + boxW / 2;
    const anchorRatio = anchorRatioForWidth(containerW, FOLLOW_MOBILE_MAX_W);
    const deadband = containerW * 0.5;
    // 安全带：用「小节中心」与锚点比较，带内不滚动（避免播放头微动导致画面持续漂移）
    if (Math.abs(centerX - anchorRatio * containerW - el.scrollLeft) <= deadband) return;
    const out = stepFollow({
      containerW,
      contentW,
      anchorRatio,
      targetX: boxLeft,
      scrollLeft: el.scrollLeft,
      dt,
      ratio: ratioRef.current,
    });
    if (!out.shouldScroll) return;
    programmaticRef.current = true;
    lastWrittenRef.current = out.nextScrollLeft;
    lastAutoWriteAtRef.current = performance.now();
    el.scrollLeft = out.nextScrollLeft;
  });

  // 指针交互
  const [dragNote, setDragNote] = useState<string | null>(null);

  const canvasPos = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = staticRef.current;
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    draggingRef.current = true;
    const pos = canvasPos(e);
    if (!pos) return;
    const L = latest.current;
    const hit = hitTest(L.tab, L.layout, pos.x, pos.y);
    if (!hit) return;
    if (hit.note) {
      setDragNote(hit.note.id);
      onNoteClick?.(hit.note.id, hit.measure.index);
      return;
    }
    // 空白 → 定位到该相对 tick
    const m = L.tab.tracks[0]?.measures[hit.measure.index];
    if (m && onSeek) {
      const global = m.startTick + hit.relTick;
      onSeek(global);
      onNoteClick?.(null, hit.measure.index);
    }
  };

  const handlePointerUp = () => {
    draggingRef.current = false;
    setDragNote(null);
  };

  // 「恢复跟随」浮层：仅在「跟随被解除 且 正在播放」时出现（不新增第二个标志位）
  const showResume = followActive && !followEnabled && isPlaying;

  return (
    <div className={cn('relative', className)}>
      <div
        ref={scrollRef}
        className={
          effectiveSingleRow
            ? 'fretly-tab-scroll relative w-full overflow-x-auto overflow-y-hidden'
            : 'fretly-scroll relative w-full overflow-x-auto overflow-y-hidden'
        }
      >
        <div style={{ position: 'relative', width: w, height: h }}>
          <canvas
            ref={staticRef}
            className="tab-canvas"
            style={{ position: 'absolute', inset: 0, width: w, height: h, touchAction: 'pan-x pan-y' }}
            onPointerDown={mode === 'practice' || mode === 'editor' ? handlePointerDown : undefined}
            onPointerMove={() => undefined}
            onPointerUp={handlePointerUp}
            onPointerLeave={() => setDragNote(null)}
          />
          <canvas
            ref={overlayRef}
            className="tab-canvas pointer-events-none"
            style={{ position: 'absolute', inset: 0, width: w, height: h }}
          />
        </div>
      </div>
      {/* ★ 浮层必须在滚动容器【之外】：放容器内会随 scrollLeft 一起横向滚出视口 */}
      {showResume && (
        <button
          type="button"
          onClick={enableFollow}
          className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-full border border-brand/30 bg-surface/95 px-2.5 py-1 text-xs font-medium text-brand shadow-sm backdrop-blur hover:bg-brand-soft"
        >
          <span aria-hidden="true">▶</span>
          {COPY.resumeFollow}
        </button>
      )}
      {dragNote && <div className="sr-only">已选中 {dragNote}</div>}
    </div>
  );
}

export function tickToGlobalX(tab: Tab, layout: ReturnType<typeof layoutTab>, tick: number): number {
  const track = tab.tracks[0];
  if (!track) return 0;
  const m = track.measures.find((mm) => tick >= mm.startTick && tick < mm.startTick + mm.ticks);
  if (!m) {
    const last = track.measures[track.measures.length - 1];
    if (!last) return 0;
    if (tick >= last.startTick + last.ticks) {
      const box = findMeasureBox(layout, last.index);
      return box ? box.x + box.w : 0;
    }
    return 0;
  }
  const box = findMeasureBox(layout, m.index);
  if (!box) return 0;
  return contentXOf(box, m.ticks, tick - m.startTick);
}

function findMeasureBox(layout: ReturnType<typeof layoutTab>, index: number): MeasureBox | null {
  for (const row of layout.rows) {
    const box = row.measures.find((b) => b.index === index);
    if (box) return box;
  }
  return null;
}

export { stringYOf };
