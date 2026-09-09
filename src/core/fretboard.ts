/**
 * ★ 指板与和弦图方向转换的**唯一**出口（架构 §9.3，R6）。
 *
 * 两条相反的约定在这里被关进笼子：
 *   note.string ：1 = 高音 E（最细）… 6 = 低音 E（最粗）
 *   chord.diagram：index 0 = 6 弦（低音）… index 5 = 1 弦（高音）
 *
 * 全项目除本文件外，禁止出现 `6 - x` 形式的索引换算，
 * 也禁止 `diagram[...]` 直接下标；一律用 diagramIndexOf / stringOf / fretAt / soundedStrings。
 * 架构守卫测试（src/core/__tests__/archGuard.test.ts）会扫描源码强制这条规则。
 */
import type { DiagramIndex, Midi, StringNumber } from '@/types/tab';
import { MAX_FRET } from '@/core/constants';

/** 标准调弦的空弦 MIDI：1 弦 E4=64 … 6 弦 E2=40 */
export const OPEN_MIDI: Record<StringNumber, Midi> = {
  1: 64,
  2: 59,
  3: 55,
  4: 50,
  5: 45,
  6: 40,
};

/** 标准调弦音名，index 0 = 6 弦（与 diagram 同向） */
export const STANDARD_TUNING = ['E', 'A', 'D', 'G', 'B', 'E'] as const;

export const STRING_NUMBERS: readonly StringNumber[] = [1, 2, 3, 4, 5, 6] as const;

export function isStringNumber(n: number): n is StringNumber {
  return n === 1 || n === 2 || n === 3 || n === 4 || n === 5 || n === 6;
}

/** 弦号 → diagram 下标（1 弦 → 5，6 弦 → 0） */
export function diagramIndexOf(string: StringNumber): DiagramIndex {
  return (6 - string) as DiagramIndex;
}

/** diagram 下标 → 弦号（0 → 6 弦，5 → 1 弦） */
export function stringOf(index: DiagramIndex): StringNumber {
  return (6 - index) as StringNumber;
}

/** 取某弦在指位串里的品位；'x'（不弹）或非法字符返回 -1 */
export function fretAt(diagram: string, string: StringNumber): number {
  if (!diagram) return -1;
  const ch = diagram.charAt(diagramIndexOf(string));
  if (ch === 'x' || ch === 'X') return -1;
  const fret = Number.parseInt(ch, 10);
  return Number.isNaN(fret) ? -1 : fret;
}

/** 该指位串里所有发声弦，**升序**返回（1 弦在前） */
export function soundedStrings(diagram: string): StringNumber[] {
  const out: StringNumber[] = [];
  if (!diagram) return out;
  for (let i = 0; i < 6; i += 1) {
    const ch = diagram.charAt(i);
    if (ch !== 'x' && ch !== 'X') out.push(stringOf(i as DiagramIndex));
  }
  return out.sort((a, b) => a - b);
}

/** 最低音弦（弦号最大） */
export function lowestSoundingString(diagram: string): StringNumber {
  const s = soundedStrings(diagram);
  return s.length > 0 ? s[s.length - 1] : 6;
}

/** 最高音弦（弦号最小） */
export function highestSoundingString(diagram: string): StringNumber {
  const s = soundedStrings(diagram);
  return s.length > 0 ? s[0] : 1;
}

/** 指位串 → [{ string, fret }]（按弦号升序），fret = -1 表示不弹 */
export function parseDiagram(diagram: string): { string: StringNumber; fret: number }[] {
  return STRING_NUMBERS.map((string) => ({ string, fret: fretAt(diagram, string) }));
}

// ── 音高 ──────────────────────────────────────────────────────────
const NOTE_INDEX: Record<string, number> = {
  C: 0,
  'C#': 1,
  Db: 1,
  D: 2,
  'D#': 3,
  Eb: 3,
  E: 4,
  F: 5,
  'F#': 6,
  Gb: 6,
  G: 7,
  'G#': 8,
  Ab: 8,
  A: 9,
  'A#': 10,
  Bb: 10,
  B: 11,
};

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function noteNameToMidi(name: string): Midi {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name.trim());
  if (!m) return 60;
  const key = `${m[1]}${m[2]}`;
  const idx = NOTE_INDEX[key] ?? 0;
  const octave = Number.parseInt(m[3], 10);
  return (octave + 1) * 12 + idx;
}

export function midiToNoteName(midi: Midi): string {
  const idx = ((Math.round(midi) % 12) + 12) % 12;
  const octave = Math.floor(Math.round(midi) / 12) - 1;
  return `${NOTE_NAMES[idx]}${octave}`;
}

export function midiToFreq(midi: Midi): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** (弦, 品) → MIDI。非标准调弦时传 openMidi 覆盖 */
export function fretToMidi(
  string: StringNumber,
  fret: number,
  openMidi: Record<StringNumber, Midi> = OPEN_MIDI,
): Midi {
  return openMidi[string] + Math.max(0, fret);
}

/** 一个 MIDI 音在指板上的所有可弹位置（品 0–maxFret），按"低把位优先"排序 */
export function allPositions(
  midi: Midi,
  maxFret: number = MAX_FRET,
  openMidi: Record<StringNumber, Midi> = OPEN_MIDI,
): { string: StringNumber; fret: number }[] {
  const out: { string: StringNumber; fret: number }[] = [];
  for (const string of STRING_NUMBERS) {
    const fret = midi - openMidi[string];
    if (fret >= 0 && fret <= maxFret) out.push({ string, fret });
  }
  return out.sort((a, b) => a.fret - b.fret || b.string - a.string);
}

/** 把任意 MIDI 落到指板上：优先品位最低的合法位置（MusicXML 多声部取最低品位用） */
export function lowestFretPosition(
  midi: Midi,
  maxFret: number = MAX_FRET,
  openMidi: Record<StringNumber, Midi> = OPEN_MIDI,
): { string: StringNumber; fret: number } | null {
  const positions = allPositions(midi, maxFret, openMidi);
  return positions.length > 0 ? positions[0] : null;
}
