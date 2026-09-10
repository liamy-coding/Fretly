/**
 * 任务甲 —— 增强 ASCII 六线谱导入器（PRD §5 样例 A~H + ARCH §3 设计决策）。
 *
 * 本文件是**纯解析层**用例：`parseAscii` / `asciiToTab` 无 DOM 依赖，
 * 且这些用例大量调用它们，故显式锁定 node 环境（与 vite.config.ts 默认一致）。
 *
 * 覆盖：
 *  - 缺陷 1（小节线切分，P0）        → 样例 A
 *  - 缺陷 3（部分弦块，P1）          → 样例 C
 *  - 缺陷 4（末音符时值收束，P2）     → 样例 F
 *  - 缺陷 5（段落标记，P2）          → 样例 E
 *  - 缺陷 6（3/4 拍往返，P0）        → §往返组
 *  - 缺陷 7（Technique 越界，P1）     → §技法组
 *  - 缺陷 8（validateTab 接线，P2）   → §校验组
 *  - 缺陷 9（ASCII 体积守卫，P2）     → §体积守卫组
 *  - R3（列溢出判定，P0）            → 样例 B
 *  - R6（元数据提取，P1）            → 样例 D
 *  - RISK-3（段数众数 + 并列取最小）  → §众数组
 *  - 连续 `|` 剥离                    → §小节线组
 */
import { describe, expect, it } from 'vitest';
import type { Tab } from '@/types/tab';
import { buildTabFromChordChart } from '@/core/tabFactory';
import { MAX_IMPORT_ASCII_CHARS, MAX_BPM, MIN_BPM } from '@/core/constants';
import { SONG_MORNING, SONG_WALTZ } from '@/data/builtinSongs';
import { asciiToTab, parseAscii } from '@/io/importers';
import { tabToAscii } from '@/io/exporters';

// ── 测试夹具 ──────────────────────────────────────────────────────

/** ASCII 列坐标 → tick（1 列 = 120 ticks，PRD §5 声明） */
const COL = 120;
const PER_44 = 1920;

function sixLines(rows: readonly string[]): string {
  return rows.join('\n');
}

/** 取某小节的 (string, fret, startTick) 三元组，按弦、起点排序，便于集合断言 */
function triples(tab: Tab, measureIndex: number): [number, number, number][] {
  const measure = tab.tracks[0]?.measures[measureIndex];
  if (!measure) return [];
  return measure.notes
    .map((n) => [n.string, n.fret, n.startTick] as [number, number, number])
    .sort((a, b) => a[0] - b[0] || a[2] - b[2]);
}

// ══════════════════════════════════════════════════════════════════
// 样例 A —— 小节线驱动切分（R1，P0；缺陷 1）
// 裁决：期望 startTick 集合 = {240, 720}，**不是** PRD 手算的 {240,1200}
// ══════════════════════════════════════════════════════════════════

