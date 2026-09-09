import { describe, expect, it } from 'vitest';
import type { Measure, Note, NoteId, Tab } from '@/types/tab';
import {
  STRUM_GROUP_GAP_TICKS,
  barlineYOf,
  contentXOf,
  hitTest,
  layoutTab,
  stringYOf,
  strumVisualTicks,
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
