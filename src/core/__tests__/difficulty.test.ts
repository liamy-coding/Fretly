import { describe, expect, it } from 'vitest';
import type { ChordEvent, Measure, Tab, Technique } from '@/types/tab';
import { clamp } from '@/core/constants';
import { computeDifficulty, createEmptyTab, difficultyFactors } from '@/core/tabFactory';

interface TabSpec {
  /** 每小节的和弦名列表 */
  chordsPerMeasure: string[][];
  bpm: number;
  notesPerMeasure?: number;
  /** 带技巧的音符数（按整首计） */
  techniqueNotes?: number;
}

function chord(name: string, tick = 0): ChordEvent {
  return { tick, name, diagram: 'x32010', confidence: 1 };
}

function makeTab(spec: TabSpec): Tab {
  const tab = createEmptyTab({ bpm: spec.bpm });
  const per = 1920;
  const measures: Measure[] = spec.chordsPerMeasure.map((names, index) => {
    const count = names.length;
    const chords = names.map((n, i) => chord(n, Math.round((i * per) / count)));
    const notes = Array.from({ length: spec.notesPerMeasure ?? 0 }, (_, i) => ({
      id: `n_${index}_${i}` as `n_${string}`,
      string: 1 as const,
      fret: 0,
      startTick: i * 120,
      durationTick: 120,
      velocity: 0.75,
      techniques: (i < (spec.techniqueNotes ?? 0) ? ['h'] : []) as Technique[],
      confidence: 1,
      finger: null,
      stroke: 'P' as const,
    }));
    return { index, startTick: index * per, ticks: per, chords, notes, sectionLabel: '' };
  });
  tab.tracks[0].measures = measures;
  return tab;
}

describe('core/tabFactory —— 难度公式（PRD §5.5）', () => {
  it('D = 0.35×barre + 0.25×density + 0.25×speed + 0.15×tech，difficulty = clamp(round(1+4D),1,5)', () => {
    const tab = makeTab({ chordsPerMeasure: [['C'], ['F']], bpm: 84, notesPerMeasure: 4, techniqueNotes: 1 });
    const f = difficultyFactors(tab);
    expect(f.D).toBeCloseTo(
      0.35 * f.barreRatio + 0.25 * f.chordChangesDensity + 0.25 * f.speedRatio + 0.15 * f.techniqueDensity,
      10,
    );
    expect(computeDifficulty(tab)).toBe(clamp(Math.round(1 + 4 * f.D), 1, 5));
  });

  it('四个因子全满 → 5 星', () => {
    // 两个横按和弦（F / F#m）+ 每小节两和弦（变化次数 3 / 2 小节 → 密度 1）
    // + BPM 180（speedRatio 1）+ 全部音符带技巧
    const tab = makeTab({
      chordsPerMeasure: [
        ['F', 'F#m'],
        ['F#m', 'F'],
      ],
      bpm: 180,
      notesPerMeasure: 2,
      techniqueNotes: 2,
    });
    const f = difficultyFactors(tab);
    expect(f.barreRatio).toBe(1);
    expect(f.chordChangesDensity).toBe(1);
    expect(f.speedRatio).toBe(1);
    expect(f.techniqueDensity).toBe(1);
    expect(f.D).toBeCloseTo(1, 10);
    expect(computeDifficulty(tab)).toBe(5);
  });

  it('四个因子全零 → 1 星', () => {
    const tab = makeTab({ chordsPerMeasure: [['C'], ['C']], bpm: 60 });
    const f = difficultyFactors(tab);
    expect(f.barreRatio).toBe(0);
    expect(f.chordChangesDensity).toBe(0);
    expect(f.speedRatio).toBe(0);
    expect(f.techniqueDensity).toBe(0);
    expect(computeDifficulty(tab)).toBe(1);
  });

  it('speedRatio = clamp((bpm − 60) / 120, 0, 1)', () => {
    expect(difficultyFactors(makeTab({ chordsPerMeasure: [['C']], bpm: 60 })).speedRatio).toBe(0);
    expect(difficultyFactors(makeTab({ chordsPerMeasure: [['C']], bpm: 120 })).speedRatio).toBeCloseTo(0.5, 10);
    expect(difficultyFactors(makeTab({ chordsPerMeasure: [['C']], bpm: 180 })).speedRatio).toBe(1);
    expect(difficultyFactors(makeTab({ chordsPerMeasure: [['C']], bpm: 40 })).speedRatio).toBe(0);
  });

  it('barreRatio = 含横按和弦数 / 不同和弦总数（F / Bm / Bb / F#m 记为横按）', () => {
    expect(difficultyFactors(makeTab({ chordsPerMeasure: [['C'], ['G']], bpm: 60 })).barreRatio).toBe(0);
    expect(difficultyFactors(makeTab({ chordsPerMeasure: [['C'], ['F']], bpm: 60 })).barreRatio).toBe(0.5);
    expect(difficultyFactors(makeTab({ chordsPerMeasure: [['F'], ['Bm']], bpm: 60 })).barreRatio).toBe(1);
  });

  it('chordChangesDensity = min(1, 和弦变化次数 / 小节数)', () => {
    // C,C,F,F,C → 相邻和弦事件不同仅在 C→F、F→C 两处，共 2 次变化
    const tab = makeTab({
      chordsPerMeasure: [['C'], ['C'], ['F'], ['F'], ['C']],
      bpm: 60,
    });
    const f = difficultyFactors(tab);
    expect(f.chordChangesDensity).toBeCloseTo(2 / 5, 10);
  });

  it('中间档：barre 0.5 / density 0.8 / speed 0.2 / tech 0.5 → D = 0.5 → 3 星', () => {
    const tab = makeTab({
      chordsPerMeasure: [['C'], ['F'], ['C'], ['F'], ['C']],
      bpm: 84,
      notesPerMeasure: 2, // 共 10 个音符
      techniqueNotes: 1, // 每小节第 1 个带技巧 → 5 / 10 = 0.5
    });
    const f = difficultyFactors(tab);
    expect(f.barreRatio).toBe(0.5);
    expect(f.chordChangesDensity).toBeCloseTo(4 / 5, 10);
    expect(f.speedRatio).toBeCloseTo(0.2, 10);
    expect(f.techniqueDensity).toBeCloseTo(0.5, 10);
    expect(f.D).toBeCloseTo(0.5, 10);
    expect(computeDifficulty(tab)).toBe(3);
  });
});
