import { describe, expect, it } from 'vitest';
import {
  assignChord,
  assignFingering,
  assignMelody,
  foldIntoRange,
  type StaffNote,
} from '@/core/staffFingering';
import {
  DEFAULT_CHORD_STROKE,
  classifyGroup,
  inferChordStroke,
  inferStroke,
} from '@/core/strokeInference';
import { stringsForChar } from '@/core/rhythm';

describe('core/staffFingering —— 音域折叠', () => {
  it('音域内不折叠：E2=40、E6=88', () => {
    expect(foldIntoRange(40)).toEqual({ midi: 40, octaveShifted: false });
    expect(foldIntoRange(88)).toEqual({ midi: 88, octaveShifted: false });
  });

  it('超低音折叠 +1 八度：B1(35) → 47 且 octaveShifted', () => {
    expect(foldIntoRange(35)).toEqual({ midi: 47, octaveShifted: true });
  });

  it('超高音折叠 −1 八度：C7(96) → 84 且 octaveShifted', () => {
    expect(foldIntoRange(96)).toEqual({ midi: 84, octaveShifted: true });
  });
});

describe('core/staffFingering —— 单音指法', () => {
  it('E4(64)→弦1品0', () => {
    expect(assignMelody([64])).toEqual([{ string: 1, fret: 0 }]);
  });

  it('A3(57)→弦3品2', () => {
    expect(assignMelody([57])).toEqual([{ string: 3, fret: 2 }]);
  });

  it('E2(40)→弦6品0', () => {
    expect(assignMelody([40])).toEqual([{ string: 6, fret: 0 }]);
  });
});

describe('core/staffFingering —— 和弦指法', () => {
  it('C4/E4/G4 大三和弦：弦互异、无同弦冲突、低把位', () => {
    const pos = assignChord([60, 64, 67]);
    const placed = pos.filter((p): p is NonNullable<typeof p> => p !== null);
    expect(placed).toHaveLength(3);
    const strings = placed.map((p) => p.string);
    expect(new Set(strings).size).toBe(3);
    const frets = placed.map((p) => p.fret);
    expect(Math.max(...frets) - Math.min(...frets)).toBeLessThanOrEqual(4);
  });
});

describe('core/staffFingering —— confidence 规则', () => {
  const staff = (midi: number, tick = 0): StaffNote => ({ midi, tick, durationTick: 480 });

  it('正常低把位 confidence 高（≥0.85）', () => {
    const notes = assignFingering([staff(64)]);
    expect(notes[0].confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('超音域折叠（B1=35）confidence < 0.45', () => {
    const notes = assignFingering([staff(35)]);
    expect(notes[0].confidence).toBeLessThan(0.45);
  });

  it('高把位 fret>15 置信度进一步下降（≤0.6）', () => {
    // C7(96) → 折叠到 84 → 1 弦 20 品（fret>15）→ 折叠 + 高把位双重惩罚
    const notes = assignFingering([staff(96)]);
    expect(notes[0].fret).toBeGreaterThan(15);
    expect(notes[0].confidence).toBeLessThanOrEqual(0.6);
  });
});

describe('core/strokeInference —— 扫弦方向（增量 §1.4）', () => {
  it('单音 → melody，多音 → chord', () => {
    expect(classifyGroup([64])).toBe('melody');
    expect(classifyGroup([60, 64])).toBe('chord');
  });

  it('块状和弦默认 D（无时间顺序）', () => {
    expect(DEFAULT_CHORD_STROKE).toBe('D');
    expect(inferChordStroke(null)).toBe('D');
    expect(inferChordStroke()).toBe('D');
  });

  it('低→高（up 琶音）→ D；高→低（down 琶音）→ U', () => {
    expect(inferChordStroke('up')).toBe('D');
    expect(inferChordStroke('down')).toBe('U');
  });

  it('inferStroke：单音 null、和弦 D/U、分解 P', () => {
    expect(inferStroke([64])).toBeNull();
    expect(inferStroke([60, 64])).toBe('D');
    expect(inferStroke([60, 64], 'down')).toBe('U');
    expect(inferStroke([60, 64], null, true)).toBe('P');
  });

  it('交叉断言：inferChordStroke 方向与 stringsForChar(D/U) 弦序一致', () => {
    const down = stringsForChar('D', '320003').strings; // G 和弦全弦发声
    const up = stringsForChar('U', '320003').strings;
    // D = 低→高（弦号递减）；U = 高→低（弦号递增）
    expect(down[0]).toBeGreaterThan(down[down.length - 1]);
    expect(up[0]).toBeLessThan(up[up.length - 1]);
    // inferChordStroke('up')（低→高）→ 'D'，与 down 方向一致
    expect(inferChordStroke('up')).toBe('D');
    // inferChordStroke('down')（高→低）→ 'U'，与 up 方向一致
    expect(inferChordStroke('down')).toBe('U');
  });

  it('assignFingering 注入 stroke：单音 null、和弦默认 D', () => {
    const melody = assignFingering([{ midi: 64, tick: 0, durationTick: 480 }]);
    expect(melody[0].stroke).toBeNull();

    const chord = assignFingering([
      { midi: 60, tick: 0, durationTick: 480 },
      { midi: 64, tick: 0, durationTick: 480 },
    ]);
    for (const n of chord) expect(n.stroke).toBe('D');
  });

  it('assignFingering 注入 arpeggiate down → U', () => {
    const chord = assignFingering([
      { midi: 60, tick: 0, durationTick: 480, arpeggiate: 'down' },
      { midi: 64, tick: 0, durationTick: 480, arpeggiate: 'down' },
    ]);
    for (const n of chord) expect(n.stroke).toBe('U');
  });
});
