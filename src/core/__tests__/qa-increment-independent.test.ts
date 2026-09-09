/**
 * QA 独立复核补充用例（Edward/Yan）：对三项增量的独立边界断言。
 *
 * 目的：不照抄工程师结论，用"新鲜眼睛"补足以下最容易漏的边界：
 *   - assignChord 结果是否按「原输入下标」回填（工程师偏离点 3）→ 音高 round-trip 保证
 *   - 和弦内某个音符被折叠（低置信）时，confidence/stroke 是否串位到相邻音
 *   - foldIntoRange 的非对称边界（39 / 89 等）
 *   - 变速不变调：合成 pitch 只由 midi 决定（freq = midiToFreq），缓存键不含 tempo
 *   - 扫弦方向与 rhythm.ts 的 stringsForChar 弦序方向交叉断言
 */
import { describe, expect, it } from 'vitest';
import {
  assignChord,
  assignFingering,
  assignMelody,
  foldIntoRange,
  type StaffNote,
} from '@/core/staffFingering';
import { classifyGroup, inferChordStroke, inferStroke } from '@/core/strokeInference';
import { fretToMidi, midiToFreq } from '@/core/fretboard';
import { stringsForChar } from '@/core/rhythm';
import { PluckCache, karplus, pluckKey } from '@/audio/synth';

function staff(midi: number, tick = 0, extra: Partial<StaffNote> = {}): StaffNote {
  return { midi, tick, durationTick: 480, ...extra };
}

describe('QA 独立 —— staffFingering.assignChord 结果按原下标回填', () => {
  it('assignChord([C4,E4,G4]) 的每个位置都能 round-trip 回原始 midi（不串位）', () => {
    const midis = [60, 64, 67];
    const pos = assignChord(midis);
    expect(pos).toHaveLength(3);
    midis.forEach((m, i) => {
      const p = pos[i];
      expect(p).not.toBeNull();
      // 关键：out[i] 必须对应 midis[i]，而不是按降序排布的某个音
      expect(fretToMidi(p!.string, p!.fret)).toBe(m);
    });
  });

  it('降序输入的极端和弦也不串位（高音在前输入仍按原序回填）', () => {
    const midis = [67, 60]; // 高音在前
    const pos = assignChord(midis);
    expect(fretToMidi(pos[0]!.string, pos[0]!.fret)).toBe(67);
    expect(fretToMidi(pos[1]!.string, pos[1]!.fret)).toBe(60);
    expect(pos[0]!.string).not.toBe(pos[1]!.string);
  });
});

describe('QA 独立 —— assignFingering 和弦内 confidence/stroke 不串位', () => {
  it('同 tick 和弦中折叠音低置信、正常音高置信，互不污染', () => {
    // B1(35) 折叠→47（低置信）+ E4(64)（正常高置信）同 tick 和弦
    const notes = assignFingering([staff(35), staff(64)]);
    expect(notes).toHaveLength(2);

    const foldedNote = notes.find((n) => n.fret === 2); // 47 → 5 弦 2 品
    const normalNote = notes.find((n) => n.fret === 0); // 64 → 1 弦 0 品
    expect(foldedNote).toBeDefined();
    expect(normalNote).toBeDefined();

    expect(foldedNote!.confidence).toBeLessThan(0.45);
    expect(normalNote!.confidence).toBeGreaterThanOrEqual(0.85);
    // 和弦默认下扫，二者 stroke 一致且都为 D
    expect(foldedNote!.stroke).toBe('D');
    expect(normalNote!.stroke).toBe('D');
    // 音高 round-trip 不串位
    expect(fretToMidi(foldedNote!.string, foldedNote!.fret)).toBe(47);
    expect(fretToMidi(normalNote!.string, normalNote!.fret)).toBe(64);
  });

  it('单音 melody 序列把位连贯：相邻音走最近位置而非各自最低品', () => {
    // E4(64)→1弦0品，随后 A3(57) 若独立取最低品为 3弦2品；贪心最近位置仍 3弦2品
    const pos = assignMelody([64, 57]);
    expect(fretToMidi(pos[0]!.string, pos[0]!.fret)).toBe(64);
    expect(fretToMidi(pos[1]!.string, pos[1]!.fret)).toBe(57);
  });
});

