/**
 * ★ 节奏引擎（PRD §7.1–§7.3，架构 T-05）。
 *
 * 输入「和弦指位 + 模板字符 + 和弦段 tick 区间 + BPM」，输出 Note[]。
 * 这里是全项目**唯一**生成 (弦, 方向, 力度, 时值) 的地方：
 * tabFactory 生成内置曲、编辑器「应用模板生成谱面」都复用 expandPattern，
 * 保证两条路径产出的音符完全一致。
 *
 * 上扫弦序列 = sortedAsc(sounded ∩ {1,2,3})（只到 3 弦），**不是**下扫序列的逆序。
 */
import type { Note, StringNumber, Technique } from '@/types/tab';
import { RAKE_MS_PER_BPM, TICKS_PER_BEAT, clamp } from '@/core/constants';
import { fretAt, highestSoundingString, lowestSoundingString, soundedStrings } from '@/core/fretboard';
import { newId } from '@/core/id';
import { PATTERN_BY_ID, type RhythmPattern } from '@/data/rhythmPatterns';

export type SlotChar = 'D' | 'U' | 'x' | '-' | '1' | '2' | '3' | '4' | '5' | '6';

/** 一小节内的 slot 时长：round(和弦段 ticks / pattern 长度) */
export function slotTicks(segTicks: number, patternLen: number): number {
  if (patternLen <= 0) return 0;
  return Math.max(1, Math.round(segTicks / patternLen));
}

/**
 * 扫弦弦间延迟（rake）：clamp(round(0.006 × bpm / 60 × 480), 1, 12)
 * 例：BPM 72 → round(0.006 × 1.2 × 480) = round(3.456) = 3 ticks（≈6ms）
 */
export function rakeTicks(bpm: number): number {
  return clamp(Math.round(RAKE_MS_PER_BPM * (bpm / 60) * TICKS_PER_BEAT), 1, 12);
}

/** 一个 slot 是否发声 */
export function isSoundingChar(c: string): boolean {
  return c !== '-' && c !== ' ';
}

/** 模板里所有发声 slot 的下标（升序） */
export function activeSlots(pattern: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < pattern.length; i += 1) {
    if (isSoundingChar(pattern.charAt(i))) out.push(i);
  }
  return out;
}

/**
 * Step 3：按字符生成弦序列。
 *  - D / x：低音弦 → 高音弦（弦号递减），只取发声弦
 *  - U：sortedAsc(sounded ∩ {1,2,3})；交集为空时退化为 [hiString]
 *  - 1–6：该弦；若该弦在 diagram 中为 x，替换为最低有声弦
 */
export function stringsForChar(
  char: string,
  diagram: string,
): { strings: StringNumber[]; stroke: Note['stroke']; velocity: number; techniques: Technique[] } {
  const sounded = soundedStrings(diagram);
  const lo = lowestSoundingString(diagram);
  const hi = highestSoundingString(diagram);
  const soundedSet = new Set<number>(sounded);

  if (char === 'D' || char === 'x') {
    const seq: StringNumber[] = [];
    for (let s = lo; s >= hi; s -= 1) {
      if (soundedSet.has(s)) seq.push(s as StringNumber);
    }
    return char === 'D'
      ? { strings: seq, stroke: 'D', velocity: 0.85, techniques: [] }
      : { strings: seq, stroke: 'X', velocity: 0.5, techniques: ['x'] };
  }

  if (char === 'U') {
    const up = sounded.filter((s) => s <= 3).sort((a, b) => a - b);
    return { strings: up.length > 0 ? up : [hi], stroke: 'U', velocity: 0.65, techniques: [] };
  }

  if (char >= '1' && char <= '6') {
    const target = Number.parseInt(char, 10) as StringNumber;
    const usable = fretAt(diagram, target) >= 0;
    return { strings: [usable ? target : lo], stroke: 'P', velocity: 0.75, techniques: [] };
  }

  return { strings: [], stroke: null, velocity: 0, techniques: [] };
}

