/**
 * QA 边界回归 —— 内置曲规格 / 谱库筛选排序（独立于工程师用例，纯函数部分）。
 *
 * 覆盖风险（team-lead 点名 C 部分 + PRD §8/A-03/A-02）：
 *  1) buildBuiltinTabs 生成 4 首，规格与 PRD §8 表逐条一致（调/BPM/拍号/难度/小节数/source/practice）
 *  2) 4 首难度星级 1/2/3/4 各命中 1 首；4/4 3 首、3/4 1 首
 *  3) applyFilters：调 / BPM 区间 / 来源 / 拍号 叠加；BPM 用 [min,max] 闭区间
 *  4) applySort「最近练习」：有练习记录在前、无练习记录按 createdAt 倒序在后
 *  5) 搜索词 <2 字符不过滤
 */
import { describe, expect, it } from 'vitest';
import { buildBuiltinTabs } from '@/storage/seed';
import {
  applyFilters,
  applySort,
  DEFAULT_FILTERS,
  searchMatches,
  type TabMetaLike,
} from '@/state/useLibraryStore';
import type { Tab } from '@/types/tab';

function metaOf(tab: Tab, patch: Partial<TabMetaLike> = {}): TabMetaLike {
  return {
    id: tab.id,
    title: tab.title,
    artist: tab.artist,
    key: tab.key,
    bpm: tab.bpm,
    timeSignature: tab.timeSignature,
    difficulty: tab.difficulty,
    difficultyOverride: tab.difficultyOverride,
    source: tab.source,
    tags: tab.tags,
    mastery: tab.practice.mastery,
    lastPracticedAt: tab.practice.lastPracticedAt,
    createdAt: tab.createdAt,
    updatedAt: tab.updatedAt,
    ...patch,
  };
}

describe('QA §8 —— 内置 4 首规格（PRD 播种校验清单）', () => {
  const tabs = buildBuiltinTabs();
  it('恰好 4 首，source=builtin，mastery=0', () => {
    expect(tabs).toHaveLength(4);
    for (const t of tabs) {
      expect(t.source.type).toBe('builtin');
      expect(t.practice.mastery).toBe(0);
      expect(t.tracks).toHaveLength(1);
    }
  });

  it('调/BPM/拍号/难度/小节数 与 PRD §8 表一致', () => {
    const row = (title: string) => tabs.find((t) => t.title === title)!;
    const no1 = row('练习曲 No.1 · 晨光');
    expect([no1.key, no1.bpm, no1.timeSignature, no1.difficulty, no1.tracks[0].measures.length]).toEqual([
      'C',
      72,
      [4, 4],
      1,
      16,
    ]);
    const no2 = row('练习曲 No.2 · 换和弦练习');
    expect([no2.key, no2.bpm, no2.timeSignature, no2.difficulty, no2.tracks[0].measures.length]).toEqual([
      'G',
      84,
      [4, 4],
      2,
      24,
    ]);
    const no3 = row('练习曲 No.3 · 分解和弦');
    expect([no3.key, no3.bpm, no3.timeSignature, no3.difficulty, no3.tracks[0].measures.length]).toEqual([
      'Am',
      76,
      [4, 4],
      3,
      24,
    ]);
    const no4 = row('练习曲 No.4 · 三拍子圆舞曲');
    expect([no4.key, no4.bpm, no4.timeSignature, no4.difficulty, no4.tracks[0].measures.length]).toEqual([
      'D',
      96,
      [3, 4],
      4,
      32,
    ]);
  });

  it('每首都有音符（由节奏引擎生成），小节 ticks 正确', () => {
    for (const t of tabs) {
      const ts = t.timeSignature;
      const per = ts[0] === 3 ? 1440 : 1920;
      for (const m of t.tracks[0].measures) {
        expect(m.ticks).toBe(per);
        expect(m.startTick).toBe(m.index * per);
      }
      const noteCount = t.tracks[0].measures.reduce((s, m) => s + m.notes.length, 0);
      expect(noteCount).toBeGreaterThan(0);
    }
  });
});

describe('QA A-03/A-04 —— 筛选 / 搜索纯函数', () => {
  const tabs = buildBuiltinTabs();
  const metas = tabs.map((t) => metaOf(t));

  it('四维叠加：调=D 且 BPM [80,100] 且 4/4 → 命中 No.4？——No.4 是 3/4，所以应命中 0（叠加语义正确）', () => {
    const got = applyFilters(metas, { ...DEFAULT_FILTERS, keys: ['D'], bpm: [80, 100], timeSignatures: [[4, 4]] }, '');
    expect(got).toHaveLength(0);
  });

  it('只筛选 调=D → 命中 No.4；来源=builtin → 4 首；拍号 3/4 → 1 首', () => {
    expect(applyFilters(metas, { ...DEFAULT_FILTERS, keys: ['D'] }, '')).toHaveLength(1);
    expect(applyFilters(metas, { ...DEFAULT_FILTERS, sources: ['builtin'] }, '')).toHaveLength(4);
    expect(applyFilters(metas, { ...DEFAULT_FILTERS, timeSignatures: [[3, 4]] }, '')).toHaveLength(1);
  });

  it('BPM 区间是闭区间 [min,max]：70–80 → No.1(72)+No.3(76)', () => {
    const got = applyFilters(metas, { ...DEFAULT_FILTERS, bpm: [70, 80] }, '');
    expect(got.map((m) => m.bpm).sort((a, b) => a - b)).toEqual([72, 76]);
  });

  it('难度星级筛选为等值（difficulty === 3），不是 ≤3', () => {
    expect(applyFilters(metas, { ...DEFAULT_FILTERS, difficulties: [3] }, '')).toHaveLength(1);
  });

  it('搜索词 <2 字符不过滤；≥2 字符对 title 子串匹配（大小写不敏感）', () => {
    expect(applyFilters(metas, DEFAULT_FILTERS, '晨')).toHaveLength(4); // 1 字符 → 不过滤
    expect(applyFilters(metas, DEFAULT_FILTERS, '晨光')).toHaveLength(1);
    expect(applyFilters(metas, DEFAULT_FILTERS, '三拍')).toHaveLength(1);
    expect(searchMatches('晨光', 'CHEN')).toBe(false); // 中文不影响
    expect(searchMatches('C Major', 'major')).toBe(true);
  });
});

describe('QA A-02 —— 最近练习排序', () => {
  const tabs = buildBuiltinTabs();
  it('有练习记录排前、无记录按 createdAt 倒序排后', () => {
    const base = tabs.map((t) => metaOf(t));
    // 给 No.3 加一个最近练习
    const practiced = base.map((m) =>
      m.title === '练习曲 No.3 · 分解和弦' ? { ...m, lastPracticedAt: '2026-09-08T10:00:00.000Z' } : m,
    );
    const sorted = applySort(practiced, 'recent');
    expect(sorted[0].title).toBe('练习曲 No.3 · 分解和弦');
    // 其余无记录项按 createdAt 倒序
    const rest = sorted.slice(1);
    for (let i = 1; i < rest.length; i += 1) {
      expect(rest[i - 1].createdAt >= rest[i].createdAt).toBe(true);
    }
  });
});
