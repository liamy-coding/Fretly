/**
 * 12 个节奏型模板（PRD §7.2）。
 *
 * pattern 字符按**等分**切一小节：slot 索引 = 字符位置（0 起）。
 *  扫弦类：D 下扫 / U 上扫 / x 闷音下扫 / - 空
 *  分解类：1–6 拨该弦（1 = 高音 E）/ - 空
 * slotTicks = round(和弦段 ticks / pattern.length)，因此模板自动适配任意拍号与和弦密度。
 */
import type { TimeSignature } from '@/types/tab';

export type PatternType = 'strum' | 'arp';

export interface RhythmPattern {
  id: string;
  name: string;
  type: PatternType;
  timeSignature: TimeSignature;
  pattern: string;
  slots: number;
  desc: string;
}

export const RHYTHM_PATTERNS: readonly RhythmPattern[] = [
  {
    id: 'strum_quarter',
    name: '四分全下扫',
    type: 'strum',
    timeSignature: [4, 4],
    pattern: 'D-D-D-D-',
    slots: 8,
    desc: '入门必备，一拍一扫，先把换和弦练顺',
  },
  {
    id: 'strum_folk_basic',
    name: '民谣基础',
    type: 'strum',
    timeSignature: [4, 4],
    pattern: 'D-DU-UDU',
    slots: 8,
    desc: '民谣万能型，下下上上下上',
  },
  {
    id: 'strum_eighth_alt',
    name: '八分交替',
    type: 'strum',
    timeSignature: [4, 4],
    pattern: 'DUDUDUDU',
    slots: 8,
    desc: '全八分交替，练右手稳定性',
  },
  {
    id: 'strum_offbeat',
    name: '反拍上扫',
    type: 'strum',
    timeSignature: [4, 4],
    pattern: '-U-U-U-U',
    slots: 8,
    desc: '只扫反拍，轻快切分的骨架',
  },
  {
    id: 'strum_slow_ballad',
    name: '抒情慢摇',
    type: 'strum',
    timeSignature: [4, 4],
    pattern: 'D--DUD-U',
    slots: 8,
    desc: '慢歌抒情，留白多、起伏柔',
  },
  {
    id: 'strum_cut',
    name: '切音扫弦',
    type: 'strum',
    timeSignature: [4, 4],
    pattern: 'D-xU-D-U',
    slots: 8,
    desc: '带闷音切分，律动感强',
  },
  {
    id: 'strum_waltz_34',
    name: '三拍圆舞曲',
    type: 'strum',
    timeSignature: [3, 4],
    pattern: 'D-DUDU',
    slots: 6,
    desc: '3/4 拍专用，强弱弱',
  },
  {
    id: 'arp_5323',
    name: '5323 分解',
    type: 'arp',
    timeSignature: [4, 4],
    pattern: '5-3-2-3-',
    slots: 8,
    desc: '最常用的民谣分解指序',
  },
  {
    id: 'arp_5321',
    name: '5321 分解',
    type: 'arp',
    timeSignature: [4, 4],
    pattern: '5-3-2-1-',
    slots: 8,
    desc: '收在高音弦，适合抒情结尾',
  },
  {
    id: 'arp_6323',
    name: '6323 分解',
    type: 'arp',
    timeSignature: [4, 4],
    pattern: '6-3-2-3-',
    slots: 8,
    desc: '低音更厚，适合独奏开头',
  },
  {
    id: 'arp_travis',
    name: 'Travis 基础',
    type: 'arp',
    timeSignature: [4, 4],
    pattern: '6-3-4-2-',
    slots: 8,
    desc: '指弹入门：交替低音 + 内声部',
  },
  {
    id: 'arp_waltz_34',
    name: '三拍分解',
    type: 'arp',
    timeSignature: [3, 4],
    pattern: '6-3-2-',
    slots: 6,
    desc: '3/4 拍的琶音骨架',
  },
] as const;

export const PATTERN_BY_ID: Readonly<Record<string, RhythmPattern>> = RHYTHM_PATTERNS.reduce<
  Record<string, RhythmPattern>
>((acc, p) => {
  acc[p.id] = p;
  return acc;
}, {});

export const STRUM_PATTERNS = RHYTHM_PATTERNS.filter((p) => p.type === 'strum');
export const ARP_PATTERNS = RHYTHM_PATTERNS.filter((p) => p.type === 'arp');
