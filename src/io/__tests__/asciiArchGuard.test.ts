/**
 * 任务甲 —— 架构守卫（IO 层专属，补充 core/__tests__/archGuard.test.ts）。
 *
 * core 守卫只覆盖 core 层；本次改造引入的新结构不变量需要在此独立锁定：
 *  - A5（反向断言）：`groupAsciiBlocks` **遇空行必须断块**。
 *    这不是风格偏好 —— 它是 `io.test.ts:70`（16 小节往返）不破的**必要前提**：
 *    若空行不断块，`tabToAscii` 每 4 小节一块、块间空行的 24 行会连成 1 个块，
 *    16 小节会被解析成 4 小节。
 *  - `io/` 层不得引入 `ui/` 依赖（解析层必须可在 node 环境独立单测）。
 *  - `parseAscii` 保持无 DOM 依赖（缺 `document` / `window` 时依然可跑）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { groupAsciiBlocks, normalizeAsciiLines, parseAscii } from '@/io/importers';

const SRC = join(process.cwd(), 'src');

interface SourceFile {
  rel: string;
  code: string;
}

function walkIo(dir: string, acc: SourceFile[] = []): SourceFile[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      walkIo(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      acc.push({ rel: relative(SRC, full).split(sep).join('/'), code: readFileSync(full, 'utf8') });
    }
  }
  return acc;
}

const ioFiles = walkIo(join(SRC, 'io'));

/** 6 行弦块（内容相同，便于构造「空行断块」对照） */
const ROW = ['e|--0---0-|', 'B|--1---1-|', 'G|--0---0-|', 'D|--2---2-|', 'A|--3---3-|', 'E|--------|'].join('\n');

describe('A5 反向断言 —— 空行必须断块（io.test.ts:70 的必要前提）', () => {
  it('两块之间有空行 → 2 个块（若不断块则为 1 个）', () => {
    const lines = normalizeAsciiLines(`${ROW}\n\n${ROW}`);
    const blocks = groupAsciiBlocks(lines);
    expect(blocks).toHaveLength(2);
  });

  it('空行断块 → 小节数按块累加（16 小节往返的前提）', () => {
    // 4 个块 × 4 小节，块间空行；若空行不断块会连成 1 块
    const cell4 = '|--0---0-|--1---1-|--2---2-|--3---3-';
    const rowOf = (lead: string): string => `${lead}${cell4}|`;
    const bar = ['e', 'B', 'G', 'D', 'A', 'E'].map(rowOf).join('\n');
    const text = [bar, '', bar, '', bar, '', bar].join('\n');

    const parsed = parseAscii(text);
    // 4 块 × 4 小节 = 16；空行不断块则只剩 4
    expect(parsed.measures).toHaveLength(16);
  });

  it('4 块 24 行（tabToAscii 真实形态）→ 16 小节而非 4', () => {
    const rows = ['e', 'B', 'G', 'D', 'A', 'E'];
    // 每行 4 个小节段（与 tabToAscii 导出 `  e|....|....|....|....|` 同构），
    // 首小节放一个音符以满足「块内至少一个可演奏字符」
    const cell = '-0--------------'; // 16 列 = 4/4 一小节
    const line = (r: string): string => `${r}|${[cell, cell, cell, cell].join('|')}|`;
    const block = (): string => rows.map(line).join('\n');
    const text = [block(), '', block(), '', block(), '', block()].join('\n');

    const parsed = parseAscii(text);
    // 4 块 × 4 小节 = 16；空行不断块则只剩 4
    expect(parsed.measures).toHaveLength(16);
  });

  it('连续多个空行也只断一次块（不产生空块）', () => {
    const lines = normalizeAsciiLines(`${ROW}\n\n\n\n${ROW}`);
    const blocks = groupAsciiBlocks(lines);
    expect(blocks).toHaveLength(2);
  });

  it('★ 判别用例：两个「弦号不重复」的部分块，只有空行能分开它们', () => {
    // 关键：块 A 的弦号 {1,2,3}、块 B 的弦号 {4,5,6}，两块的弦号集合**完全不重叠**。
    // 若空行不断块，「块内弦号互异」这条规则**不会**触发（1..6 全部互异），
    // 两块会合并成 1 个 6 行块 → 1 小节。
    // 故这一条是「空行断块」的**唯一无掩蔽判别用例**：
    // 常规的 6 行块重复（1..6, 1..6）会被「弦号重复」规则掩盖，测不出空行断块（见 M13 报告）。
    const text = [
      'e|--0---0-|',
      'B|--1---1-|',
      'G|--0---0-|',
      '',
      'D|--2---2-|',
      'A|--3---3-|',
      'E|--------|',
    ].join('\n');

    const blocks = groupAsciiBlocks(normalizeAsciiLines(text));
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.lines.length)).toEqual([3, 3]);

    const parsed = parseAscii(text);
    expect(parsed.measures).toHaveLength(2);
    expect(parsed.measures[0]!.startTick).toBe(0);
    expect(parsed.measures[1]!.startTick).toBe(1920);
  });
});

describe('io/ 层不含 ui 依赖（解析层可在 node 独立单测）', () => {
  it('扫描到 io 源码文件（防止路径写错导致空跑）', () => {
    expect(ioFiles.length).toBeGreaterThan(2);
  });

  it('io/ 不 import ui/ 或 react', () => {
    const offenders = ioFiles
      .filter((f) => /from\s+['"](@\/ui\/|react|react-dom)/.test(f.code))
      .map((f) => f.rel);
    expect(offenders, `io 层不得依赖 ui / react：${offenders.join(', ')}`).toEqual([]);
  });

  it('parseAscii 不引用 document / window（无 DOM 依赖）', () => {
    const offenders = ioFiles
      .filter((f) => f.rel === 'io/importers.ts')
      .filter((f) => /\b(document|window)\b/.test(f.code))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});

describe('parseAscii 在 node 环境下可独立运行', () => {
  it('无 DOM 也能解析（当前测试进程即 node，无 document）', () => {
    expect(typeof document).toBe('undefined');
    const parsed = parseAscii(ROW);
    expect(parsed.measures).toHaveLength(1);
  });
});
