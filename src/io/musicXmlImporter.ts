/**
 * MusicXML 导入（PRD A-05 / Q4，架构 T-12；增量 §1.3 扩展五线谱回退）。
 *
 * 保真范围：
 *  - 优先取 **6 弦标准调（EADGBE）吉他轨**；忽略打击乐与非 6 弦轨
 *  - 无吉他轨时**回退**到第一个「有音高」的五线谱轨（有 <pitch>、无 string/fret、
 *    clef 非 TAB、非打击乐），经 staffFingering 分配指法 + 置信度
 *  - 反复记号不展开：Da Capo / Segno 线性展开并给出「反复记号已忽略」警告
 *  - 吉他轨同 tick 多音只保留品位最低的一个（Q4）；五线谱轨保留同 tick 多音（和弦）
 *  - `.mxl`（zip 压缩）不支持
 */
import type { ChordEvent, Measure, Note, StringNumber, TimeSignature } from '@/types/tab';
import type { ImportResult, TabImporter } from '@/types/app';
import { COPY, MAX_FRET, clamp, nowIso, round2, TICKS_PER_BEAT } from '@/core/constants';
import { newId } from '@/core/id';
import { lowestFretPosition } from '@/core/fretboard';
import { diagramOf } from '@/core/chords';
import { createEmptyTab } from '@/core/tabFactory';
import { measureTicks } from '@/core/tick';
import { assignFingering, type StaffNote } from '@/core/staffFingering';

const PITCH_CLASS: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

function text(node: ParentNode | null | undefined, selector: string): string {
  if (!node) return '';
  const found = node.querySelector(selector);
  return (found?.textContent ?? '').trim();
}

function all(node: ParentNode, selector: string): Element[] {
  return Array.from(node.querySelectorAll(selector));
}

function stepToMidi(step: string, alter: string, octave: string): number | null {
  const base = PITCH_CLASS[step.toUpperCase()];
  const oct = Number.parseInt(octave, 10);
  if (base === undefined || Number.isNaN(oct)) return null;
  const alt = Number.parseInt(alter || '0', 10);
  return (oct + 1) * 12 + base + (Number.isNaN(alt) ? 0 : alt);
}

/** MusicXML 和弦 kind → 后缀 */
function kindSuffix(kind: string): string {
  const k = (kind || '').toLowerCase();
  if (k === 'major' || k === '') return '';
  if (k === 'minor') return 'm';
  if (k === 'dominant' || k === 'dominant-seventh') return '7';
  if (k === 'major-seventh') return 'maj7';
  if (k === 'minor-seventh') return 'm7';
  if (k === 'suspended-fourth') return 'sus4';
  if (k === 'suspended-second') return 'sus2';
  return '';
}

function chordNameFrom(harmony: Element): string {
  const step = text(harmony, 'root-step');
  if (!step) return '';
  const alter = text(harmony, 'root-alter');
  const alt = Number.parseInt(alter || '0', 10);
  const accidental = Number.isNaN(alt) ? '' : alt === 1 ? '#' : alt === -1 ? 'b' : '';
  const kind = text(harmony, 'kind');
  return `${step.toUpperCase()}${accidental}${kindSuffix(kind)}`;
}

/** 判定一个 part 是否是 6 弦吉他轨 */
function isGuitarPart(part: Element, partName: string): boolean {
  if (part.querySelector('note > notations > technical > string')) return true;
  if (part.querySelector('note > notations > technical > fret')) return true;
  if (part.querySelector('clef > sign')?.textContent?.trim().toUpperCase() === 'TAB') return true;
  return /guitar|git\.|gtr/i.test(partName);
}

/** 判定打击乐轨（无音高：<unpitched> 或 percussion 乐器或名字） */
function isPercussionPart(part: Element, partName: string): boolean {
  if (part.querySelector('note > unpitched')) return true;
  if (part.querySelector('score-instrument > percussion, midi-instrument > percussion')) return true;
  return /percussion|drum|drums/i.test(partName);
}

interface SelectedPart {
  part: Element;
  isGuitar: boolean;
}

/** 选轨：吉他优先；否则回退到第一个「有音高」的五线谱轨（非 TAB、非打击乐） */
function selectImportPart(parts: Element[], nameById: Map<string, string>): SelectedPart | null {
  for (const part of parts) {
    const id = part.getAttribute('id') ?? '';
    if (isGuitarPart(part, nameById.get(id) ?? '')) return { part, isGuitar: true };
  }
  for (const part of parts) {
    const id = part.getAttribute('id') ?? '';
    const name = nameById.get(id) ?? '';
    if (isPercussionPart(part, name)) continue;
    if (part.querySelector('clef > sign')?.textContent?.trim().toUpperCase() === 'TAB') continue;
    if (part.querySelector('note > pitch')) return { part, isGuitar: false };
  }
  return null;
}

