/**
 * 任务甲 —— 覆盖漏洞补测（QA 独立审查发现的 3 处「虚假安全感」）。
 *
 * 本文件的每一组都对应一个**已确认的覆盖漏洞**：修复代码存在，但删掉它测试不报警。
 * 因此每条用例都附「变异验证」注释，说明它在哪种变异下会变红。
 *
 * 独立成文件的原因：Hole-2 用 `vi.mock` 拦截 `@/core/tabFactory`，
 * 若与其它用例同文件会污染其模块图。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportResult } from '@/types/app';
import { ASCII_COL_TICKS } from '@/io/importers';

// ══════════════════════════════════════════════════════════════════
// Hole-2 —— validateTab 接线必须被锁定
//
// 漏洞：删掉 `asciiToTab` 里整段 `validateTab` 接线，437 条全绿。
// 根因：正常 ASCII 路径产出的 Tab **恒合法**（title 有 slice(0,120) 双保险、
//       artist 有 ?? '未知'、bpm 有 clamp、ts 有白名单、measures 非空），
//       故不存在「黑盒输入能让 parseAscii 成功但 validateTab 拒绝」的用例。
// 对策：用 `vi.mock` 强制 `validateTab` 失败，断言 `asciiToTab` **必须**传递该失败。
//       这是唯一能锁定「接线是否存在」的方式（黑盒不可达）。
// 变异验证：注释掉 `asciiToTab` 中的 `validateTab` 调用 → 本组必红。
// ══════════════════════════════════════════════════════════════════

describe('Hole-2 —— asciiToTab 的 validateTab 接线（vi.mock 强制校验失败）', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('@/core/tabFactory');
    vi.resetModules();
  });

  it('★ 校验失败时 asciiToTab 必须返回 ok:false 并带上校验错误文案', async () => {
    vi.doMock('@/core/tabFactory', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/core/tabFactory')>();
      return {
        ...actual,
        // 强制校验失败，模拟「解析成功但 Tab 畸形」的未来场景
        validateTab: () => ({ ok: false, errors: ['title 长度须在 1–120', 'bpm 须为 40–240'] }),
      };
    });

    const { asciiToTab } = await import('@/io/importers');
    const result: ImportResult = asciiToTab(
      ['e|--0---0-|', 'B|--1---1-|', 'G|--0---0-|', 'D|--2---2-|', 'A|--3---3-|', 'E|--------|'].join('\n'),
    );

    // 接线存在 → 必须把校验失败传递出去，绝不能让畸形 Tab 静默入库
    expect(result.ok).toBe(false);
    expect(result.tab).toBeUndefined();
    expect(result.parsedMeasures).toBe(0);
    expect(result.reason).toContain('未识别到六线谱文本');
    expect(result.reason).toContain('title 长度须在 1–120');
    expect(result.reason).toContain('bpm 须为 40–240');
  });

  it('校验通过时行为不变（接线不误伤正常路径）', async () => {
    vi.doMock('@/core/tabFactory', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/core/tabFactory')>();
      return { ...actual, validateTab: () => ({ ok: true, errors: [] }) };
    });

    const { asciiToTab } = await import('@/io/importers');
    const result = asciiToTab(
      ['e|--0---0-|', 'B|--1---1-|', 'G|--0---0-|', 'D|--2---2-|', 'A|--3---3-|', 'E|--------|'].join('\n'),
    );
    expect(result.ok).toBe(true);
    expect(result.parsedMeasures).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════
// Hole-3 —— ③ 排除自身续位（colSpan vs col+1）
//
// 漏洞：把 `other.col < note.col + note.colSpan` 改成 `other.col < note.col + 1`，
//       437 条全绿。
// 根因：原用例里唯一的「其它事件」恰好在**同列**，两种实现都把同列事件排除 → 区分不出。
// 判别输入（QA 提供）：G 弦 '12' 在列 0–1（colSpan=2），A 弦 '5' 在列 1。
//   - 正确（col+colSpan=2）：A 弦列1 不算 G 的后继 → G dur = 8×120 = 960
//   - 变异（col+1=1）：A 弦列1（1 ≥ 1、≠0）被误判为后继 → G dur = 1×120 = 120
// 变异验证：把 `note.colSpan` 改成 `1` → 本组必红（960 → 120）。
// ══════════════════════════════════════════════════════════════════

describe('Hole-3 —— ③ 排除两位数品位的自身续位（判别输入）', () => {
  const ROWS = [
    'e|--------|',
    'B|--------|',
    'G|12------|', // 两位数品位 12，占列 0 与列 1
    'D|--------|',
    'A|-5------|', // 列 1 —— 恰好落在 G 音的「续位列」上
    'E|--------|',
  ];

  it('★ G 弦 `12` 不把自身续位列 1 当成后继事件（dur 960，非 120）', async () => {
    const { parseAscii } = await import('@/io/importers');
    const parsed = parseAscii(ROWS.join('\n'));
    const gNote = parsed.measures[0]!.notes.find((n) => n.string === 3)!;
    expect(gNote.fret).toBe(12);
    expect(gNote.startTick).toBe(0);

    // 正确：③ 把「列 < 0+2」全部排除（含列 1 的 A 弦音），G 音无更右后继
    //       → 由 ② 小节右界收束 = 8 列 = 960
    // 变异（col+1）：A 弦列 1 被误判为后继 → 1 列 = 120
    expect(gNote.durationTick).toBe(8 * ASCII_COL_TICKS);
  });

  it('对照：同一输入下 A 弦列 1 音符由 ② 收束（不因 ③ 变异而改变）', async () => {
    const { parseAscii } = await import('@/io/importers');
    const parsed = parseAscii(ROWS.join('\n'));
    const aNote = parsed.measures[0]!.notes.find((n) => n.string === 5)!;
    expect(aNote.startTick).toBe(1 * ASCII_COL_TICKS);
    // A 弦列 1：块内无更右事件（G 音在列 0，不 > 1）→ ② 收束 = 8 − 1 = 7 列
    expect(aNote.durationTick).toBe(7 * ASCII_COL_TICKS);
  });
});

// ══════════════════════════════════════════════════════════════════
// Hole-1 —— 时值下限 clamp 是死代码（选项 A：删除 + 不变量锁定）
//
// 漏洞：`readBlockNotes` ② 终点裁剪里的 `clamp(dur, MIN_NOTE_TICKS, …)` 下限分支
//       **永不触发**：`durCols` 恒 ≥ 1 ⇒ `durCols × ASCII_COL_TICKS ≥ 120 > 60`。
//       删掉下限后无任何用例变红 —— 它只是「看着安全」的冗余。
// 处置（选项 A）：删除该死下限 clamp，改为结构性论证 + 本不变量用例锁定：
//       「所有 ASCII 导入产出的音符，durationTick 恒 ≥ ASCII_COL_TICKS（=120）」。
//       若将来有人误改 `durCols` 计算使其可能为 0，本用例立刻变红。
// 变异验证：把 `computeDurationCols` 的收束结果改成可能返回 0（如 durCols 归零），
//       或把 `Math.min(per, rightBound)` 上限改成 `0` → 本组必红（出现 < 120 的音符）。
// ══════════════════════════════════════════════════════════════════

describe('Hole-1 —— 无音符时值低于一列（结构性下限不变量，替代死 clamp）', () => {
  // 覆盖多种形态：单音 / 多弦 / 两位数品位 / 闷音 x / 技法 h·p·s·^ / 多小节
  const SAMPLES: readonly { name: string; text: string }[] = [
    {
      name: '单音（最小时值形态）',
      text: ['e|--0-----------------|', 'B|--------------------|', 'G|--------------------|', 'D|--------------------|', 'A|--------------------|', 'E|--------------------|'].join('\n'),
    },
    {
      name: '双位数品位 12（colSpan=2）',
      text: ['e|--------------------|', 'B|--------------------|', 'G|12------------------|', 'D|--------------------|', 'A|--------------------|', 'E|--------------------|'].join('\n'),
    },
    {
      name: '闷音 x',
      text: ['e|--x-----------------|', 'B|--x-----------------|', 'G|--------------------|', 'D|--------------------|', 'A|--------------------|', 'E|--------------------|'].join('\n'),
    },
    {
      name: '技法链 h/p/s/^',
      text: ['e|--0h2p0s5^7---------|', 'B|--------------------|', 'G|--------------------|', 'D|--------------------|', 'A|--------------------|', 'E|--------------------|'].join('\n'),
    },
    {
      name: '多小节（含溢出列）',
      text: [
        'e|--0---0-|--3-------12-7--|',
        'B|--1---1-|--0------------|',
        'G|--0---0-|--0------------|',
        'D|--2---2-|--0------------|',
        'A|--3---3-|--2------------|',
        'E|--------|--3------------|',
      ].join('\n'),
    },
  ];

  it('★ 所有用例的音符 durationTick 恒 ≥ ASCII_COL_TICKS（结构不变量，无例外）', async () => {
    const { parseAscii } = await import('@/io/importers');
    let totalNotes = 0;
    for (const sample of SAMPLES) {
      const parsed = parseAscii(sample.text);
      for (const measure of parsed.measures) {
        for (const note of measure.notes) {
          totalNotes += 1;
          if (note.durationTick < ASCII_COL_TICKS) {
            throw new Error(
              `[Hole-1 不变量破损] sample="${sample.name}" string=${note.string} fret=${note.fret} ` +
                `startTick=${note.startTick} durationTick=${note.durationTick} < ${ASCII_COL_TICKS}`,
            );
          }
        }
      }
    }
    // 防「空跑」：确认至少解析出若干音符，否则上一条循环毫无意义
    expect(totalNotes).toBeGreaterThan(0);
    expect(totalNotes).toBeGreaterThanOrEqual(20);
  });
});
