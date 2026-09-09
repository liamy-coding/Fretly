/**
 * 六线谱布局计算 + Canvas 绘制 + 命中测试（纯函数；架构 §2.10-46，T-19）。
 *
 * 画布坐标约定：
 *  - 每行最多 4 小节（ROW_MEASURES=4），按曲目小节顺序折行。
 *  - y 方向：1 弦（高音 e）在顶，6 弦在底。
 *  - 每个音符 x = 小节左 + 左侧留白 + 相对小节 tick 比例映射到内容区。
 * 函数不持有 ctx，绘制由调用方传入；便于 node 单测 layout/hitTest 纯逻辑。
 */
import type { Note, NoteId, Tab, Tick } from '@/types/tab';

export const MEASURE_W = 250;
export const ROW_MEASURES = 4;
export const STRING_GAP = 15;
export const STRING_COUNT = 6;
export const HEADER_H = 30;
export const FOOTER_H = 22;
export const ROW_H = HEADER_H + STRING_GAP * (STRING_COUNT - 1) + 26 + FOOTER_H;
export const PAD_X = 12;

export interface MeasureBox {
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TabRenderLayout {
  measureW: number;
  rowH: number;
  rows: { y: number; measures: MeasureBox[] }[];
}

/** 纯：根据小节数生成折行布局 */
export function layoutTab(measureCount: number): TabRenderLayout {
  const rows: TabRenderLayout['rows'] = [];
  for (let start = 0; start < measureCount; start += ROW_MEASURES) {
    const y = rows.length * ROW_H;
    const measures: MeasureBox[] = [];
    const count = Math.min(ROW_MEASURES, measureCount - start);
    for (let i = 0; i < count; i += 1) {
      const index = start + i;
      const w = MEASURE_W;
      measures.push({ index, x: i * MEASURE_W, y, w, h: ROW_H });
    }
    rows.push({ y, measures });
  }
  return { measureW: MEASURE_W, rowH: ROW_H, rows };
}

export function totalTabSize(layout: TabRenderLayout): { w: number; h: number } {
  const w = Math.min(ROW_MEASURES, Math.max(...layout.rows.map((r) => r.measures.length), 1)) * MEASURE_W;
  const h = layout.rows.length * ROW_H;
  return { w, h };
}

export function stringYOf(rowY: number, string: 1 | 2 | 3 | 4 | 5 | 6): number {
  const top = rowY + HEADER_H + 12;
  return top + (string - 1) * STRING_GAP;
}

/** 小节线/谱首竖线的纵向范围：包住 6 条弦，上下各留边距（与 drawTab 原 -6/+4 约定一致，且与 stringYOf 同源） */
export function barlineYOf(rowY: number): { top: number; bottom: number } {
  return { top: stringYOf(rowY, 1) - 6, bottom: stringYOf(rowY, 6) + 4 };
}

export function stringOfY(rowY: number, y: number): 1 | 2 | 3 | 4 | 5 | 6 | null {
  const top = rowY + HEADER_H + 12;
  const idx = Math.round((y - top) / STRING_GAP);
  if (idx >= 0 && idx < STRING_COUNT) return (idx + 1) as 1 | 2 | 3 | 4 | 5 | 6;
  return null;
}

export function contentXOf(measure: MeasureBox, ticks: number, tick: number): number {
  const inner = measure.w - PAD_X * 2;
  const frac = ticks > 0 ? Math.max(0, Math.min(1, tick / ticks)) : 0;
  return measure.x + PAD_X + frac * inner;
}

/** rakeTicks 的 clamp 上界（rhythm.ts:30），组内间隔 ≤ 该值、组间间隔 ≥ slotTicks ≫ 该值 */
export const STRUM_GROUP_GAP_TICKS = 12;

/**
 * 纯：把同一次扫弦（stroke∈{D,U} 且相邻 startTick 间隔 ≤ STRUM_GROUP_GAP_TICKS）
 * 归并到组首 tick，返回 noteId → 视觉 tick。数据层 note.startTick 不变，仅影响渲染/命中 x。
 * ★ drawTab 与 hitTest 必须共用这一单一映射，禁止各自内联。
 */
export function strumVisualTicks(notes: Note[]): Map<NoteId, Tick> {
  const out = new Map<NoteId, Tick>();
  const sorted = [...notes].sort((a, b) => a.startTick - b.startTick || a.string - b.string);
  let groupStart = 0;
  let groupStroke: Note['stroke'] = null;
  for (let i = 0; i < sorted.length; i += 1) {
    const n = sorted[i];
    const isStrum = n.stroke === 'D' || n.stroke === 'U';
    const sameGroup =
      i > 0 &&
      isStrum &&
      n.stroke === groupStroke &&
      n.startTick - sorted[i - 1].startTick <= STRUM_GROUP_GAP_TICKS;
    if (!sameGroup) {
      groupStart = n.startTick;
      groupStroke = isStrum ? n.stroke : null;
    }
    out.set(n.id, groupStart);
  }
  return out;
}

export function measureAt(layout: TabRenderLayout, x: number, y: number): MeasureBox | null {
  const row = layout.rows.find((r) => y >= r.y && y < r.y + ROW_H);
  if (!row) return null;
  return row.measures.find((m) => x >= m.x && x < m.x + m.w) ?? null;
}

export interface TabHit {
  measure: MeasureBox;
  note: Note | null;
  string: 1 | 2 | 3 | 4 | 5 | 6 | null;
  /** 命中的相对 tick（用于整小节点击跳转） */
  relTick: number;
}

/** 纯：命中测试（x,y → 小节 + 音符） */
export function hitTest(tab: Tab, layout: TabRenderLayout, x: number, y: number): TabHit | null {
  const measure = measureAt(layout, x, y);
  if (!measure) return null;
  const m = tab.tracks[0]?.measures[measure.index];
  if (!m) return null;
  const relTick = Math.round(((x - (measure.x + PAD_X)) / Math.max(1, measure.w - PAD_X * 2)) * m.ticks);
  const visTicks = strumVisualTicks(m.notes);
  let closest: Note | null = null;
  let bestDist = Infinity;
  for (const n of m.notes) {
    const nx = contentXOf(measure, m.ticks, visTicks.get(n.id) ?? n.startTick);
    const ny = stringYOf(measure.y, n.string);
    const d = Math.hypot(x - nx, y - ny);
    if (d < 15 && d < bestDist) {
      bestDist = d;
      closest = n;
    }
  }
  return { measure, note: closest, string: stringOfY(measure.y, y), relTick: Math.max(0, Math.min(m.ticks, relTick)) };
}

// ── 绘制 ──────────────────────────────────────────────────────────
export interface DrawOpts {
  showFinger?: boolean;
  showConfidence?: boolean;
  selectedNoteId?: string | null;
  highlightMeasure?: number | null;
  lowConfIds?: Set<string>;
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawTab(ctx: CanvasRenderingContext2D, tab: Tab, layout: TabRenderLayout, opts: DrawOpts = {}): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.font = '13px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';
  const track = tab.tracks[0];