/** 读取显式琶音记号方向（MusicXML <arpeggiate direction="up|down">，缺省 up） */
function readArpeggiate(noteEl: Element): 'up' | 'down' | null {
  const arp = noteEl.querySelector('notations > arpeggiate');
  if (!arp) return null;
  const dir = arp.getAttribute('direction');
  if (dir === 'down') return 'down';
  return 'up';
}

function readTimeSignature(part: Element): TimeSignature {
  const beats = Number.parseInt(text(part, 'time > beats'), 10);
  const beatType = Number.parseInt(text(part, 'time > beat-type'), 10);
  if (beats === 3 && beatType === 4) return [3, 4];
  return [4, 4];
}

export interface MusicXmlParseResult {
  ok: boolean;
  reason?: string;
  warnings: string[];
  title: string;
  bpm: number;
  timeSignature: TimeSignature;
  measures: Measure[];
  /** 五线谱轨的平均置信度（仅曲库展示用；吉他轨为 null） */
  avgConfidence: number | null;
}

function emptyResult(reason?: string): MusicXmlParseResult {
  return {
    ok: false,
    reason,
    warnings: [],
    title: '',
    bpm: 90,
    timeSignature: [4, 4],
    measures: [],
    avgConfidence: null,
  };
}

function computeAvgConfidence(measures: Measure[]): number | null {
  let sum = 0;
  let count = 0;
  for (const m of measures) {
    for (const n of m.notes) {
      sum += n.confidence;
      count += 1;
    }
  }
  return count > 0 ? round2(sum / count) : null;
}

