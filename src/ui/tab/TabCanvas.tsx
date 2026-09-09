/**
 * 双 Canvas 六线谱组件（架构 §2.10-47，T-19）。
 * 静态层：曲谱（低频重绘）；overlay：循环区底色 + 播放头（rAF 高频，直读 Transport）。
 * 滚动共享一个 overflow 容器；命中测试调用 tabRender 纯函数。
 */
import {
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
  stringYOf,
  totalTabSize,
  type MeasureBox,
} from '@/ui/tab/tabRender';
import { useRaf } from '@/ui/kit';

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
}: TabCanvasProps) {
  const measureCount = tab.tracks[0]?.measures.length ?? 0;
  const layout = useMemo(() => layoutTab(measureCount), [measureCount]);
  const { w, h } = useMemo(() => totalTabSize(layout), [layout]);
  const staticRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [dpr] = useState(() => (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1));
  const latest = useRef({ tab, layout, loop, showConfidence, showFinger, selectedNoteId, highlightMeasure, playheadTick, mode });
  latest.current = { tab, layout, loop, showConfidence, showFinger, selectedNoteId, highlightMeasure, playheadTick, mode };

  // 静态层重绘（低频）
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
    });
  }, [tab, layout, w, h, dpr, showFinger, showConfidence, selectedNoteId, highlightMeasure, mode]);

  // Overlay 层：播放头 + 循环区（rAF）
  useRaf(() => {
    const canvas = overlayRef.current;
    const L = latest.current;
    if (!canvas) return;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
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

  const handlePointerUp = () => setDragNote(null);

  return (
    <div className={className}>
      <div className="fretly-scroll w-full overflow-x-auto overflow-y-hidden">
        <div style={{ position: 'relative', width: w, height: h }}>
          <canvas
            ref={staticRef}
            className="tab-canvas"
            style={{ position: 'absolute', inset: 0, width: w, height: h, touchAction: 'manipulation' }}
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