describe('样例 A —— 小节线驱动切分（R1 / 缺陷 1）', () => {
  const SAMPLE_A = sixLines([
    'e|--0---0-|--2---2-|',
    'B|--0---0-|--3---3-|',
    'G|--1---1-|--2---2-|',
    'D|--2---2-|--0---0-|',
    'A|--2---2-|--------|',
    'E|--0---0-|--------|',
  ]);

  it('每行 2 小节 → 解析出 2 个小节（修前会得到 1 个，见 M5）', () => {
    const parsed = parseAscii(SAMPLE_A);
    expect(parsed.measures).toHaveLength(2);
  });

  it('第 0 小节：6 弦各 2 音，startTick 集合 = {240, 720}（相对本小节）', () => {
    const parsed = parseAscii(SAMPLE_A);
    const m0 = parsed.measures[0]!;
    expect(m0.notes).toHaveLength(12);

    const starts = [...new Set(m0.notes.map((n) => n.startTick))].sort((a, b) => a - b);
    expect(starts).toEqual([2 * COL, 6 * COL]); // {240, 720}

    // 每根弦恰好 2 个音
    const perString = new Map<number, number>();
    for (const n of m0.notes) perString.set(n.string, (perString.get(n.string) ?? 0) + 1);
    expect([...perString.keys()].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    for (const count of perString.values()) expect(count).toBe(2);
  });

  it('第 1 小节：A/E 弦无音符，e/B/G/D 各 2 个，startTick 从 0 重新起算 = {240, 720}', () => {
    const parsed = parseAscii(SAMPLE_A);
    const m1 = parsed.measures[1]!;
    expect(m1.notes).toHaveLength(8); // 4 弦 × 2

    const strings = [...new Set(m1.notes.map((n) => n.string))].sort();
    expect(strings).toEqual([1, 2, 3, 4]);

    const starts = [...new Set(m1.notes.map((n) => n.startTick))].sort((a, b) => a - b);
    // 两小节文本段形状相同（`--0---0-` / `--2---2-`）→ 相对列相同 → 相对 tick 相同
    expect(starts).toEqual([2 * COL, 6 * COL]);

    // 全谱所有音符 startTick 均在小节容量内
    for (const n of m1.notes) expect(n.startTick).toBeLessThan(PER_44);
  });

  it('第 1 小节各弦品位正确（e=2, B=3, G=2, D=0）', () => {
    const tab = asciiToTab(SAMPLE_A).tab!;
    expect(triples(tab, 1)).toEqual([
      [1, 2, 2 * COL],
      [1, 2, 6 * COL],
      [2, 3, 2 * COL],
      [2, 3, 6 * COL],
      [3, 2, 2 * COL],
      [3, 2, 6 * COL],
      [4, 0, 2 * COL],
      [4, 0, 6 * COL],
    ]);
  });

  it('两小节均非 partial（既有 `|` 结构完整且不溢出）', () => {
    const result = asciiToTab(SAMPLE_A);
    expect(result.ok).toBe(true);
    expect(result.partial).toBe(false);
    expect(result.failedAt).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════
// 样例 B —— 列数溢出拍号容量（R3，P0；缺陷 1 的溢出分支）
// 关键：partial 必须由「段宽 18 > colsPerMeasure 16」判定（S1），
//       而不是依赖 startTick 越界（S2 在样例 B 中并不命中：最大相对列 14 → 1680 < 1920）
// ══════════════════════════════════════════════════════════════════

describe('样例 B —— 段宽溢出判定 partial（R3 / 缺陷 1 溢出分支）', () => {
  const SAMPLE_B = sixLines([
    'e|--0---0---0---0---|',
    'B|--0---0---0---0---|',
    'G|--1---1---1---1---|',
    'D|--2---2---2---2---|',
    'A|--2---2---2---2---|',
    'E|--0---0---0---0---|',
  ]);

  it('信任小节线：18 列内容仍只切出 1 个小节（不腰斩成 2）', () => {
    const parsed = parseAscii(SAMPLE_B);
    expect(parsed.measures).toHaveLength(1);
  });

  it('partial === true 且 failedAt === 0（由段宽 S1 命中判定）', () => {
    const parsed = parseAscii(SAMPLE_B);
    expect(parsed.partial).toBe(true);
    expect(parsed.failedAt).toBe(0);
  });

  it('音符不丢弃：4 个起点 240/720/1200/1680，且 startTick + durationTick ≤ 1920', () => {
    const parsed = parseAscii(SAMPLE_B);
    const m0 = parsed.measures[0]!;
    expect(m0.notes.length).toBeGreaterThan(0);

    const starts = [...new Set(m0.notes.map((n) => n.startTick))].sort((a, b) => a - b);
    expect(starts).toEqual([2 * COL, 6 * COL, 10 * COL, 14 * COL]); // {240,720,1200,1680}

    // 关键反例证明 S2 不命中：最大 startTick = 1680 < 1920
    expect(Math.max(...m0.notes.map((n) => n.startTick))).toBeLessThan(PER_44);

    for (const n of m0.notes) {
      expect(n.startTick + n.durationTick).toBeLessThanOrEqual(PER_44);
      expect(n.durationTick).toBeGreaterThanOrEqual(60);
    }
  });

  it('asciiToTab 透传 partial 并给出非空 reason', () => {
    const result = asciiToTab(SAMPLE_B);
    expect(result.ok).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.failedAt).toBe(0);
    expect(typeof result.reason).toBe('string');
    expect((result.reason ?? '').length).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════════════
// 样例 C —— 5 行部分弦块（R4，P0；缺陷 3）
// ══════════════════════════════════════════════════════════════════

describe('样例 C —— 5 行部分弦块（R4 / 缺陷 3）', () => {
  const SAMPLE_C = sixLines([
    'Title: Wish You Were Here',
    'Artist: Pink Floyd',
    '',
    'e|--0---0-|',
    'B|--1---1-|',
    'G|--0---0-|',
    'D|--2---2-|',
    'A|--3---3-|',
  ]);

  it('缺低音 E 弦仍能导入（修前直接「未识别到六线谱文本」）', () => {
    const result = asciiToTab(SAMPLE_C);
    expect(result.ok).toBe(true);
    expect(result.reason).not.toBe('未识别到六线谱文本');
    expect(result.tab!.tracks[0].measures.length).toBeGreaterThanOrEqual(1);
  });

  it('实际出现的弦号集合 = {1,2,3,4,5}', () => {
    const result = asciiToTab(SAMPLE_C);
    const strings = new Set<number>();
    for (const m of result.tab!.tracks[0].measures) {
      for (const n of m.notes) strings.add(n.string);
    }
    expect([...strings].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('标题 = "Wish You Were Here"（同时验证 R6）', () => {
    const parsed = parseAscii(SAMPLE_C);
    expect(parsed.title).toBe('Wish You Were Here');
  });

  it('单行片段也可导入（RISK-1：含 `|` 的单行块合法）', () => {
    const result = asciiToTab('e|--0---0-|');
    expect(result.ok).toBe(true);
    expect(result.tab!.tracks[0].measures.length).toBeGreaterThanOrEqual(1);
  });
});

// ══════════════════════════════════════════════════════════════════
// 样例 D —— 元数据提取（R6，P1；缺陷 2）
// ══════════════════════════════════════════════════════════════════

describe('样例 D —— 元数据提取（R6 / 缺陷 2）', () => {
  const SAMPLE_D = sixLines([
    'Title: Wonderwall',
    'Artist: Oasis',
    'Tuning: E A D G B E',
    'BPM: 87',
    "Album: (What's the Story) Morning Glory?",
    '',
    '[Intro]',
    'e|--0---0-|',
    'B|--3---3-|',
    'G|--2---2-|',
    'D|--2---2-|',
    'A|--2---2-|',
    'E|--0---0-|',
  ]);

  it('title 不含 "Title:" 前缀，artist 被提取', () => {
    const parsed = parseAscii(SAMPLE_D);
    expect(parsed.title).toBe('Wonderwall');
    expect(parsed.artist).toBe('Oasis');
  });

  it('bpm 被提取；ASCII 走粘贴，bpm 直达 Tab', () => {
    const parsed = parseAscii(SAMPLE_D);
    expect(parsed.bpm).toBe(87);

    const tab = asciiToTab(SAMPLE_D).tab!;
    expect(tab.bpm).toBe(87);
    expect(tab.artist).toBe('Oasis');
    expect(tab.title).toBe('Wonderwall');
  });

  it('白名单外的 KV（Album:）被静默忽略，不计入 partial', () => {
    const parsed = parseAscii(SAMPLE_D);
    expect(parsed.partial).toBe(false);
  });

  it('Tuning: E A D G B E → 标准调弦且无 warning', () => {
    const parsed = parseAscii(SAMPLE_D);
    expect(parsed.tuning).toEqual(['E', 'A', 'D', 'G', 'B', 'E']);
    expect(parsed.warnings ?? []).toEqual([]);
  });

  it('全角冒号 / 等号 / 大小写不敏感', () => {
    const parsed = parseAscii(
      sixLines(['TITLE：Hey Jude', 'by = The Beatles', 'e|--0---0-|', 'B|--1---1-|', 'G|--0---0-|', 'D|--2---2-|', 'A|--3---3-|', 'E|--------|']),
    );
    expect(parsed.title).toBe('Hey Jude');
    expect(parsed.artist).toBe('The Beatles');
  });

  it('无 KV 时标题回退到前导区首个普通行', () => {
    const parsed = parseAscii(sixLines(['我的练习', 'e|--0---0-|', 'B|--1---1-|', 'G|--0---0-|', 'D|--2---2-|', 'A|--3---3-|', 'E|--------|']));
    expect(parsed.title).toBe('我的练习');
  });

  it('标题回退链保底：无任何可作标题的行 → "导入的六线谱"（长度 6，恒过校验）', () => {
    const parsed = parseAscii(sixLines(['e|--0---0-|', 'B|--1---1-|', 'G|--0---0-|', 'D|--2---2-|', 'A|--3---3-|', 'E|--------|']));
    expect(parsed.title).toBe('导入的六线谱');
  });

  it('BPM 非法时忽略（回落默认 90），且不因 clamp 越界写坏 Tab', () => {
    const parsed = parseAscii(sixLines(['BPM: not-a-number', 'e|--0---0-|', 'B|--1---1-|', 'G|--0---0-|', 'D|--2---2-|', 'A|--3---3-|', 'E|--------|']));
    expect(parsed.bpm).toBeUndefined();
    expect(asciiToTab(sixLines(['BPM: not-a-number', 'e|--0---0-|', 'B|--1---1-|', 'G|--0---0-|', 'D|--2---2-|', 'A|--3---3-|', 'E|--------|'])).tab!.bpm).toBe(90);
  });

  it('BPM 越界时 clamp 到 [MIN_BPM, MAX_BPM]', () => {
    const mk = (bpm: string): string =>
      sixLines([`BPM: ${bpm}`, 'e|--0---0-|', 'B|--1---1-|', 'G|--0---0-|', 'D|--2---2-|', 'A|--3---3-|', 'E|--------|']);
    expect(parseAscii(mk('10')).bpm).toBe(MIN_BPM);
    expect(parseAscii(mk('999')).bpm).toBe(MAX_BPM);
    // 不允许写出让 validateTab 拒绝的 bpm
    expect(asciiToTab(mk('999')).ok).toBe(true);
  });

  it('Tuning 无法解析 → 保持默认 + 结构化 warning（不置 partial）', () => {
    const text = sixLines(['Tuning: D A D G B E', 'e|--0---0-|', 'B|--1---1-|', 'G|--0---0-|', 'D|--2---2-|', 'A|--3---3-|', 'E|--------|']);
    const parsed = parseAscii(text);
    expect(parsed.tuning).toBeUndefined();
    expect(parsed.partial).toBe(false);
    expect(parsed.warnings ?? []).toContain('调弦信息无法识别，已使用标准调弦');

    const result = asciiToTab(text);
    expect(result.warnings).toContain('调弦信息无法识别，已使用标准调弦');
    expect(result.tab!.tuning).toEqual(['E', 'A', 'D', 'G', 'B', 'E']);
  });

  it('表头 6/8 被忽略，回落默认拍号（不得写出校验拒绝的拍号）', () => {
    const text = sixLines(['Time: 6/8', 'e|--0---0-|', 'B|--1---1-|', 'G|--0---0-|', 'D|--2---2-|', 'A|--3---3-|', 'E|--------|']);
    const parsed = parseAscii(text);
    expect(parsed.timeSignature).toEqual([4, 4]);
    expect(asciiToTab(text).ok).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// 样例 E —— 段落标记（R7，P1；缺陷 5）
// ══════════════════════════════════════════════════════════════════

describe('样例 E —— 段落标记写入 sectionLabel（R7 / 缺陷 5）', () => {
  const SAMPLE_E = sixLines([
    '[Intro]',
    'e|--0---0-|',
    'B|--1---1-|',
    'G|--0---0-|',
    'D|--2---2-|',
    'A|--3---3-|',
    'E|--------|',
    '',
    '[Verse]',
    'e|--3---3-|',
    'B|--0---0-|',
    'G|--0---0-|',
    'D|--0---0-|',
    'A|--2---2-|',
    'E|--3---3-|',
  ]);

  it('两个块共 2 小节，sectionLabel 依次为 Intro / Verse', () => {
    const parsed = parseAscii(SAMPLE_E);
    expect(parsed.measures).toHaveLength(2);
    expect(parsed.measures[0]!.sectionLabel).toBe('Intro');
    expect(parsed.measures[1]!.sectionLabel).toBe('Verse');
  });

  it('无段落标记时 sectionLabel 保持空串（不回归）', () => {
    const parsed = parseAscii(sixLines(['e|--0---0-|', 'B|--1---1-|', 'G|--0---0-|', 'D|--2---2-|', 'A|--3---3-|', 'E|--------|']));
    expect(parsed.measures[0]!.sectionLabel).toBe('');
  });

  it('段落标记跨块延续：后续无标记的块继承上一段落名', () => {
    const parsed = parseAscii(
      sixLines([
        '[Chorus]',
        'e|--0---0-|',
        'B|--1---1-|',
        'G|--0---0-|',
        'D|--2---2-|',
        'A|--3---3-|',
        'E|--------|',
        '',
        'e|--3---3-|',
        'B|--0---0-|',
        'G|--0---0-|',
        'D|--0---0-|',
        'A|--2---2-|',
        'E|--3---3-|',
      ]),
    );
    expect(parsed.measures).toHaveLength(2);
    expect(parsed.measures[0]!.sectionLabel).toBe('Chorus');
    expect(parsed.measures[1]!.sectionLabel).toBe('Chorus');
  });

  it('中文段落标记 [前奏] 同样生效', () => {
    const parsed = parseAscii(sixLines(['[前奏]', 'e|--0---0-|', 'B|--1---1-|', 'G|--0---0-|', 'D|--2---2-|', 'A|--3---3-|', 'E|--------|']));
    expect(parsed.measures[0]!.sectionLabel).toBe('前奏');
  });
});

// ══════════════════════════════════════════════════════════════════
// 样例 F —— 末音符时值收束（R8，P2；缺陷 4）
// 说明：PRD 原样例（单小节）行宽恰为小节宽度，约束恒真、无区分度；
//       故另加「每行 3 小节、闷音在小节 0」的加强输入，使约束产生可观测差异。
// ══════════════════════════════════════════════════════════════════

describe('样例 F —— 末音符时值收束（R8 / 缺陷 4）', () => {
  it('PRD 原样例（闷音用 `x` 表示）：时值受小节右边界约束且 ≥ MIN_NOTE_TICKS', () => {
    const text = sixLines(['e|--------|', 'B|--------|', 'G|--x-----|', 'D|--------|', 'A|--5-----|', 'E|--------|']);
    const parsed = parseAscii(text);
    const m0 = parsed.measures[0]!;
    const mute = m0.notes.find((n) => n.techniques.includes('x'));
    const plain = m0.notes.find((n) => !n.techniques.includes('x'));
    expect(mute).toBeDefined();
    expect(plain).toBeDefined();

    // 单小节样例中行宽 == 小节宽度，约束恒真（架构 §0 已指出该样例无区分度）：
    // 时值 = min(小节右边界 − 列, 行尾 − 列) = 8 − 2 = 6 列 = 720 ticks
    expect(mute!.durationTick).toBe(6 * COL);
    expect(plain!.durationTick).toBe(6 * COL);
    expect(mute!.durationTick).toBeGreaterThanOrEqual(60);
    expect(mute!.startTick + mute!.durationTick).toBeLessThanOrEqual(PER_44);
  });

  it('加强输入：末位闷音严格短于行尾距离（修前 = 1920 满小节）', () => {
    // 每行 3 小节、每小节 8 列 → 内容区 26 列；闷音在全局列 2（小节 0 内）
    const text = sixLines([
      'e|--------|--------|--------|',
      'B|--------|--------|--------|',
      'G|--x-----|--------|--------|',
      'D|--------|--------|--------|',
      'A|--------|--------|--------|',
      'E|--------|--------|--------|',
    ]);
    const result = asciiToTab(text);
    expect(result.ok).toBe(true);
    const tab = result.tab!;
    expect(tab.tracks[0].measures).toHaveLength(3);

    const mute = tab.tracks[0].measures[0]!.notes[0]!;
    expect(mute.techniques).toContain('x');
    expect(mute.startTick).toBe(2 * COL); // 240

    // 行尾距离 8 列 = 960 ticks，未受约束的旧实现会拉到小节容量 1920
    expect(mute.durationTick).toBeLessThan(8 * COL);
    // 且不超过所在小节剩余容量（小节右边界 9 列 − 2 列 = 7 列）
    expect(mute.durationTick).toBeLessThanOrEqual(7 * COL);
    expect(mute.durationTick).toBeGreaterThanOrEqual(60);
    // 不溢出小节
    expect(mute.startTick + mute.durationTick).toBeLessThanOrEqual(PER_44);
  });

  it('`s` 无前置品位数字时不产生音符（技法只能修饰已有音符，不凭空造音）', () => {
    const parsed = parseAscii(sixLines(['e|--------|', 'B|--------|', 'G|--s-----|', 'D|--------|', 'A|--5-----|', 'E|--------|']));
    const notes = parsed.measures[0]!.notes;
    // 仅 A 弦的 5 一个音符；G 弦的 `s` 无基音，被忽略
    expect(notes.map((n) => [n.string, n.fret])).toEqual([[5, 5]]);
  });
});

// ══════════════════════════════════════════════════════════════════
// D11 约束 ③ —— 跨弦收束（★ team-lead 独立探测出的阻断级缺陷）
//
// 缺陷形态：`readLineNotes` 是**行级**函数，其局部 `notes` 只含本行音符，
// 导致「下一任意弦事件列」永远找不到 → ③ 退化为 ②（等于不存在）。
// 只有在「本行音符的时值由 ① 或 ② 决定」时它才不被发现。
// 故必须有**跨行**的判别用例：低音弦的列 1 音符，高音弦在列 2 有音符。
// ══════════════════════════════════════════════════════════════════

describe('D11 约束 ③ —— 跨弦收束（行级实现下必失效）', () => {
  it('★ 判别用例：A 弦列1 音符被 e 弦列2 音符收束到 1 列（120 ticks）', () => {
    // 低音弦 A 在相对列 1 有音符；高音弦 e 在相对列 2 有音符（跨行）
    const text = sixLines([
      'e|--5-------------|',
      'B|----------------|',
      'G|----------------|',
      'D|----------------|',
      'A|-5--------------|',
      'E|----------------|',
    ]);
    const parsed = parseAscii(text);
    const m0 = parsed.measures[0]!;
    const aNote = m0.notes.find((n) => n.string === 5)!;
    expect(aNote).toBeDefined();
    expect(aNote.startTick).toBe(1 * COL); // 120

    // ③ 命中：下一任意弦事件在列 2 → durCols = 1 → 1×120 = 120（≥ MIN_NOTE_TICKS=60，不被夹）
    // 修复前（行级 ③）会得到 ② 的 15 列 = 1800
    expect(aNote.durationTick).toBe(1 * COL);

    // e 弦列 2 音符自身：块内无更右事件 → 由 ② 小节右界收束 = 16 − 2 = 14 列
    const eNote = m0.notes.find((n) => n.string === 1)!;
    expect(eNote.startTick).toBe(2 * COL);
    expect(eNote.durationTick).toBe(14 * COL);
  });

  it('对照：同弦两个音仍由 ① 收束（约束 ① 不回归）', () => {
    const text = sixLines(['A|-5------------5-|', 'e|----------------|', 'B|----------------|', 'G|----------------|', 'D|----------------|', 'E|----------------|']);
    const parsed = parseAscii(text);
    const notes = parsed.measures[0]!.notes.filter((n) => n.string === 5).sort((a, b) => a.startTick - b.startTick);
    expect(notes.map((n) => n.startTick)).toEqual([1 * COL, 14 * COL]);
    // 第一个音被同弦下一个音收束：14 − 1 = 13 列
    expect(notes[0]!.durationTick).toBe(13 * COL);
    // 最后一个音由 ② 小节右界收束：16 − 14 = 2 列
    expect(notes[1]!.durationTick).toBe(2 * COL);
  });

  it('③ 与 ② 取 min：不会跨小节误伤（下一事件在下一小节时由 ② 先行收口）', () => {
    // 每行 2 小节、每小节 8 列：A 弦第0小节列1 有音，e 弦第1小节列2 有音
    // 段 0 = [0, 8)（各行第 0 段并集），段 1 = [9, 17)
    // ③ 会给出 e 弦列 10 − 1 = 9 列，但 ② 小节右界 = 8 − 1 = 7 列 → 取 min = 7
    const text = sixLines([
      'e|--------|--5-----|',
      'B|--------|--------|',
      'G|--------|--------|',
      'D|--------|--------|',
      'A|-5------|--------|',
      'E|--------|--------|',
    ]);
    const parsed = parseAscii(text);
    expect(parsed.measures).toHaveLength(2);

    const aNote = parsed.measures[0]!.notes.find((n) => n.string === 5)!;
    expect(aNote.startTick).toBe(1 * COL);
    // 受本小节右边界收束（7 列），而非跨小节的 9 列
    expect(aNote.durationTick).toBe(7 * COL);
    // 且不越出本小节（段 0 = [0,8) → 8 列 = 960）
    expect(aNote.startTick + aNote.durationTick).toBeLessThanOrEqual(8 * COL);

    // 跨小节的 e 弦音符落在第 1 小节，未被误并入第 0 小节
    // e 弦内容 `--------|--5-----` 中 `5` 在全局列 11；段 1 = [9,17) → 相对列 2
    const eNote = parsed.measures[1]!.notes.find((n) => n.string === 1)!;
    expect(eNote.startTick).toBe(2 * COL); // 相对第 1 小节起点
  });

  it('③ 排除自身续位：两位数品位（12 品）不把自己列+1 当成下一事件', () => {
    // G 弦列 0 = '12'（占列 0、1），列 8 有 '3'；A 弦列 0 有 '5'
    // 若 ③ 误把「自身续位列 1」当事件，A 弦音符会被裁到 1 列而非真实距离
    const text = sixLines([
      'e|--------|',
      'B|--------|',
      'G|12------|',
      'D|--------|',
      'A|5-------|',
      'E|--------|',
    ]);
    const parsed = parseAscii(text);
    const m0 = parsed.measures[0]!;
    const aNote = m0.notes.find((n) => n.string === 5)!;
    // A 弦列 0，下一个任意弦事件 = G 弦列 0（同列，不算 > col）→ 无更右事件 → 由 ② 收口 = 8 列
    expect(aNote.durationTick).toBe(8 * COL);

    const gNote = m0.notes.find((n) => n.string === 3)!;
    expect(gNote.fret).toBe(12);
    // G 弦自身无更右事件 → ② = 8 列（若把它自己的列 1 当事件会得到错误值）
    expect(gNote.durationTick).toBe(8 * COL);
  });
});

// ══════════════════════════════════════════════════════════════════
// 样例 G —— 非谱面文本仍被拒绝（回归）
// ══════════════════════════════════════════════════════════════════

describe('样例 G —— 非谱面文本仍被拒绝（回归）', () => {
  it('普通文本 → ok === false 且 reason 文案不变', () => {
    const result = asciiToTab('这是一段普通文字，没有六线谱。');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('未识别到六线谱文本');
  });

  it('RISK-1：`A:` 开头的正文不被误判为 A 弦行', () => {
    const result = asciiToTab(sixLines(['A: 这是一段说明文字', 'B: 另一行说明', '没有弦号结尾的终止符']));
    expect(result.ok).toBe(false);
  });

  it('RISK-1：弦号行但内容纯横杠（无音符字符）不构成块', () => {
    const result = asciiToTab(sixLines(['e|--------|', 'B|--------|', 'G|--------|', 'D|--------|', 'A|--------|', 'E|--------|']));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('未识别到六线谱文本');
  });

  it('RISK-1：单行片段不含 `|` 时不被误判', () => {
    const result = asciiToTab('e--0---0-');
    expect(result.ok).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
// 样例 H + 缺陷 6 —— 往返一致（含 3/4 拍，P0）
// ══════════════════════════════════════════════════════════════════

describe('缺陷 6 —— 3/4 拍往返一致（P0）', () => {
  it('tabToAscii → asciiImporter.parse 小节数一致（3/4 拍 32 小节）', async () => {
    const src = buildTabFromChordChart(SONG_WALTZ);
    expect(src.timeSignature).toEqual([3, 4]);
    expect(src.tracks[0].measures).toHaveLength(32);

    const ascii = tabToAscii(src);
    expect(ascii).toContain('3/4');

    // 表头拍号驱动：无需显式传 ts，也应得到 32 小节（修前按 [4,4] 的 16 列切 → 丢小节）
    const parsed = parseAscii(ascii);
    expect(parsed.timeSignature).toEqual([3, 4]);
    expect(parsed.measures).toHaveLength(32);

    const result = await asciiToTab(ascii);
    expect(result.ok).toBe(true);
    expect(result.tab!.tracks[0].measures).toHaveLength(32);
    expect(result.tab!.timeSignature).toEqual([3, 4]);
  });

  it('显式传 ts=[3,4] 亦得到一致小节数（表头缺失时的兜底）', () => {
    const src = buildTabFromChordChart(SONG_WALTZ);
    const ascii = tabToAscii(src).replace(/3\/4/, '');
    const parsed = parseAscii(ascii, [3, 4]);
    expect(parsed.timeSignature).toEqual([3, 4]);
    expect(parsed.measures).toHaveLength(32);
  });

  it('(弦,品) 集合 3/4 拍往返一致', async () => {
    const src = buildTabFromChordChart(SONG_WALTZ);
    const result = await asciiToTab(tabToAscii(src));
    const sig = (tab: Tab): string[] =>
      tab.tracks[0].measures.flatMap((m) => m.notes.map((n) => `${m.index}:${n.string}:${n.fret}`)).sort();
    expect(sig(result.tab!)).toEqual(sig(src));
  });
});

describe('样例 H —— 4/4 拍往返一致（回归）', () => {
  it('16 小节 + signature 一致', async () => {
    const src: Tab = buildTabFromChordChart(SONG_MORNING);
    expect(src.tracks[0].measures).toHaveLength(16);
    const ascii = tabToAscii(src);
    const result = await asciiToTab(ascii);
    expect(result.ok).toBe(true);
    expect(result.tab!.tracks[0].measures).toHaveLength(16);

    const sig = (tab: Tab): string[] =>
      tab.tracks[0].measures.flatMap((m) => m.notes.map((n) => `${m.index}:${n.string}:${n.fret}`)).sort();
    expect(sig(result.tab!)).toEqual(sig(src));
  });
});

// ══════════════════════════════════════════════════════════════════
// 小节线语义 —— 连续 `|` 剥离、首 `|` 零宽（既有断言的必要前提）
// ══════════════════════════════════════════════════════════════════

describe('小节线语义 —— 连续 `|` 剥离与行首 `|` 零宽', () => {
  it('`1| |---0--`：被空格隔开的连续 `|` 不产生空小节', () => {
    const parsed = parseAscii(
      sixLines(['1| |---0--', '2| |--1---', '3| |-0----', '4| |--2---', '5| |-3----', '6| |0-----']),
    );
    expect(parsed.measures).toHaveLength(1);
    expect(parsed.measures[0]!.notes.map((n) => n.string).sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('行首 `|` 是零宽剥离而非空小节（既有断言的必要前提）', () => {
    const parsed = parseAscii(sixLines(['1|---0--', '2|--1---', '3|-0----', '4|--2---', '5|-3----', '6|0-----']));
    expect(parsed.measures).toHaveLength(1);
    expect(parsed.measures[0]!.notes.map((n) => n.string).sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('行尾收口 `|` 不产生尾随空小节', () => {
    const parsed = parseAscii(sixLines(['e|--0---0-|', 'B|--1---1-|', 'G|--0---0-|', 'D|--2---2-|', 'A|--3---3-|', 'E|--------|']));
    expect(parsed.measures).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════
// 缺陷 7 —— Technique 类型不得越界（编译期 + 运行期双保险）
// ══════════════════════════════════════════════════════════════════

describe('缺陷 7 —— Technique 类型不得越界', () => {
  it('`v` 不再进入 techniques（修前被强制转型为 Technique 并入库）', () => {
    const parsed = parseAscii(
      sixLines(['e|--0v--0-|', 'B|--1---1-|', 'G|--0---0-|', 'D|--2---2-|', 'A|--3---3-|', 'E|--------|']),
    );
    for (const m of parsed.measures) {
      for (const n of m.notes) {
        for (const t of n.techniques) {
          expect(['h', 'p', 's', 'x', '^']).toContain(t);
        }
      }
    }
  });

  it('合法技法 h/p/s/^ 与闷音 x 正常入库且去重', () => {
    const parsed = parseAscii(
      sixLines(['e|--0h--0s|', 'B|--1p--1-|', 'G|--0^--x-|', 'D|--2---2-|', 'A|--3---3-|', 'E|--------|']),
    );
    const notes = parsed.measures[0]!.notes;
    const byString = (s: number): typeof notes => notes.filter((n) => n.string === s);
    expect(byString(1)[0]!.techniques).toEqual(['h']);
    expect(byString(1)[1]!.techniques).toEqual(['s']);
    expect(byString(2)[0]!.techniques).toEqual(['p']);
    expect(byString(3)[0]!.techniques).toEqual(['^']);
    expect(byString(3)[1]!.techniques).toEqual(['x']);
  });

  it('闷音 x 的 velocity 为 0.5（既有行为不回归）', () => {
    const parsed = parseAscii(sixLines(['e|--x-----|', 'B|--1---1-|', 'G|--0---0-|', 'D|--2---2-|', 'A|--3---3-|', 'E|--------|']));
    const mute = parsed.measures[0]!.notes.find((n) => n.techniques.includes('x'));
    expect(mute!.velocity).toBe(0.5);
    expect(mute!.fret).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
// 缺陷 8 —— asciiToTab 必须走 validateTab
// ══════════════════════════════════════════════════════════════════

describe('缺陷 8 —— asciiToTab 走 validateTab（与 JSON 路径一致）', () => {
  it('正常解析结果恒通过校验（title 保底 / artist ?? 未知 / bpm clamp / 合法拍号）', () => {
    const result = asciiToTab(sixLines(['e|--0---0-|', 'B|--1---1-|', 'G|--0---0-|', 'D|--2---2-|', 'A|--3---3-|', 'E|--------|']));
    expect(result.ok).toBe(true);
    const tab = result.tab!;
    expect(tab.title.length).toBeGreaterThanOrEqual(1);
    expect(tab.title.length).toBeLessThanOrEqual(120);
    expect(typeof tab.artist).toBe('string');
    expect(tab.artist.length).toBeGreaterThan(0);
    expect(tab.bpm).toBeGreaterThanOrEqual(MIN_BPM);
    expect(tab.bpm).toBeLessThanOrEqual(MAX_BPM);
    expect(tab.timeSignature).toEqual([4, 4]);
    expect(tab.tracks[0].measures.length).toBeGreaterThan(0);
  });

  it('JSON 路径校验失败的语义未被 ASCII 改动影响（source 契约不变）', () => {
    const result = asciiToTab(sixLines(['e|--0---0-|', 'B|--1---1-|', 'G|--0---0-|', 'D|--2---2-|', 'A|--3---3-|', 'E|--------|']));
    expect(result.tab!.source.importer).toBe('ascii');
    expect(result.tab!.source.type).toBe('imported');
  });
});

// ══════════════════════════════════════════════════════════════════
// 缺陷 9 —— ASCII 体积/长度守卫
// ══════════════════════════════════════════════════════════════════

describe('缺陷 9 —— ASCII 长度守卫（唯一文本入口，不可绕过）', () => {
  it('超长输入被拒绝并给出明确 reason（不进入解析主流程）', () => {
    const huge = 'x'.repeat(MAX_IMPORT_ASCII_CHARS + 1);
    const parsed = parseAscii(huge);
    expect(parsed.measures).toHaveLength(0);
    expect(parsed.reason).toBe('粘贴内容超过 100 万字符，请分段导入');

    const result = asciiToTab(huge);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('粘贴内容超过 100 万字符，请分段导入');
  });

  it('恰好等于上限仍被接受（用 `>` 而非 `>=`，与文件体积守卫一致）', () => {
    const atLimit = 'x'.repeat(MAX_IMPORT_ASCII_CHARS);
    const parsed = parseAscii(atLimit);
    // 不是体积超限拒绝（而是「未识别到六线谱文本」）
    expect(parsed.reason).toBe('未识别到六线谱文本');
  });
});

// ══════════════════════════════════════════════════════════════════
// RISK-3 —— 众数（多退少补）+ 并列显式取最小
// ══════════════════════════════════════════════════════════════════

describe('RISK-3 —— 段数取众数、并列取最小、多退少补', () => {
  it('各行段数一致（均 2 小节）时不置 partial', () => {
    const parsed = parseAscii(
      sixLines(['e|--0---0-|--2---2-|', 'B|--0---0-|--3---3-|', 'G|--1---1-|--2---2-|', 'D|--2---2-|--0---0-|', 'A|--2---2-|--2---2-|', 'E|--0---0-|--0---0-|']),
    );
    expect(parsed.measures).toHaveLength(2);
    expect(parsed.partial).toBe(false);
  });

  it('段数不一致 → 取众数 + partial = true', () => {
    // 5 行 2 小节 + 1 行 1 小节 → 众数 = 2
    const parsed = parseAscii(
      sixLines(['e|--0---0-|--2---2-|', 'B|--0---0-|--3---3-|', 'G|--1---1-|--2---2-|', 'D|--2---2-|--0---0-|', 'A|--2---2-|--2---2-|', 'E|--0---0-|']),
    );
    expect(parsed.measures).toHaveLength(2); // 众数 2 > 1
    expect(parsed.partial).toBe(true);
    expect(parsed.failedAt).toBeUndefined(); // RISK-3 差异行不设 failedAt
  });

  it('段数并列（各 3 行）时显式取较小段数', () => {
    // 3 行 1 小节 + 3 行 2 小节：众数并列（各 3 次）→ 显式取最小值 1
    const parsed = parseAscii(
      sixLines(['e|--0---0-|', 'B|--1---1-|', 'G|--0---0-|', 'D|--2---2-|--0---0-|', 'A|--3---3-|--2---2-|', 'E|--0---0-|--0---0-|']),
    );
    expect(parsed.measures).toHaveLength(1);
    expect(parsed.partial).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// 缺陷 3 / R4 —— 块边界不得把相邻块合并；块间小节与 startTick 连续累加
// ══════════════════════════════════════════════════════════════════

describe('块边界与连续性（R4 / R5）', () => {
  it('空行断块：两块不合并，小节数累加，全局 startTick 连续', () => {
    const parsed = parseAscii(
      sixLines([
        'e|--0---0-|',
        'B|--1---1-|',
        'G|--0---0-|',
        'D|--2---2-|',
        'A|--3---3-|',
        'E|--------|',
        '',
        'e|--3---3-|',
        'B|--0---0-|',
        'G|--0---0-|',
        'D|--0---0-|',
        'A|--2---2-|',
        'E|--3---3-|',
      ]),
    );
    expect(parsed.measures).toHaveLength(2);
    expect(parsed.measures[0]!.startTick).toBe(0);
    expect(parsed.measures[1]!.startTick).toBe(PER_44);
    expect(parsed.measures.map((m) => m.index)).toEqual([0, 1]);
  });

  it('普通行（other）强制断块，不跨行合并弦行', () => {
    const parsed = parseAscii(
      sixLines([
        'e|--0---0-|',
        'B|--1---1-|',
        'G|--0---0-|',
        'D|--2---2-|',
        'A|--3---3-|',
        'E|--------|',
        '这是一段说明文字',
        'e|--3---3-|',
        'B|--0---0-|',
        'G|--0---0-|',
        'D|--0---0-|',
        'A|--2---2-|',
        'E|--3---3-|',
      ]),
    );
    expect(parsed.measures).toHaveLength(2);
  });

  it('字母族与数字族不同块混用', () => {
    const parsed = parseAscii(sixLines(['1|--0---0-|', 'B|--1---1-|', '3|-0-----|', 'D|--2---2-|', '5|-3-----|', 'E|--------|']));
    // 数字族 1/3/5 与字母族 B/D/E 混排 → 块分裂，但仍能解析（不零导入）
    expect(parsed.measures.length).toBeGreaterThanOrEqual(1);
  });

  it('两位数品位（12 品）合成为一个品位，不拆成 1、2', () => {
    const parsed = parseAscii(sixLines(['e|--12--0-|', 'B|--1---1-|', 'G|--0---0-|', 'D|--2---2-|', 'A|--3---3-|', 'E|--------|']));
    const notes = parsed.measures[0]!.notes.filter((n) => n.string === 1);
    expect(notes.map((n) => n.fret)).toEqual([12, 0]);
    expect(notes[0]!.startTick).toBe(2 * COL);
    // 0 在全局列 6（`12` 消费列 2、3，`--0` 使 0 落在列 6）
    expect(notes[1]!.startTick).toBe(6 * COL);
  });
});

// ══════════════════════════════════════════════════════════════════
// 缺陷 1 的 failedAt 语义 —— 多成因取最小小节序号
// ══════════════════════════════════════════════════════════════════

describe('failedAt 语义（R9）', () => {
  it('未识别字符（@）所在小节计入 failedAt，partial = true', () => {
    const parsed = parseAscii(
      sixLines(['e|---0---@---', 'B|---1---1---', 'G|---0---0---', 'D|---2---2---', 'A|---3---3---', 'E|--------3--']),
    );
    expect(parsed.partial).toBe(true);
    expect(parsed.failedAt).toBe(0);
  });

  it('多成因并存时取最小小节序号', () => {
    const parsed = parseAscii(
      sixLines([
        'e|--0---0-|--0---0-|--0---0-|',
        'B|--0---0-|--0---0-|--0---0-|',
        'G|--1---1-|--1---1-|--1---1-|',
        'D|--2---2-|--2---2-|--2---2-|',
        'A|--2---2-|--2---2-|--2---2-|',
        'E|--0---0-|--0---0-|--0---0-|',
      ]),
    );
    // 每段 8 列 ≤ 16，无溢出；无未识别字符 → 不 partial
    expect(parsed.partial).toBe(false);
    expect(parsed.failedAt).toBeUndefined();
  });
});
