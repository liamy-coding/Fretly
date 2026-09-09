import { describe, expect, it } from 'vitest';
import type { Tab } from '@/types/tab';
import { BUILTIN_SONGS } from '@/data/builtinSongs';
import {
  buildTabFromChordChart,
  cloneTab,
  createEmptyTab,
  flattenNotes,
  regenerateMeasure,
  tabToScheduledNotes,
  totalTicksOfTab,
  validateTab,
} from '@/core/tabFactory';
import { getSimpler, isBarre } from '@/core/chords';
import { expandPattern } from '@/core/rhythm';

const [morning, chordChanges, arpeggio, waltz] = BUILTIN_SONGS;
const builtTabs: Tab[] = BUILTIN_SONGS.map(buildTabFromChordChart);

function chordNames(tab: Tab): string[] {
  return tab.tracks[0].measures.flatMap((m) => m.chords.map((c) => c.name));
}

describe('core/tabFactory —— 内置 4 首（PRD §8 播种自检清单）', () => {
  it('小节数：16 / 24 / 24 / 32', () => {
    expect(builtTabs.map((t) => t.tracks[0].measures.length)).toEqual([16, 24, 24, 32]);
  });

  it('拍号：只有 No.4 是 3/4，其余 4/4', () => {
    expect(builtTabs.map((t) => t.timeSignature)).toEqual([
      [4, 4],
      [4, 4],
      [4, 4],
      [3, 4],
    ]);
    expect(builtTabs.filter((t) => t.timeSignature[0] === 3)).toHaveLength(1);
    expect(builtTabs.filter((t) => t.timeSignature[0] === 4)).toHaveLength(3);
  });

  it('难度：1 / 2 / 3 / 4 星各 1 首', () => {
    expect(builtTabs.map((t) => t.difficulty)).toEqual([1, 2, 3, 4]);
  });

  it('调：C / G / Am / D 各 1 首', () => {
    expect(builtTabs.map((t) => t.key)).toEqual(['C', 'G', 'Am', 'D']);
    expect(builtTabs.filter((t) => t.key === 'D')).toHaveLength(1);
    expect(builtTabs.filter((t) => t.key === 'Am')).toHaveLength(1);
  });

  it('BPM 70–80 区间只命中 No.1(72) 与 No.3(76)', () => {
    const hit = builtTabs.filter((t) => t.bpm >= 70 && t.bpm <= 80);
    expect(hit.map((t) => t.bpm)).toEqual([72, 76]);
  });

  it('3/4 的小节长度 = 1440 ticks，4/4 = 1920 ticks', () => {
    for (const tab of builtTabs) {
      const expected = tab.timeSignature[0] === 3 ? 1440 : 1920;
      for (const m of tab.tracks[0].measures) expect(m.ticks).toBe(expected);
    }
  });

  it('practice 全为初始值，mastery = 0', () => {
    for (const tab of builtTabs) {
      expect(tab.practice.mastery).toBe(0);
      expect(tab.practice.bestBpm).toBe(0);
      expect(tab.practice.coveredMeasures).toEqual([]);
      expect(tab.practice.masteryComputedAt).toBeNull();
      expect(tab.practice.targetBpm).toBe(tab.bpm);
    }
  });

  it('source.type 均为 builtin，且曲名不含商业歌曲名', () => {
    for (const tab of builtTabs) {
      expect(tab.source.type).toBe('builtin');
      expect(tab.title.startsWith('练习曲 No.')).toBe(true);
    }
  });

  it('No.3 含 F（大横按）且可降级；No.4 含 Bm 且可降级', () => {
    expect(chordNames(arpeggioTab())).toContain('F');
    expect(isBarre('F')).toBe(true);
    expect(getSimpler('F').map((d) => d.diagram)).toContain('xx3211');
    expect(chordNames(waltzTab())).toContain('Bm');
    expect(isBarre('Bm')).toBe(true);
    expect(getSimpler('Bm').map((d) => d.diagram)).toContain('x20202');
  });

  it('节奏型 id 与 §8 规格一致', () => {
    expect(builtTabs.map((t) => t.rhythmPattern.id)).toEqual([
      'strum_quarter',
      'strum_folk_basic',
      'arp_5323',
      'strum_waltz_34',
    ]);
  });

  it('四首都通过 validateTab', () => {
    for (const tab of builtTabs) {
      const r = validateTab(tab);
      expect(r.ok, r.errors.join('；')).toBe(true);
    }
  });
});

function arpeggioTab(): Tab {
  return builtTabs[BUILTIN_SONGS.indexOf(arpeggio)];
}
function waltzTab(): Tab {
  return builtTabs[BUILTIN_SONGS.indexOf(waltz)];
}

