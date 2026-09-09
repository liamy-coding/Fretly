import { describe, expect, it, vi } from 'vitest';
import { RHYTHM_PATTERNS } from '@/data/rhythmPatterns';
import {
  activeSlots,
  expandPattern,
  expandPatternById,
  isSoundingChar,
  rakeTicks,
  slotTicks,
  stringsForChar,
} from '@/core/rhythm';
import { MEASURE_TICKS_4_4, MEASURE_TICKS_3_4 } from './helpers';

const C = 'x32010';
const G = '320003';

describe('core/rhythm —— slotTicks（PRD §7.1）', () => {
  it('4/4 单和弦 + 8 字符 → 240', () => {
    expect(slotTicks(MEASURE_TICKS_4_4, 8)).toBe(240);
  });
  it('3/4 单和弦 + 6 字符 → 240', () => {
    expect(slotTicks(MEASURE_TICKS_3_4, 6)).toBe(240);
  });
  it('4/4 一小节两和弦（各 960）+ 8 字符 → 120', () => {
    expect(slotTicks(960, 8)).toBe(120);
  });
});

describe('core/rhythm —— rakeTicks（PRD §7.3 Step 2）', () => {
  it('BPM 72 → 3 ticks', () => {
    expect(rakeTicks(72)).toBe(3);
  });
  it('下限 1 / 上限 12', () => {
    expect(rakeTicks(20)).toBe(1);
    expect(rakeTicks(240)).toBe(12);
    expect(rakeTicks(1000)).toBe(12);
  });
  it('BPM 40 → 2', () => {
    expect(rakeTicks(40)).toBe(2);
  });
});

describe('core/rhythm —— 字符 → 弦序列（PRD §7.3 Step 3）', () => {
  it('C 和弦下扫 = [5,4,3,2,1]（低音弦 → 高音弦）', () => {
    expect(stringsForChar('D', C).strings).toEqual([5, 4, 3, 2, 1]);
  });

  it('C 和弦上扫 = sortedAsc(sounded ∩ {1,2,3}) = [1,2,3]，不是下扫逆序', () => {
    expect(stringsForChar('U', C).strings).toEqual([1, 2, 3]);
    expect(stringsForChar('U', C).strings).not.toEqual([1, 2, 3, 4, 5].reverse().slice(0, 5));
  });

  it('G 和弦（六弦全响）下扫 = [6,5,4,3,2,1]，上扫仍只到 3 弦', () => {
    expect(stringsForChar('D', G).strings).toEqual([6, 5, 4, 3, 2, 1]);
    expect(stringsForChar('U', G).strings).toEqual([1, 2, 3]);
  });

  it('上扫交集为空时退化为 [hiString]', () => {
    expect(stringsForChar('U', '765xxx').strings).toEqual([4]);
  });

  it('闷音 x 与下扫同弦序，stroke = X，velocity 0.5，带技巧标记', () => {
    const r = stringsForChar('x', C);
    expect(r.strings).toEqual([5, 4, 3, 2, 1]);
    expect(r.stroke).toBe('X');
    expect(r.velocity).toBe(0.5);
    expect(r.techniques).toEqual(['x']);
  });

  it('分解字符取该弦；该弦为 x 时替换为最低有声弦（D 和弦 5323 的 5 弦 → 4 弦）', () => {
    expect(stringsForChar('5', C).strings).toEqual([5]);
    expect(stringsForChar('3', 'xx0232').strings).toEqual([3]);
    expect(stringsForChar('5', 'xx0232').strings).toEqual([4]);
  });

  it('力度：下扫 0.85 / 上扫 0.65 / 分解 0.75', () => {
    expect(stringsForChar('D', C).velocity).toBe(0.85);
    expect(stringsForChar('U', C).velocity).toBe(0.65);
    expect(stringsForChar('3', C).velocity).toBe(0.75);
  });
});