export interface ExpandSegmentInput {
  /** 和弦指位串（index0 = 6 弦） */
  diagram: string;
  /** 模板 pattern 字符串 */
  pattern: string;
  /** 和弦段起点 tick（相对小节起始） */
  segStartTick: number;
  /** 和弦段长度（tick） */
  segTicks: number;
  bpm: number;
}

/**
 * 把一个节奏型铺到「一个和弦段」上，产出该段的全部音符。
 * startTick 相对**小节起始**（= segStartTick + slotOffset），与 Tab 数据约定一致。
 */
export function expandPattern(input: ExpandSegmentInput): Note[] {
  const { diagram, pattern, segStartTick, segTicks, bpm } = input;
  const notes: Note[] = [];
  if (!pattern || segTicks <= 0) return notes;

  const sounded = soundedStrings(diagram);
  if (sounded.length === 0) {
    // k = 0 的保护：和弦全为 x（数据异常），跳过并警告，不产出音符
    console.warn(`[fretly:rhythm] 和弦指位 ${diagram} 没有发声弦，跳过该段`);
    return notes;
  }

  const st = slotTicks(segTicks, pattern.length);
  const baseRake = rakeTicks(bpm);
  const slots = activeSlots(pattern);

  for (let ai = 0; ai < slots.length; ai += 1) {
    const slot = slots[ai];
    const char = pattern.charAt(slot);
    const { strings, stroke, velocity, techniques } = stringsForChar(char, diagram);
    const k = strings.length;
    if (k === 0) {
      console.warn(`[fretly:rhythm] slot ${slot} 字符 '${char}' 未生成任何音符，已跳过`);
      continue;
    }

    const slotStart = segStartTick + slot * st;
    // noteDur：到下一个发声 slot 的 tick 差；最后一个发声 slot 延伸到和弦段末尾
    const noteDur =
      ai + 1 < slots.length ? (slots[ai + 1] - slot) * st : Math.max(1, segTicks - slot * st);

    // 边界：noteDur 不够铺开 rake → 压缩 rake，保证最后一个音至少 1 tick
    let rake = baseRake;
    if (noteDur - (k - 1) * rake <= 0) {
      rake = Math.max(1, Math.floor(noteDur / k));
    }

    for (let i = 0; i < k; i += 1) {
      const string = strings[i];
      let durationTick = i < k - 1 ? rake : Math.max(1, noteDur - (k - 1) * rake);
      if (char === 'x') durationTick = Math.min(durationTick, 120);
      const fret = Math.max(0, fretAt(diagram, string));

      notes.push({
        id: newId('n'),
        string,
        fret,
        startTick: slotStart + i * rake,
        durationTick,
        velocity,
        techniques: [...techniques],
        // 模板生成的音符视为确定，不进待确认清单（PRD §7.3 Step 4）
        confidence: 1,
        finger: null,
        stroke,
      });
    }
  }

  return notes.sort((a, b) => a.startTick - b.startTick || a.string - b.string);
}

/** 便捷：直接按 patternId 展开一个和弦段 */
export function expandPatternById(
  patternId: string,
  input: Omit<ExpandSegmentInput, 'pattern'>,
): Note[] {
  const p = getPattern(patternId);
  if (!p) return [];
  return expandPattern({ ...input, pattern: p.pattern });
}

export function getPattern(id: string | null | undefined): RhythmPattern | undefined {
  if (!id) return undefined;
  return PATTERN_BY_ID[id];
}

/** 试听用的模板发音 slot 序列（编辑器节奏条图形化与试听共用） */
export function patternSlotSummary(
  pattern: string,
): { slot: number; char: string; kind: 'D' | 'U' | 'X' | 'P' }[] {
  return activeSlots(pattern).map((slot) => {
    const char = pattern.charAt(slot);
    const kind: 'D' | 'U' | 'X' | 'P' =
      char === 'D' ? 'D' : char === 'U' ? 'U' : char === 'x' ? 'X' : 'P';
    return { slot, char, kind };
  });
}