  for (const row of layout.rows) {
    const { top, bottom } = barlineYOf(row.y);
    const first = row.measures[0];

    // 行左侧起始竖线（谱首）
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(first.x, top);
    ctx.lineTo(first.x, bottom);
    ctx.stroke();

    for (const box of row.measures) {
      const measure = track?.measures[box.index];
      const highlighted = opts.highlightMeasure === box.index;
      if (highlighted) {
        ctx.fillStyle = 'rgba(37,99,235,0.06)';
        ctx.fillRect(box.x + 1, box.y, box.w - 1, box.h);
      }
      if (!measure) continue;

      // 右小节线 + 4/4、3/4 终止/细分线
      ctx.strokeStyle = '#64748b';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(box.x + box.w, top);
      ctx.lineTo(box.x + box.w, bottom);
      ctx.stroke();

      // 六条弦
      for (let s = 1; s <= STRING_COUNT; s += 1) {
        const y = stringYOf(box.y, s as 1 | 2 | 3 | 4 | 5 | 6);
        ctx.strokeStyle = s === 3 || s === 4 ? '#94a3b8' : '#cbd5e1';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(box.x + 1, y);
        ctx.lineTo(box.x + box.w - 1, y);
        ctx.stroke();
      }

      // 弦名（每行只画一次，位于行首）
      if (box.x === 0) {
        ctx.fillStyle = '#94a3b8';
        ctx.font = '9px ui-sans-serif';
        ctx.textAlign = 'center';
        for (let s = 1; s <= STRING_COUNT; s += 1) {
          const y = stringYOf(box.y, s as 1 | 2 | 3 | 4 | 5 | 6);
          const names = ['e', 'B', 'G', 'D', 'A', 'E'];
          ctx.fillText(names[s - 1], box.x + 7, y);
        }
        ctx.textAlign = 'left';
      }

      // 和弦名（头部）
      ctx.font = '12px ui-sans-serif, PingFang SC, sans-serif';
      ctx.textAlign = 'left';
      const chordSlots = measure.chords;
      if (chordSlots.length > 0) {
        const nameY = box.y + 14;
        chordSlots.slice(0, 6).forEach((chord, i) => {
          const frac = chordSlots.length === 1 ? 0 : i / (chordSlots.length - 1);
          const cx = box.x + PAD_X + frac * Math.max(1, box.w - PAD_X * 2 - 16);
          ctx.fillStyle = 'rgba(37,99,235,0.9)';
          if (opts.showConfidence && chord.confidence < 0.45) {
            ctx.strokeStyle = '#f59e0b';
            ctx.setLineDash([3, 2]);
            ctx.strokeRect(cx - 14, nameY - 8, chord.name.length * 7 + 16, 14);
            ctx.setLineDash([]);
          }
          ctx.fillText(chord.name, cx, nameY);
        });
      }
      // 曲式标记
      if (measure.sectionLabel) {
        ctx.fillStyle = '#64748b';
        ctx.font = '10px ui-sans-serif';
        ctx.fillText(measure.sectionLabel, box.x + box.w - 8, row.y + 14);
      }
      ctx.textAlign = 'left';

      // 音符
      const visTicks = strumVisualTicks(measure.notes);
      for (const note of measure.notes) {
        const nx = contentXOf(box, measure.ticks, visTicks.get(note.id) ?? note.startTick);
        const ny = stringYOf(box.y, note.string);
        const low = opts.showConfidence && note.confidence < 0.45;
        const selected = opts.selectedNoteId === note.id;
        const rad = 7;
        ctx.fillStyle = selected ? '#2563eb' : low ? '#f59e0b' : '#1f2937';
        ctx.strokeStyle = selected ? '#2563eb' : '#111827';
        ctx.lineWidth = 1;
        roundedRect(ctx, nx - rad, ny - rad + 2, rad * 2, rad * 2 - 4, 3);
        ctx.fill();
        if (low) {
          ctx.setLineDash([2, 2]);
          ctx.strokeStyle = '#f59e0b';
          ctx.stroke();
          ctx.setLineDash([]);
        }
        // 数字 = 品
        ctx.fillStyle = '#ffffff';
        ctx.font = '10px ui-monospace, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(String(note.fret), nx, ny + 1);
        ctx.textAlign = 'left';
        // 技法标记
        if (note.techniques.length > 0 && note.techniques[0] !== '^') {
          ctx.fillStyle = '#0f766e';
          ctx.font = 'bold 10px ui-sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(note.techniques[0], nx + rad + 2, ny - 6);
          ctx.textAlign = 'left';
        }
        // 指法
        if (opts.showFinger && note.finger) {
          ctx.fillStyle = '#2563eb';
          ctx.font = '8px ui-sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(String(note.finger), nx, ny + rad + 6);
          ctx.textAlign = 'left';
        }
      }
    }
  }
}
