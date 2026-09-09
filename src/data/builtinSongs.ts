/**
 * 内置 4 首原创示范曲的**紧凑规格**（PRD §8）。
 *
 * 合规红线：全部原创命名 + 原创和声进行，不含任何商业歌曲名/旋律。
 * 这里**不写完整 JSON** —— 首次启动由 core/tabFactory.buildTabFromChordChart 展开，
 * 与节奏引擎共用 expandPattern，内置曲同时充当节奏引擎的自检用例。
 */
import type { ChordChartEntry, ChordChartSpec } from '@/core/tabFactory';

/** 把和弦序列重复若干遍（每和弦 1 小节） */
function rep(chords: readonly string[], times: number, section: string): ChordChartEntry[] {
  const out: ChordChartEntry[] = [];
  for (let i = 0; i < times; i += 1) {
    for (const name of chords) out.push({ name, measures: 1, section });
  }
  return out;
}

/** 每个和弦持续 n 小节 */
function each(chords: readonly string[], measures: number, section = ''): ChordChartEntry[] {
  return chords.map((name) => ({ name, measures, section }));
}

/**
 * No.1《练习曲 No.1 · 晨光》
 * C 大调 / 72 BPM / 4/4 / 16 小节 / ★☆☆☆☆ / strum_quarter
 * 全开放和弦 + 每两小节一换，让新手把注意力放在"换和弦不断拍"上。
 */
export const SONG_MORNING: ChordChartSpec = {
  title: '练习曲 No.1 · 晨光',
  artist: '弦格 Fretly',
  key: 'C',
  bpm: 72,
  timeSignature: [4, 4],
  patternId: 'strum_quarter',
  tags: ['入门', '开放和弦', '慢速'],
  difficulty: 1,
  progression: each(['C', 'G', 'Am', 'Em', 'Fmaj7', 'C', 'Dm', 'G'], 2),
};

/**
 * No.2《练习曲 No.2 · 换和弦练习》
 * G 大调 / 84 BPM / 4/4 / 24 小节 / ★★☆☆☆ / strum_folk_basic
 * 每小节换一次和弦 + 6 strokes/小节的民谣扫弦。
 */
export const SONG_CHORD_CHANGES: ChordChartSpec = {
  title: '练习曲 No.2 · 换和弦练习',
  artist: '弦格 Fretly',
  key: 'G',
  bpm: 84,
  timeSignature: [4, 4],
  patternId: 'strum_folk_basic',
  tags: ['入门', '换和弦', '民谣扫弦'],
  difficulty: 2,
  progression: [
    ...rep(['G', 'Em', 'C', 'D'], 4, 'A'),
    ...each(['C', 'D', 'G', 'Em', 'C', 'D', 'G', 'G'], 1, 'B'),
  ],
};

/**
 * No.3《练习曲 No.3 · 分解和弦》
 * A 小调 / 76 BPM / 4/4 / 24 小节 / ★★★☆☆ / arp_5323
 * 分解和弦 + 首次引入 F 大横按（触发 §7.5「简易替代」降级演示）。
 */
export const SONG_ARPEGGIO: ChordChartSpec = {
  title: '练习曲 No.3 · 分解和弦',
  artist: '弦格 Fretly',
  key: 'Am',
  bpm: 76,
  timeSignature: [4, 4],
  patternId: 'arp_5323',
  tags: ['分解和弦', '横按', '指弹'],
  difficulty: 3,
  progression: [...rep(['Am', 'F', 'C', 'G'], 3, 'A'), ...rep(['Am', 'Dm', 'E7', 'Am'], 3, 'B')],
};

/**
 * No.4《练习曲 No.4 · 三拍子圆舞曲》
 * D 大调 / 96 BPM / 3/4 / 32 小节 / ★★★★☆ / strum_waltz_34
 * 3/4 拍 + 96 BPM 换和弦，全期最难；含 Bm 横按；同时验证渲染器对非 4/4 的支持。
 */
export const SONG_WALTZ: ChordChartSpec = {
  title: '练习曲 No.4 · 三拍子圆舞曲',
  artist: '弦格 Fretly',
  key: 'D',
  bpm: 96,
  timeSignature: [3, 4],
  patternId: 'strum_waltz_34',
  tags: ['三拍子', '横按', '进阶'],
  difficulty: 4,
  progression: each(['D', 'A', 'Bm', 'G', 'D', 'G', 'A', 'D'], 4),
};

export const BUILTIN_SONGS: readonly ChordChartSpec[] = [
  SONG_MORNING,
  SONG_CHORD_CHANGES,
  SONG_ARPEGGIO,
  SONG_WALTZ,
] as const;

/** 播种时的稳定 id 前缀（便于刷新不重复播种与自检定位） */
export const BUILTIN_SEED_KEY = 'fretly.seeded';
