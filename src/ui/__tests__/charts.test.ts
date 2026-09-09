import { describe, expect, it } from 'vitest';
import { chordStringColumn } from '@/ui/charts';
import { parseDiagram } from '@/core/fretboard';

describe('ui/charts —— 和弦图左右镜像', () => {
  it('chordStringColumn：i=0（1弦）→ 列5，i=5（6弦）→ 列0，单调递减', () => {
    expect(chordStringColumn(0)).toBe(5);
    expect(chordStringColumn(5)).toBe(0);
    for (let i = 0; i < 5; i += 1) {
      expect(chordStringColumn(i)).toBeGreaterThan(chordStringColumn(i + 1));
    }
  });

  it('渲染镜像与 parseDiagram 数据方向绑定：1弦落到最右列、6弦落到最左列', () => {
    const positions = parseDiagram('x32010');
    expect(positions[0].string).toBe(1);
    expect(positions[5].string).toBe(6);
    // positions[i] 渲染到 chordStringColumn(i) 列
    expect(chordStringColumn(0)).toBe(5); // 1弦（高音）→ 最右
    expect(chordStringColumn(5)).toBe(0); // 6弦（低音）→ 最左
  });
});
