/**
 * 内置和弦指位库（PRD §7.4 / §7.5）。
 * diagram 一律 **index 0 = 6 弦（低音）→ index 5 = 1 弦（高音）**。
 * G 的规范指法取 `320003`（PRD §7.4 说明）；导入器保留 `320033` 不改写。
 */
export interface ChordShape {
  name: string;
  diagram: string;
  barre: boolean;
  /** 根音所在弦（1 = 高音 E），仅用于指位图根音高亮；null 表示不标 */
  rootString: 1 | 2 | 3 | 4 | 5 | 6 | null;
}

export const CHORD_SHAPES: readonly ChordShape[] = [
  { name: 'C', diagram: 'x32010', barre: false, rootString: 5 },
  { name: 'Cmaj7', diagram: 'x32000', barre: false, rootString: 5 },
  { name: 'C7', diagram: 'x32310', barre: false, rootString: 5 },
  { name: 'Cadd9', diagram: 'x32030', barre: false, rootString: 5 },
  { name: 'G', diagram: '320003', barre: false, rootString: 6 },
  { name: 'G7', diagram: '320001', barre: false, rootString: 6 },
  { name: 'Gsus4', diagram: '330013', barre: false, rootString: 6 },
  { name: 'D', diagram: 'xx0232', barre: false, rootString: 3 },
  { name: 'Dm', diagram: 'xx0231', barre: false, rootString: 3 },
  { name: 'D7', diagram: 'xx0212', barre: false, rootString: 3 },
  { name: 'Dsus2', diagram: 'xx0230', barre: false, rootString: 3 },
  { name: 'A', diagram: 'x02220', barre: false, rootString: 5 },
  { name: 'Am', diagram: 'x02210', barre: false, rootString: 5 },
  { name: 'A7', diagram: 'x02020', barre: false, rootString: 5 },
  { name: 'E', diagram: '022100', barre: false, rootString: 6 },
  { name: 'Em', diagram: '022000', barre: false, rootString: 6 },
  { name: 'Em7', diagram: '020000', barre: false, rootString: 6 },
  { name: 'E7', diagram: '020100', barre: false, rootString: 6 },
  { name: 'F', diagram: '133211', barre: true, rootString: 6 },
  { name: 'Fmaj7', diagram: 'xx3210', barre: false, rootString: 4 },
  { name: 'F简易', diagram: 'xx3211', barre: false, rootString: 4 },
  { name: 'Bm', diagram: 'x24432', barre: true, rootString: 5 },
  { name: 'Bm7', diagram: 'x20202', barre: false, rootString: 5 },
  { name: 'Bb', diagram: 'x13331', barre: true, rootString: 5 },
  { name: 'F#m', diagram: '244222', barre: true, rootString: 6 },
  { name: 'F#m简易', diagram: 'xx4222', barre: false, rootString: 4 },
  { name: 'Am7', diagram: 'x02010', barre: false, rootString: 5 },
  { name: 'Dm7', diagram: 'xx0211', barre: false, rootString: 3 },
] as const;

export const CHORD_BY_NAME: Readonly<Record<string, ChordShape>> = CHORD_SHAPES.reduce<
  Record<string, ChordShape>
>((acc, shape) => {
  acc[shape.name] = shape;
  return acc;
}, {});

/** 横按降级表（PRD §7.5）：B-10「简易替代」按钮的数据源 */
export const DOWNGRADE_TABLE: Readonly<Record<string, { name: string; diagram: string }[]>> = {
  F: [
    { name: 'F简易', diagram: 'xx3211' },
    { name: 'Fmaj7', diagram: 'xx3210' },
  ],
  Bm: [{ name: 'Bm7', diagram: 'x20202' }],
  'F#m': [{ name: 'F#m简易', diagram: 'xx4222' }],
};

/** 12 个音级的索引（chroma 向量用） */
export const PITCH_CLASS_INDEX: Readonly<Record<string, number>> = {
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

export const PITCH_CLASS_NAMES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
] as const;

const MAJOR_TRIAD = [0, 4, 7];
const MINOR_TRIAD = [0, 3, 7];

function buildTemplate(root: number, intervals: readonly number[]): number[] {
  const v = new Array<number>(12).fill(0);
  for (const it of intervals) v[(root + it) % 12] = 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

/** 24 个和弦模板（12 大 + 12 小），已 L2 归一，供 chroma 余弦匹配 */
export const CHORD_TEMPLATES: readonly { name: string; chroma: number[] }[] = [
  ...PITCH_CLASS_NAMES.map((name, root) => ({
    name,
    chroma: buildTemplate(root, MAJOR_TRIAD),
  })),
  ...PITCH_CLASS_NAMES.map((name, root) => ({
    name: `${name}m`,
    chroma: buildTemplate(root, MINOR_TRIAD),
  })),
];

export const MAJOR_KEYS = [
  'C',
  'G',
  'D',
  'A',
  'E',
  'B',
  'F#',
  'Db',
  'Ab',
  'Eb',
  'Bb',
  'F',
] as const;

export const MINOR_KEYS = [
  'Am',
  'Em',
  'Bm',
  'F#m',
  'C#m',
  'G#m',
  'D#m',
  'A#m',
  'Fm',
  'Cm',
  'Gm',
  'Dm',
] as const;
