import { describe, expect, it } from 'vitest';
import type { Measure, Note, NoteId, Tab } from '@/types/tab';
import {
  MEASURE_W,
  ROW_H,
  ROW_MEASURES,
  STRUM_GROUP_GAP_TICKS,
  barlineYOf,
  contentXOf,
  hitTest,
  layoutTab,
  stringYOf,
  strumVisualTicks,
  totalTabSize,
} from '@/ui/tab/tabRender';

let nid = 0;
function note(p: { string: Note['string']; startTick: number; stroke: Note['stroke']; fret?: number }): Note {
  nid += 1;
  return {
    id: `n_${nid}` as NoteId,
    string: p.string,
    fret: p.fret ?? 0,
    startTick: p.startTick,
    durationTick: 120,
    velocity: 0.8,
    techniques: [],
    confidence: 1,
    finger: null,
    stroke: p.stroke,
  };
}

describe('ui/tab/tabRender —— 小节分割线对齐（barlineYOf）', () => {
  it('barlineYOf 与 stringYOf 同源，严格包住 6 条弦', () => {
    expect(barlineYOf(0)).toEqual({ top: 36, bottom: 121 });
    const { top, bottom } = barlineYOf(0);
    expect(top).toBeLessThan(stringYOf(0, 1));
    expect(stringYOf(0, 1)).toBeLessThan(stringYOf(0, 6));
    expect(stringYOf(0, 6)).toBeLessThan(bottom);
  });
});

describe('ui/tab/tabRender —— 扫弦视觉左对齐（strumVisualTicks）', () => {
  it('同一 D 扫弦相邻 ≤12 tick 归并到组首；P 单音不归并；U 扫弦独立归并', () => {
    const notes = [
      note({ string: 5, startTick: 100, stroke: 'D' }),
      note({ string: 4, startTick: 103, stroke: 'D' }),
      note({ string: 3, startTick: 106, stroke: 'D' }),
      note({ string: 2, startTick: 200, stroke: 'P' }),
      note({ string: 3, startTick: 300, stroke: 'U' }),
      note({ string: 2, startTick: 304, stroke: 'U' }),
    ];
    const map = strumVisualTicks(notes);
    expect(map.get(notes[0].id)).toBe(100);
    expect(map.get(notes[1].id)).toBe(100);
    expect(map.get(notes[2].id)).toBe(100);
    expect(map.get(notes[3].id)).toBe(200);
    expect(map.get(notes[4].id)).toBe(300);
    expect(map.get(notes[5].id)).toBe(300);
  });

  it('相邻同 stroke 但间隔 >12 tick 拆成两组', () => {
    const gap = STRUM_GROUP_GAP_TICKS + 1;
    const notes = [
      note({ string: 5, startTick: 100, stroke: 'D' }),
      note({ string: 4, startTick: 100 + gap, stroke: 'D' }),
    ];
    const map = strumVisualTicks(notes);
    expect(map.get(notes[0].id)).toBe(100);
    expect(map.get(notes[1].id)).toBe(100 + gap);
  });

  it('P / null 单音各保持真实 startTick，并把后续扫弦断开为新组', () => {
    const notes = [
      note({ string: 5, startTick: 100, stroke: 'D' }),
      note({ string: 4, startTick: 101, stroke: 'D' }),
      note({ string: 3, startTick: 102, stroke: null }),
      note({ string: 2, startTick: 103, stroke: 'P' }),
      note({ string: 1, startTick: 104, stroke: 'D' }),
    ];
    const map = strumVisualTicks(notes);
    expect(map.get(notes[0].id)).toBe(100);
    expect(map.get(notes[1].id)).toBe(100);
    expect(map.get(notes[2].id)).toBe(102);
    expect(map.get(notes[3].id)).toBe(103);
    expect(map.get(notes[4].id)).toBe(104);
  });
});

describe('ui/tab/tabRender —— drawTab/hitTest 同源（扫弦视觉对齐后命中）', () => {
  it('在扫弦组首 x、各弦 y 处命中正确弦（y 决定选弦，不因左对齐错位）', () => {
    const measure: Measure = {
      index: 0,
      startTick: 0,
      ticks: 1920,
      chords: [],
      notes: [
        note({ string: 5, startTick: 100, stroke: 'D' }),
        note({ string: 4, startTick: 103, stroke: 'D' }),
        note({ string: 3, startTick: 106, stroke: 'D' }),
      ],
      sectionLabel: '',
    };
    const tab = { tracks: [{ measures: [measure] }] } as unknown as Tab;
    const layout = layoutTab(1);
    const box = layout.rows[0].measures[0];

    const visTicks = strumVisualTicks(measure.notes);
    const groupTick = visTicks.get(measure.notes[0].id);
    expect(groupTick).toBe(100);
    const groupX = contentXOf(box, measure.ticks, groupTick as number);

    for (const n of measure.notes) {
      const ny = stringYOf(box.y, n.string);
      const hit = hitTest(tab, layout, groupX, ny);
      expect(hit?.note?.id).toBe(n.id);
      expect(hit?.string).toBe(n.string);
    }
  });
});