describe('core/tabFactory —— 与节奏引擎共用 expandPattern', () => {
  it('No.1 每小节 = strum_quarter 展开的音符（4 个下扫 slot × 5 根发声弦 = 20）', () => {
    const tab = builtTabs[BUILTIN_SONGS.indexOf(morning)];
    const expected = expandPattern({
      diagram: 'x32010', // C
      pattern: 'D-D-D-D-',
      segStartTick: 0,
      segTicks: 1920,
      bpm: 72,
    });
    expect(expected).toHaveLength(20);
    expect(tab.tracks[0].measures[0].notes).toHaveLength(20);
    expect(tab.tracks[0].measures[0].notes.map((n) => [n.string, n.fret])).toEqual(
      expected.map((n) => [n.string, n.fret]),
    );
  });

  it('No.2 第 1 小节用民谣基础型，音符数与模板发音 slot 数吻合', () => {
    const tab = builtTabs[BUILTIN_SONGS.indexOf(chordChanges)];
    // G = 320003 六根弦全响；D-DU-UDU 里 D×3（6 音）+ U×3（3 音）= 18 + 9 = 27
    expect(tab.tracks[0].measures[0].notes).toHaveLength(27);
  });

  it('小节内所有音符都在 [0, measure.ticks) 区间内', () => {
    for (const tab of builtTabs) {
      for (const m of tab.tracks[0].measures) {
        for (const n of m.notes) {
          expect(n.startTick).toBeGreaterThanOrEqual(0);
          expect(n.startTick).toBeLessThan(m.ticks);
          expect(n.durationTick).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it('chords 的 tick 相对小节起始，且按 tick 升序', () => {
    for (const tab of builtTabs) {
      for (const m of tab.tracks[0].measures) {
        let prev = -1;
        for (const c of m.chords) {
          expect(c.tick).toBeGreaterThanOrEqual(0);
          expect(c.tick).toBeGreaterThanOrEqual(prev);
          prev = c.tick;
        }
      }
    }
  });
});

describe('core/tabFactory —— 通用能力', () => {
  it('createEmptyTab 给出合法默认值', () => {
    const tab = createEmptyTab({ title: '空谱', bpm: 90 });
    expect(tab.schema).toBe('fretly.tab');
    expect(tab.schemaVersion).toBe('1.1');
    expect(tab.ticksPerBeat).toBe(480);
    expect(tab.tuning).toEqual(['E', 'A', 'D', 'G', 'B', 'E']);
    expect(tab.practice.targetBpm).toBe(90);
    // 空谱（无小节）是合法草稿，但 validateTab 的"完整性"门禁要求 ≥1 小节；
    // 这里验证其它结构字段即可，另由"补充小节后通过校验"用例覆盖完整性路径。
  });

  it('cloneTab 深拷贝，互不影响', () => {
    const tab = builtTabs[0];
    const copy = cloneTab(tab);
    copy.tracks[0].measures[0].notes[0].fret = 22;
    expect(tab.tracks[0].measures[0].notes[0].fret).not.toBe(22);
  });

  it('regenerateMeasure 换模板后音符数随之变化，并写入 overrides', () => {
    const tab = builtTabs[0];
    const before = tab.tracks[0].measures[0].notes.length;
    const next = regenerateMeasure(tab, 0, 'strum_eighth_alt');
    expect(next.tracks[0].measures[0].notes.length).toBeGreaterThan(before);
    expect(next.rhythmPattern.overrides[0]).toBe('strum_eighth_alt');
    expect(next.revision).toBe(tab.revision + 1);
  });

  it('flattenNotes / tabToScheduledNotes 用全局 tick，且 midi 由 (弦, 品) 换算', () => {
    const tab = builtTabs[0];
    const flat = flattenNotes(tab);
    expect(flat[0].globalTick).toBe(flat[0].measureIndex * 1920 + flat[0].note.startTick);
    const scheduled = tabToScheduledNotes(tab);
    expect(scheduled).toHaveLength(flat.length);
    // C 和弦 5 弦 3 品 = C3 = MIDI 48
    const first = scheduled[0];
    expect(first.string).toBe(5);
    expect(first.fret).toBe(3);
    expect(first.midi).toBe(48);
  });

  it('totalTicksOfTab = 小节数 × 每小节 ticks', () => {
    const tab = builtTabs[3];
    expect(totalTicksOfTab(tab)).toBe(32 * 1440);
  });

  it('validateTab 拒绝错误 schema / 空小节 / 非法拍号', () => {
    expect(validateTab({}).ok).toBe(false);
    const tab = builtTabs[0];
    expect(validateTab({ ...tab, schema: 'other' }).ok).toBe(false);
    expect(validateTab({ ...tab, timeSignature: [5, 4] }).ok).toBe(false);
    expect(validateTab({ ...tab, tracks: [{ ...tab.tracks[0], measures: [] }] }).ok).toBe(false);
    expect(validateTab({ ...tab, bpm: 400 }).ok).toBe(false);
  });
});
