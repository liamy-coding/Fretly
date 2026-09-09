/**
 * 扫弦方向自动推断（增量设计 §1.4，T-04）。
 *
 * 方向约定与已交付的 `core/rhythm.ts` 及物理惯例严格一致：
 *   - `D`（下扫）= 低音弦 → 高音弦（弦号递减 6→1）= **低→高**
 *   - `U`（上扫）= 高音弦 → 低音弦（弦号递增 1→3）= **高→低**
 *
 * 纯函数层：不依赖 react / audio / storage / ui；不自写任何 `6 - x` 方向换算。
 */
import type { Stroke } from '@/types/tab';

/** 块状和弦（同 tick、无时间顺序）默认下扫 —— 单点可翻 */
export const DEFAULT_CHORD_STROKE: 'D' | 'U' = 'D';

/** 显式琶音方向：up = 低→高（下扫 D），down = 高→低（上扫 U） */
export type ChordDirection = 'up' | 'down';

/**
 * 同 tick 音符组分类。
 * 单音 → melody；多音 → chord。
 * 分解（arpeggio）由「不同 tick」判定，在调用侧（assignFingering）处理，
 * 此处保留返回类型以契约表达三类。
 */
export function classifyGroup(midis: number[]): 'melody' | 'arpeggio' | 'chord' {
  if (midis.length === 1) return 'melody';
  return 'chord';
}

/**
 * 和弦扫弦方向：低→高 = 'D'（下扫），高→低 = 'U'（上扫）。
 * direction 缺省（块状和弦，无时间顺序）→ 默认 'D'（DEFAULT_CHORD_STROKE）。
 * 与 `rhythm.ts` 的 stringsForChar('D') = [lo→hi]、stringsForChar('U') = [1→3]（高→低）一致。
 */
export function inferChordStroke(direction?: ChordDirection | null): 'D' | 'U' {
  return direction === 'down' ? 'U' : DEFAULT_CHORD_STROKE;
}

/**
 * 一组音符的 stroke（assignFingering 注入用）：
 *   - 分解（跨 tick 逐个拨弦，decomposed=true）→ 'P'
 *   - 单音（同 tick 仅 1 音）→ null
 *   - 和弦（同 tick ≥2 音）→ inferChordStroke(direction)
 */
export function inferStroke(
  midis: number[],
  direction?: ChordDirection | null,
  decomposed = false,
): Stroke {
  if (decomposed) return 'P';
  if (classifyGroup(midis) === 'melody') return null;
  return inferChordStroke(direction);
}