describe('ui/tab/tabRender —— layoutTab 单行模式（练习页播放器化）', () => {
  it('默认行为不变：不传 opts 与 singleRow:false 深比较相等（守住既有折行语义）', () => {
    for (const n of [0, 1, 4, 5, 8, 9, 200]) {
      expect(layoutTab(n, { singleRow: false })).toEqual(layoutTab(n));
      expect(layoutTab(n, {})).toEqual(layoutTab(n));
    }
  });

  it('折行模式：行数 = ceil(N/4)，每行 ≤ 4 小节，x = i*250', () => {
    for (const n of [1, 4, 5, 8, 9, 200]) {
      const l = layoutTab(n);
      expect(l.rows.length).toBe(Math.ceil(n / ROW_MEASURES));
      for (const row of l.rows) {
        expect(row.measures.length).toBeLessThanOrEqual(ROW_MEASURES);
        row.measures.forEach((m, i) => expect(m.x).toBe(i * MEASURE_W));
      }
    }
  });

  it('单行模式：行数恒为 1，含全部小节，x 严格递增且 = i*250', () => {
    for (const n of [1, 4, 5, 200, 5000]) {
      const l = layoutTab(n, { singleRow: true });
      expect(l.rows.length).toBe(1);
      expect(l.rows[0].measures.length).toBe(n);
      let prevX = -Infinity;
      l.rows[0].measures.forEach((m, i) => {
        expect(m.index).toBe(i);
        expect(m.x).toBe(i * MEASURE_W);
        expect(m.x).toBeGreaterThan(prevX);
        prevX = m.x;
      });
    }
  });

  it('measureCount=0：折行与单行都返回空布局（rows.length===0）', () => {
    expect(layoutTab(0).rows.length).toBe(0);
    expect(layoutTab(0, { singleRow: true }).rows.length).toBe(0);
  });

  it('弹性小节宽：单行 + measureW 生效，x = i*measureW，w/measureW 同步回传', () => {
    for (const mw of [251, 480, 640, 1200]) {
      const l = layoutTab(8, { singleRow: true, measureW: mw });
      expect(l.measureW).toBe(mw);
      expect(l.rows.length).toBe(1);
      l.rows[0].measures.forEach((m, i) => {
        expect(m.x).toBe(i * mw);
        expect(m.w).toBe(mw);
      });
    }
  });

  it('弹性小节宽：折行模式忽略 measureW（恒为 MEASURE_W，守住既有折行语义）', () => {
    // singleRow 未开 → 即使传了 measureW 也不得影响折行布局
    expect(layoutTab(5, { measureW: 999 })).toEqual(layoutTab(5));
    expect(layoutTab(5, { singleRow: false, measureW: 999 })).toEqual(layoutTab(5));
    const l = layoutTab(5, { measureW: 999 });
    expect(l.measureW).toBe(MEASURE_W);
    l.rows.forEach((row) => row.measures.forEach((m, i) => expect(m.x).toBe(i * MEASURE_W)));
  });

  it('弹性小节宽：非法值（0/负数/NaN）回退 MEASURE_W，不破坏布局', () => {
    for (const bad of [0, -1, Number.NaN]) {
      const l = layoutTab(3, { singleRow: true, measureW: bad });
      expect(l.measureW).toBe(MEASURE_W);
      l.rows[0].measures.forEach((m, i) => expect(m.x).toBe(i * MEASURE_W));
    }
  });

  it('弹性小节宽：小数向下取整为整数像素（避免半像素模糊）', () => {
    const l = layoutTab(3, { singleRow: true, measureW: 333.7 });
    expect(l.measureW).toBe(333);
    expect(Number.isInteger(l.measureW)).toBe(true);
    l.rows[0].measures.forEach((m) => expect(Number.isInteger(m.x)).toBe(true));
  });

  it('totalTabSize：弹性单行总宽 = N*measureW，高度恒 ROW_H', () => {
    for (const [n, mw] of [
      [1, 640],
      [7, 300],
      [120, 480],
    ] as const) {
      expect(totalTabSize(layoutTab(n, { singleRow: true, measureW: mw }))).toEqual({
        w: n * mw,
        h: ROW_H,
      });
    }
  });

  it('totalTabSize：折行 ≤ 4 小节宽度；单行为 N*250 且高度 = ROW_H', () => {
    expect(totalTabSize(layoutTab(1))).toEqual({ w: MEASURE_W, h: ROW_H });
    expect(totalTabSize(layoutTab(5))).toEqual({ w: 4 * MEASURE_W, h: 2 * ROW_H });
    for (const n of [1, 7, 120]) {
      expect(totalTabSize(layoutTab(n, { singleRow: true }))).toEqual({ w: n * MEASURE_W, h: ROW_H });
    }
  });

  it('单行命中测试仍正确：x 落在第 k 小节时命中 index=k（架构 §5-2 风险点）', () => {
    const measures: Measure[] = Array.from({ length: 10 }, (_, i) => ({
      index: i,
      startTick: i * 1920,
      ticks: 1920,
      chords: [],
      notes: [],
      sectionLabel: '',
    }));
    const tab = { tracks: [{ measures }] } as unknown as Tab;
    const layout = layoutTab(10, { singleRow: true });
    const box = layout.rows[0].measures[6];
    // y 单行下恒落在带内
    const hit = hitTest(tab, layout, box.x + 5, stringYOf(box.y, 3));
    expect(hit?.measure.index).toBe(6);
    expect(hit?.string).toBe(3);
  });
});
