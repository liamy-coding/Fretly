/**
 * 和弦查询与 chroma 匹配（PRD §7.4 / §7.5，架构 T-04）。
 * 纯函数：不碰 DOM / AudioContext / 存储，可独立单测。
 */
import type { StringNumber } from '@/types/tab';
import { diagramIndexOf, fretAt, soundedStrings } from '@/core/fretboard';
import {
  CHORD_BY_NAME,
  CHORD_SHAPES,
  CHORD_TEMPLATES,
  DOWNGRADE_TABLE,
  PITCH_CLASS_INDEX,
  type ChordShape,
} from '@/data/chords';

export type { ChordShape };

export function lookupChord(name: string): ChordShape | undefined {
  return CHORD_BY_NAME[name];
}

export function hasChord(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(CHORD_BY_NAME, name);
}

export function isBarre(name: string): boolean {
  return CHORD_BY_NAME[name]?.barre === true;
}

/** 和弦名 → 指位串；未收录时返回 'xxxxxx'（UI 渲染 '?'） */
export function diagramOf(name: string): string {
  return CHORD_BY_NAME[name]?.diagram ?? 'xxxxxx';
}

/** 简易替代指法列表（B-10 数据源） */
export function getSimpler(name: string): { name: string; diagram: string }[] {
  return DOWNGRADE_TABLE[name] ?? [];
}

export function canDowngrade(name: string): boolean {
  return getSimpler(name).length > 0;
}

/** 指位串 → 每弦品位数组，index 0 = 6 弦；-1 表示不弹 */
export function parseDiagram(diagram: string): number[] {
  const out: number[] = [];
  for (let string = 6; string >= 1; string -= 1) {
    out.push(fretAt(diagram, string as StringNumber));
  }
  return out;
}

/** 指位串 → 发声弦（升序） */
export function diagramStrings(diagram: string): StringNumber[] {
  return soundedStrings(diagram);
}

/** 指位串 → [{ string, fret }]，只含发声弦，按弦号升序 */
export function diagramPositions(diagram: string): { string: StringNumber; fret: number }[] {
  return soundedStrings(diagram)
    .map((string) => ({ string, fret: fretAt(diagram, string) }))
    .filter((p) => p.fret >= 0);
}

/** 校验指位串：6 位，每位为 x/X 或 0-9 */
export function isValidDiagram(diagram: string): boolean {
  return /^[xX0-9]{6}$/.test(diagram);
}

/** 指位串是否含横按（跨 >=2 弦且品位相同的最大 fret > 0，且最低音弦也按在同一品） */
export function detectBarreFromDiagram(diagram: string): boolean {
  const frets = parseDiagram(diagram);
  const positive = frets.filter((f) => f > 0);
  if (positive.length < 3) return false;
  const min = Math.min(...positive);
  return min > 0 && frets.filter((f) => f === min).length >= 2;
}

// ── chroma ────────────────────────────────────────────────────────
function intervalsOfQuality(q: string): number[] {
  if (q.startsWith('maj7')) return [0, 4, 7, 11];
  if (q.startsWith('m7')) return [0, 3, 7, 10];
  if (q.startsWith('m')) return [0, 3, 7];
  if (q.startsWith('sus4')) return [0, 5, 7];
  if (q.startsWith('sus2')) return [0, 2, 7];
  if (q.startsWith('add9')) return [0, 4, 7, 14];
  if (q.startsWith('dim')) return [0, 3, 6];
  if (q.includes('7')) return [0, 4, 7, 10];
  return [0, 4, 7];
}

/** 和弦名 → 12 维 chroma（L2 归一）。未知名返回零向量 */
export function chromaVectorOf(name: string): number[] {
  const v = new Array<number>(12).fill(0);
  const m = /^([A-G][#b]?)(.*)$/.exec(name.trim());
  if (!m) return v;
  const root = PITCH_CLASS_INDEX[m[1]];
  if (root === undefined) return v;
  const quality = m[2].replace('简易', '');
  for (const it of intervalsOfQuality(quality)) v[(root + it) % 12] = 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm > 0 ? v.map((x) => x / norm) : v;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

export interface ChordCandidate {
  name: string;
  score: number;
  diagram: string;
  barre: boolean;
}

/**
 * 按 chroma 余弦相似度给出候选和弦（D-03 的 Top8 弹窗数据源）。
 * 同分时按和弦库顺序稳定排序，保证 UI 不抖动。
 */
export function rankCandidates(
  chromaVec: readonly number[],
  topN: number = 8,
  exclude: readonly string[] = [],
): ChordCandidate[] {
  const excluded = new Set(exclude);
  const scored = CHORD_TEMPLATES.filter((t) => !excluded.has(t.name)).map((t) => ({
    name: t.name,
    score: Math.round(cosine(chromaVec, t.chroma) * 1000) / 1000,
    diagram: diagramOf(t.name),
    barre: isBarre(t.name),
  }));
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, Math.max(0, topN));
}

/** 和弦库里所有已知和弦名 */
export function allChordNames(): string[] {
  return CHORD_SHAPES.map((c) => c.name);
}

/** 把 (弦, 品) 换成同一 MIDI 的其它候选位置（D-13 tooltip Top3） */
export { diagramIndexOf };