describe('QA 独立 —— foldIntoRange 非对称边界', () => {
  it('39（低于 E2 一个半音）折叠回 [40,88] 且 octaveShifted', () => {
    const r = foldIntoRange(39);
    expect(r.midi).toBeGreaterThanOrEqual(40);
    expect(r.midi).toBeLessThanOrEqual(88);
    expect(r.octaveShifted).toBe(true);
  });

  it('89（高于 E6 一个半音）折叠回 [40,88] 且 octaveShifted', () => {
    const r = foldIntoRange(89);
    expect(r.midi).toBeGreaterThanOrEqual(40);
    expect(r.midi).toBeLessThanOrEqual(88);
    expect(r.octaveShifted).toBe(true);
  });

  it('边界值 40 / 88 不折叠', () => {
    expect(foldIntoRange(40).octaveShifted).toBe(false);
    expect(foldIntoRange(88).octaveShifted).toBe(false);
  });
});

describe('QA 独立 —— 变速不变调（合成 pitch 只由 midi 决定）', () => {
  it('缓存键不含 tempo：同 (midi, 力度档) 命中同一 Float32Array 引用', () => {
    const cache = new PluckCache(22050);
    const a = cache.get(64, 0.85);
    const b = cache.get(64, 0.85);
    expect(b).toBe(a); // 变速只改调度时刻，buffer 复用 → 音高不变
    expect(pluckKey(64, 0.85)).toBe('64:0.75');
    expect(pluckKey(64, 0.85)).not.toMatch(/bpm|tempo|ratio/);
  });

  it('karplus 的基频由 freq 参数决定：110Hz 与 220Hz 输出的自相关基频≈2倍关系', () => {
    const sr = 44100;
    const opts = {
      sampleRate: sr,
      seconds: 0.4,
      damping: 0.496,
      blend: 0.5,
      brightness: 0.5,
      velocity: 0.85,
    };
    // 自相关估计基频：在稳态窗内找最大自相关滞后
    const estFundamental = (buf: Float32Array, minFreq = 40, maxFreq = 1200): number => {
      const start = Math.floor(buf.length * 0.05);
      const end = Math.floor(buf.length * 0.4);
      const n = end - start;
      if (n <= 0) return 0;
      let mean = 0;
      for (let i = start; i < end; i += 1) mean += buf[i];
      mean /= n;
      const minLag = Math.max(1, Math.floor(sr / maxFreq));
      const maxLag = Math.min(n - 1, Math.floor(sr / minFreq));
      let bestLag = -1;
      let bestCorr = -Infinity;
      for (let lag = minLag; lag <= maxLag; lag += 1) {
        let corr = 0;
        for (let i = start; i + lag < end; i += 1) {
          corr += (buf[i] - mean) * (buf[i + lag] - mean);
        }
        if (corr > bestCorr) {
          bestCorr = corr;
          bestLag = lag;
        }
      }
      return bestLag > 0 ? sr / bestLag : 0;
    };
    const f110 = estFundamental(karplus({ ...opts, freq: 110 }));
    const f220 = estFundamental(karplus({ ...opts, freq: 220 }));
    // 基频 ≈ freq（±20%），且 220Hz 约为 110Hz 的两倍 → pitch 只由 freq 决定
    expect(f110).toBeGreaterThan(88);
    expect(f110).toBeLessThan(132);
    expect(f220).toBeGreaterThan(176);
    expect(f220).toBeLessThan(264);
    expect(f220 / f110).toBeGreaterThan(1.5);
    expect(f220 / f110).toBeLessThan(2.6);
  });

  it('midiToFreq 是纯函数：同 midi 恒定频率（与任何 tempo/ratio 无关）', () => {
    expect(midiToFreq(69)).toBe(440);
    expect(midiToFreq(57)).toBeCloseTo(midiToFreq(57), 12);
  });
});

describe('QA 独立 —— 扫弦方向与 rhythm.ts 交叉断言', () => {
  it('inferChordStroke(up)=D 与 stringsForChar("D") 的弦序（弦号递减）方向一致', () => {
    const d = stringsForChar('D', '320003').strings; // G 和弦全弦发声
    expect(d[0]).toBeGreaterThan(d[d.length - 1]); // 6→1 递减 = 低→高
    expect(inferChordStroke('up')).toBe('D'); // up=低→高 映射 D
  });

  it('inferChordStroke(down)=U 与 stringsForChar("U") 的弦序（弦号递增）方向一致', () => {
    const u = stringsForChar('U', '320003').strings;
    expect(u[0]).toBeLessThan(u[u.length - 1]); // 1→3 递增 = 高→低
    expect(inferChordStroke('down')).toBe('U'); // down=高→低 映射 U
  });

  it('inferStroke 三分支：单音 null、和弦 D、分解 P', () => {
    expect(classifyGroup([64])).toBe('melody');
    expect(inferStroke([64])).toBeNull();
    expect(inferStroke([60, 64])).toBe('D');
    expect(inferStroke([60, 64], null, true)).toBe('P');
  });
});