export function parseMusicXml(xml: string): MusicXmlParseResult {
  const warnings: string[] = [];
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) {
    return emptyResult('MusicXML 解析失败：文件不是合法 XML');
  }

  const partList = all(doc, 'part');
  if (partList.length === 0) {
    return emptyResult(COPY.noGuitarTrack);
  }

  // partId → 显示名
  const nameById = new Map<string, string>();
  for (const sp of all(doc, 'score-part')) {
    const id = sp.getAttribute('id') ?? '';
    nameById.set(id, text(sp, 'part-name'));
  }

  const selected = selectImportPart(partList, nameById);
  if (!selected) {
    return emptyResult(COPY.noGuitarTrack);
  }
  const part = selected.part;
  const isStaff = !selected.isGuitar;

  // 反复记号：不展开，只提示
  if (doc.querySelector('repeat[direction="backward"], dal-segno, dalsegno, da-capo, dacapo, segno, fine')) {
    warnings.push(COPY.repeatIgnored);
  }

  const timeSignature = readTimeSignature(part);
  const per = measureTicks(timeSignature);
  const title = text(doc, 'work-title') || text(doc, 'movement-title') || 'MusicXML 导入';

  // BPM：优先 <sound tempo="...">，其次 <metronome><per-minute>
  const soundTempo = Number.parseFloat(part.querySelector('sound[tempo]')?.getAttribute('tempo') ?? '');
  const perMinute = Number.parseFloat(text(part, 'metronome > per-minute'));
  const bpm = clamp(Math.round(Number.isFinite(soundTempo) ? soundTempo : perMinute || 90), 40, 240);

  const measures: Measure[] = [];
  let divisions = 1;

  for (const measureEl of all(part, 'measure')) {
    const divText = text(measureEl, 'divisions');
    if (divText) {
      const d = Number.parseInt(divText, 10);
      if (Number.isFinite(d) && d > 0) divisions = d;
    }

    const index = measures.length;
    let cursor = 0; // 本小节内的 divisions 游标
    let lastBaseTick = 0; // 上一个非 chord 音符的起点 tick（chord 附属音复用）
    const notes: Note[] = [];
    const byTick = new Map<number, Note>();
    const staffNotes: StaffNote[] = [];

    for (const noteEl of all(measureEl, 'note')) {
      const durationText = text(noteEl, 'duration');
      const duration = Number.parseInt(durationText, 10);
      const isChordTone = noteEl.querySelector('chord') !== null;
      const isRest = noteEl.querySelector('rest') !== null;
      // chord 附属音：起点与所属基础音相同，游标不前进；否则才前进
      const tick = isChordTone
        ? lastBaseTick
        : Math.max(0, Math.round((cursor / divisions) * TICKS_PER_BEAT));
      if (!isChordTone && !isRest && Number.isFinite(duration)) {
        cursor += duration;
        lastBaseTick = Math.max(0, Math.round((cursor - duration) / divisions * TICKS_PER_BEAT));
      }

      if (isRest) continue;

      const durationTick = clamp(
        Math.round(((Number.isFinite(duration) ? duration : divisions) / divisions) * TICKS_PER_BEAT),
        60,
        per,
      );

      if (isStaff) {
        // 五线谱轨：读 <pitch> → midi，保留同 tick 多音（和弦），读 <arpeggiate> 方向
        const midi = stepToMidi(
          text(noteEl, 'pitch > step'),
          text(noteEl, 'pitch > alter'),
          text(noteEl, 'pitch > octave'),
        );
        if (midi === null) continue;
        staffNotes.push({ midi, tick, durationTick, arpeggiate: readArpeggiate(noteEl) });
        continue;
      }

      // 吉他轨：读 string/fret，否则回退 pitch → 最低品位（Q4：同 tick 多音只留最低品位）
      const technical = noteEl.querySelector('notations > technical');
      const stringText = technical ? text(technical, 'string') : '';
      const fretText = technical ? text(technical, 'fret') : '';
      const stringNum = Number.parseInt(stringText, 10);
      const fretNum = Number.parseInt(fretText, 10);

      let string: StringNumber | null = null;
      let fret = 0;

      if (Number.isFinite(stringNum) && stringNum >= 1 && stringNum <= 6 && Number.isFinite(fretNum)) {
        string = stringNum as StringNumber;
        fret = clamp(fretNum, 0, MAX_FRET);
      } else {
        const midi = stepToMidi(
          text(noteEl, 'pitch > step'),
          text(noteEl, 'pitch > alter'),
          text(noteEl, 'pitch > octave'),
        );
        if (midi === null) continue;
        const position = lowestFretPosition(midi);
        if (!position) continue;
        string = position.string;
        fret = clamp(position.fret, 0, MAX_FRET);
      }

      const candidate: Note = {
        id: newId('n'),
        string,
        fret,
        startTick: tick,
        durationTick,
        velocity: 0.75,
        techniques: [],
        confidence: 1,
        finger: null,
        stroke: 'P',
      };

      // 同 tick 多音：只保留品位最低的一个（Q4）
      const existing = byTick.get(tick);
      if (!existing) {
        byTick.set(tick, candidate);
        notes.push(candidate);
      } else if (candidate.fret < existing.fret) {
        byTick.set(tick, candidate);
        const at = notes.indexOf(existing);
        if (at >= 0) notes[at] = candidate;
      }
    }

    if (isStaff) {
      notes.push(...assignFingering(staffNotes));
    }

    const chords: ChordEvent[] = [];
    for (const harmony of all(measureEl, 'harmony')) {
      const name = chordNameFrom(harmony);
      if (!name) continue;
      const offset = Number.parseInt(text(harmony, 'offset'), 10);
      const tick = Number.isFinite(offset)
        ? Math.round((offset / divisions) * TICKS_PER_BEAT)
        : 0;
      chords.push({
        tick: clamp(tick, 0, Math.max(0, per - 1)),
        name,
        diagram: diagramOf(name),
        confidence: 1,
      });
    }

    measures.push({
      index,
      startTick: index * per,
      ticks: per,
      chords,
      notes: notes.sort((a, b) => a.startTick - b.startTick || a.string - b.string),
      sectionLabel: '',
    });
  }

  return {
    ok: true,
    warnings,
    title,
    bpm,
    timeSignature,
    measures,
    avgConfidence: isStaff ? computeAvgConfidence(measures) : null,
  };
}

export function musicXmlToTab(xml: string): ImportResult {
  const parsed = parseMusicXml(xml);
  if (!parsed.ok || parsed.measures.length === 0) {
    return {
      ok: false,
      partial: false,
      parsedMeasures: 0,
      reason: parsed.reason ?? COPY.noGuitarTrack,
      warnings: parsed.warnings,
    };
  }

  const tab = createEmptyTab({
    title: parsed.title,
    artist: '未知',
    bpm: parsed.bpm,
    timeSignature: parsed.timeSignature,
    source: {
      type: 'imported',
      jobId: null,
      importer: 'musicxml',
      confidence: parsed.avgConfidence,
      engine: null,
    },
  });
  tab.tracks[0].measures = parsed.measures;
  tab.updatedAt = nowIso();

  return {
    ok: true,
    tab,
    partial: false,
    parsedMeasures: parsed.measures.length,
    warnings: parsed.warnings,
  };
}

export const musicXmlImporter: TabImporter = {
  id: 'musicxml',
  label: 'MusicXML',
  accept: ['.xml', '.musicxml'],
  fromText: false,
  async parse(input) {
    const text = typeof input === 'string' ? input : await input.text();
    return musicXmlToTab(text);
  },
};
