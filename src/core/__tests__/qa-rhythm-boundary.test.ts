/**
 * QA 边界回归 —— 节奏引擎方向与 slot 数学（独立于工程师用例）。
 *
 * 覆盖风险（team-lead 点名 + PRD §7）：
 *  1) 上扫 = sortedAsc(sounded ∩ {1,2,3})，不是下扫逆序
 *  2) C x32010 下扫 = 弦[5,4,3,2,1]（弦号递减：低音弦→高音弦）
 *  3) 3/4 一小节 = 1440 ticks；4/4 = 1920 ticks
 *  4) 一小节 2 和弦（各 960 ticks）+ 8 字符 pattern → slotTicks = 120
 *  5) rake 计算：BPM 72 → 3 ticks；clamp [1,12]
 *  6) slotTicks 边界：patternLen<=0 → 0
 */
import { describe, expect, it } from 'vitest';
import { measureTicks } from '@/core/tick';
import { slotTicks, rakeTicks, stringsForChar, activeSlots, expandPattern } from '@/core/rhythm';
import { RHYTHM_PATTERNS, PATTERN_BY_ID } from '@/data/rhythmPatterns';

describe('QA §7.1 —— tick 与 slot 数学', () => {
  it('4/4 一小节 = 1920 ticks；3/4 一小节 = 1440 ticks', () => {
    expect(measureTicks([4, 4])).toBe(1920);
    expect(measureTicks([3, 4])).toBe(1440);
  });

  it('一小节 1 个和弦（1920）+ 8 字符 → 240；一小节 2 和弦（各 960）+ 8 字符 → 120', () => {
    expect(slotTicks(1920, 8)).toBe(240);
    expect(slotTicks(960, 8)).toBe(120); // team-lead 点名的反例
  });

  it('3/4 一小节（1440）+ 6 字符 → 240', () => {
    expect(slotTicks(1440, 6)).toBe(240);
  });

  it('slotTicks 边界：patternLen <= 0 → 0', () => {
    expect(slotTicks(960, 0)).toBe(0);
    expect(slotTicks(960, -2)).toBe(0);
  });
});

describe('QA §7.3 —— rake 计算', () => {
  it('rake = clamp(round(0.006 × bpm/60 × 480), 1, 12)；BPM 72 → 3', () => {
    expect(rakeTicks(72)).toBe(3);
    expect(rakeTicks(60)).toBe(3);
    expect(rakeTicks(20)).toBe(1); // 下限
    expect(rakeTicks(240)).toBe(12); // 上限
  });
});

describe('QA §7.3 —— (弦, 方向) 序列', () => {
  // C = x32010 → 发声弦 = {5,4,3,2,1}；lo=5(低音), hi=1(高音)
  it('C x32010 下扫 = [5,4,3,2,1]，弦号递减（低音→高音）', () => {
    expect(stringsForChar('D', 'x32010').strings).toEqual([5, 4, 3, 2, 1]);
  });

  it('C x32010 上扫 = sortedAsc(sounded ∩ {1,2,3}) = [1,2,3]，绝非下扫逆序 [1,2,3,4,5]', () => {
    const up = stringsForChar('U', 'x32010').strings;
    expect(up).toEqual([1, 2, 3]);
    // 关键守卫：如果是"下扫逆序"会得到 [1,2,3,4,5]（错）；必须是只到 3 弦的 [1,2,3]
    expect(up).not.toEqual([1, 2, 3, 4, 5]);
  });

  it('G 320003（6 弦全响）下扫 [6,5,4,3,2,1]，上扫仍是 [1,2,3]', () => {
    expect(stringsForChar('D', '320003').strings).toEqual([6, 5, 4, 3, 2, 1]);
    expect(stringsForChar('U', '320003').strings).toEqual([1, 2, 3]);
  });

  it('上扫交集为空 → 退化为 [hiString]（只有 4 弦的指位）', () => {
    expect(stringsForChar('U', 'xxxxx0').strings).toEqual([1]);
    expect(stringsForChar('U', '0xxxxx').strings).toEqual([6]);
  });

  it('闷音 x 同下扫弦序 + stroke=X + velocity 0.5', () => {
    const r = stringsForChar('x', 'x32010');
    expect(r.strings).toEqual([5, 4, 3, 2, 1]);
    expect(r.stroke).toBe('X');
    expect(r.velocity).toBe(0.5);
  });

  it('分解字符 1–6：取该弦；该弦闷音时替换为最低有声弦（lo）', () => {
    expect(stringsForChar('5', 'x32010').strings).toEqual([5]);
    // D 和弦 xx0232：5 弦为 x → 最低有声弦是 4
    expect(stringsForChar('5', 'xx0232').strings).toEqual([4]);
    expect(stringsForChar('6', 'xx0232').strings).toEqual([4]);
  });

  it('strum_eighth_alt DUDUDUDU 的发音 slot = 0..7（8 个全发）', () => {
    expect(activeSlots(PATTERN_BY_ID['strum_eighth_alt'].pattern)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('QA §7.3 —— expandPattern 集成（一小节 2 和弦 + 8 字符）', () => {
  it('一小节 2 和弦（C/G 各半小节）+ 8 字符 → 音符起点按 120 ticks 网格且都在小节内', () => {
    // 用 4/4 一小节 = 1920，两段各 960
    const notes = expandPattern({
      diagram: 'x32010',
      pattern: 'DUDUDUDU',
      segStartTick: 0,
      segTicks: 960,
      bpm: 72,
    });
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) {
      expect(n.startTick).toBeGreaterThanOrEqual(0);
      expect(n.startTick).toBeLessThan(960);
      expect(n.confidence).toBe(1);
    }
    // 8 个 slot 每个 slotTicks=120，且每 slot 5 音（rake 3 ticks 偏移）
    const slotStarts = new Set(notes.map((n) => n.startTick - (n.startTick % 120)));
    expect(slotStarts.size).toBe(8);
  });

  it('12 个模板的 pattern 均 ≤ 小节格数（8/6）且 activeSlots 落在范围内', () => {
    for (const p of RHYTHM_PATTERNS) {
      expect(p.pattern.length).toBeLessThanOrEqual(8);
      for (const s of activeSlots(p.pattern)) {
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThan(p.pattern.length);
      }
    }
  });
});
