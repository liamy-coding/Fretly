import { describe, expect, it } from 'vitest';
import {
  OPEN_MIDI,
  STANDARD_TUNING,
  allPositions,
  diagramIndexOf,
  fretAt,
  fretToMidi,
  highestSoundingString,
  lowestFretPosition,
  lowestSoundingString,
  midiToNoteName,
  noteNameToMidi,
  soundedStrings,
  stringOf,
} from '@/core/fretboard';

describe('core/fretboard —— 方向转换（★ 全项目唯一出口）', () => {
  it('diagramIndexOf：1 弦 → 5，6 弦 → 0', () => {
    expect(diagramIndexOf(1)).toBe(5);
    expect(diagramIndexOf(6)).toBe(0);
    expect(diagramIndexOf(5)).toBe(1);
  });

  it('stringOf：0 → 6 弦，5 → 1 弦', () => {
    expect(stringOf(0)).toBe(6);
    expect(stringOf(5)).toBe(1);
  });

  it('diagramIndexOf / stringOf 往返一致', () => {
    for (let i = 0; i < 6; i += 1) {
      expect(diagramIndexOf(stringOf(i as 0 | 1 | 2 | 3 | 4 | 5))).toBe(i);
    }
    for (const s of [1, 2, 3, 4, 5, 6] as const) {
      expect(stringOf(diagramIndexOf(s))).toBe(s);
    }
  });
});

describe('core/fretboard —— 指位串解析', () => {
  it('C = x32010：6 弦不弹，1 弦空弦，5 弦 3 品', () => {
    expect(fretAt('x32010', 6)).toBe(-1);
    expect(fretAt('x32010', 5)).toBe(3);
    expect(fretAt('x32010', 2)).toBe(1);
    expect(fretAt('x32010', 1)).toBe(0);
  });

  it('C 的发声弦升序为 [1,2,3,4,5]（不含 6 弦）', () => {
    expect(soundedStrings('x32010')).toEqual([1, 2, 3, 4, 5]);
  });

  it('G = 320003：六根弦全部发声', () => {
    expect(soundedStrings('320003')).toEqual([1, 2, 3, 4, 5, 6]);
    expect(fretAt('320003', 6)).toBe(3);
    expect(fretAt('320003', 1)).toBe(3);
    expect(fretAt('320003', 3)).toBe(0);
  });

  it('loString = 弦号最大，hiString = 弦号最小', () => {
    expect(lowestSoundingString('x32010')).toBe(5);
    expect(highestSoundingString('x32010')).toBe(1);
    // D = xx0232：只有 1–4 弦发声
    expect(soundedStrings('xx0232')).toEqual([1, 2, 3, 4]);
    expect(lowestSoundingString('xx0232')).toBe(4);
    expect(highestSoundingString('xx0232')).toBe(1);
  });

  it('全 x 的和弦没有发声弦', () => {
    expect(soundedStrings('xxxxxx')).toEqual([]);
  });
});

describe('core/fretboard —— 音高', () => {
  it('标准调弦 6 弦 → 1 弦 = E A D G B E', () => {
    expect([...STANDARD_TUNING]).toEqual(['E', 'A', 'D', 'G', 'B', 'E']);
  });

  it('空弦 MIDI：1 弦 E4=64，6 弦 E2=40', () => {
    expect(OPEN_MIDI[1]).toBe(64);
    expect(OPEN_MIDI[6]).toBe(40);
  });

  it('fretToMidi = 空弦 MIDI + 品', () => {
    expect(fretToMidi(1, 0)).toBe(64);
    expect(fretToMidi(6, 3)).toBe(43);
    expect(fretToMidi(5, 3)).toBe(48);
  });

  it('音名 ↔ MIDI 往返', () => {
    expect(noteNameToMidi('E4')).toBe(64);
    expect(noteNameToMidi('E2')).toBe(40);
    expect(midiToNoteName(64)).toBe('E4');
    expect(midiToNoteName(40)).toBe('E2');
  });

  it('allPositions 只返回 0–24 品的合法位置，且低把位优先', () => {
    const positions = allPositions(64); // E4
    expect(positions.length).toBeGreaterThan(0);
    for (const p of positions) {
      expect(p.fret).toBeGreaterThanOrEqual(0);
      expect(p.fret).toBeLessThanOrEqual(24);
    }
    // 第一个位置一定是品位最低的
    expect(positions[0].fret).toBe(Math.min(...positions.map((p) => p.fret)));
  });

  it('lowestFretPosition 取品位最低的位置', () => {
    expect(lowestFretPosition(64)).toEqual({ string: 1, fret: 0 });
  });
});