describe('core/rhythm —— 12 个模板展开', () => {
  it('模板正好 12 个，扫弦 7 + 分解 5', () => {
    expect(RHYTHM_PATTERNS).toHaveLength(12);
    expect(RHYTHM_PATTERNS.filter((p) => p.type === 'strum')).toHaveLength(7);
    expect(RHYTHM_PATTERNS.filter((p) => p.type === 'arp')).toHaveLength(5);
  });

  it('每个模板在对应拍号下都能铺出音符，且全部落在本段内', () => {
    for (const p of RHYTHM_PATTERNS) {
      const segTicks = p.timeSignature[0] === 3 ? MEASURE_TICKS_3_4 : MEASURE_TICKS_4_4;
      const notes = expandPattern({
        diagram: C,
        pattern: p.pattern,
        segStartTick: 0,
        segTicks,
        bpm: 72,
      });
      expect(notes.length, `模板 ${p.id} 应产生音符`).toBeGreaterThan(0);
      for (const n of notes) {
        expect(n.startTick).toBeGreaterThanOrEqual(0);
        expect(n.startTick).toBeLessThan(segTicks);
        expect(n.durationTick).toBeGreaterThanOrEqual(1);
        expect(n.confidence).toBe(1);
      }
    }
  });

  it('发音 slot 序列与 PRD §7.2 表格一致', () => {
    const byId = (id: string) => RHYTHM_PATTERNS.find((p) => p.id === id)!;
    expect(activeSlots(byId('strum_quarter').pattern)).toEqual([0, 2, 4, 6]);
    expect(activeSlots(byId('strum_folk_basic').pattern)).toEqual([0, 2, 3, 5, 6, 7]);
    expect(activeSlots(byId('strum_eighth_alt').pattern)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(activeSlots(byId('strum_offbeat').pattern)).toEqual([1, 3, 5, 7]);
    expect(activeSlots(byId('strum_slow_ballad').pattern)).toEqual([0, 3, 4, 5, 7]);
    expect(activeSlots(byId('strum_cut').pattern)).toEqual([0, 2, 3, 5, 7]);
    expect(activeSlots(byId('strum_waltz_34').pattern)).toEqual([0, 2, 3, 4, 5]);
    expect(activeSlots(byId('arp_5323').pattern)).toEqual([0, 2, 4, 6]);
    expect(activeSlots(byId('arp_waltz_34').pattern)).toEqual([0, 2, 4]);
  });

  it('3/4 模板在 3/4 小节里每个 slot = 240 ticks', () => {
    const notes = expandPattern({
      diagram: 'xx0232',
      pattern: 'D-DUDU',
      segStartTick: 0,
      segTicks: MEASURE_TICKS_3_4,
      bpm: 96,
    });
    const starts = [...new Set(notes.map((n) => n.startTick))].sort((a, b) => a - b);
    expect(starts[0]).toBe(0);
    expect(starts).toContain(480); // slot 2 = 2 × 240
    expect(starts).toContain(720); // slot 3
  });

  it('isSoundingChar：只有 - 与空格不发声', () => {
    expect(isSoundingChar('D')).toBe(true);
    expect(isSoundingChar('-')).toBe(false);
    expect(isSoundingChar(' ')).toBe(false);
  });
});

describe('core/rhythm —— 边界用例（PRD §7.3）', () => {
  it('k = 0（和弦全为 x）：跳过并 console.warn，不产出音符', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const notes = expandPattern({
      diagram: 'xxxxxx',
      pattern: 'D-D-D-D-',
      segStartTick: 0,
      segTicks: MEASURE_TICKS_4_4,
      bpm: 72,
    });
    expect(notes).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('noteDur 不够铺开 rake 时压缩 rake，最后一个音至少 1 tick', () => {
    const notes = expandPattern({
      diagram: C,
      pattern: 'D-------', // 只有一个发声 slot
      segStartTick: 0,
      segTicks: 8, // slotTicks = 1，noteDur = 8
      bpm: 72, // baseRake = 3 → 8 − 4×3 < 0 → 压缩为 floor(8/5) = 1
    });
    expect(notes).toHaveLength(5);
    expect(notes.map((n) => n.startTick)).toEqual([0, 1, 2, 3, 4]);
    expect(notes.map((n) => n.durationTick)).toEqual([1, 1, 1, 1, 4]);
  });

  it('闷音 x 的 durationTick ≤ 120', () => {
    const notes = expandPattern({
      diagram: C,
      pattern: 'D-xU-D-U',
      segStartTick: 0,
      segTicks: MEASURE_TICKS_4_4,
      bpm: 72,
    });
    const muted = notes.filter((n) => n.stroke === 'X');
    expect(muted.length).toBeGreaterThan(0);
    for (const n of muted) expect(n.durationTick).toBeLessThanOrEqual(120);
  });

  it('最后一个发声 slot 的时值延伸到和弦段末尾', () => {
    const notes = expandPattern({
      diagram: C,
      pattern: 'D-D-D-D-',
      segStartTick: 0,
      segTicks: MEASURE_TICKS_4_4,
      bpm: 72,
    });
    const last = notes.filter((n) => n.startTick >= 1440);
    expect(last.length).toBe(5);
    // slot 6 起始 1440，rake 3，最后一个音的时长 = 480 − 4×3 = 468
    expect(Math.max(...last.map((n) => n.durationTick))).toBe(468);
  });

  it('分解模板每段只出一个音，时长等于到下一个 slot 的间隔', () => {
    const notes = expandPattern({
      diagram: C,
      pattern: '5-3-2-3-',
      segStartTick: 0,
      segTicks: MEASURE_TICKS_4_4,
      bpm: 76,
    });
    expect(notes).toHaveLength(4);
    expect(notes.map((n) => n.string)).toEqual([5, 3, 2, 3]);
    expect(notes.map((n) => n.startTick)).toEqual([0, 480, 960, 1440]);
    for (const n of notes) expect(n.durationTick).toBe(480);
    for (const n of notes) expect(n.stroke).toBe('P');
  });

  it('和弦段只占半小节时，slotTicks 按段长压缩', () => {
    const notes = expandPatternById('strum_quarter', {
      diagram: C,
      segStartTick: 960,
      segTicks: 960,
      bpm: 72,
    });
    // 半小节 + 8 字符 → slotTicks = 120；rake(72) = 3 < 120，所以 slot 起点都能被 120 整除
    expect(notes[0].startTick).toBe(960);
    expect([...new Set(notes.map((n) => n.startTick).filter((t) => (t - 960) % 120 === 0))]).toEqual([
      960, 1200, 1440, 1680,
    ]);
  });
});
