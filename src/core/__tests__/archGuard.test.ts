/**
 * 架构守卫测试（架构 §3 / §9.3 / 附"三个历史翻车点的防御清单"）。
 *
 * 这里不测业务，只测**结构性不变量**被破坏：
 *  - R6：`6 - x` 的弦/图索引换算只允许出现在 core/fretboard.ts
 *  - INV-4：任何源码都不允许出现 playbackRate（变速必须靠重新调度）
 *  - R1：core 层禁止依赖 react / audio / storage / ui
 *  - 合规：源码中禁止"额度 / 剩余次数 / 今日 N 次"文案
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

interface SourceFile {
  path: string;
  rel: string;
  code: string;
}

function walk(dir: string, acc: SourceFile[] = []): SourceFile[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // 测试自身（含本文件）不参与扫描
      if (entry === '__tests__' || entry === 'node_modules') continue;
      walk(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      acc.push({ path: full, rel: relative(SRC, full).split(sep).join('/'), code: readFileSync(full, 'utf8') });
    }
  }
  return acc;
}

const files = walk(SRC);
const business = files.filter((f) => f.rel !== 'core/fretboard.ts');

/** 去掉注释后再匹配，避免把说明文字误判为实现 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('架构守卫 —— 源码扫描', () => {
  it('扫描到了源码文件（防止路径写错导致空跑）', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(business.length).toBeGreaterThan(20);
  });

  it('R6：`6 - x` 方向换算只出现在 core/fretboard.ts', () => {
    const offenders = business
      .filter((f) => /6\s*-\s*[A-Za-z_]/.test(stripComments(f.code)))
      .map((f) => f.rel);
    expect(offenders, `以下文件出现方向换算，必须改用 diagramIndexOf / stringOf：${offenders.join(', ')}`).toEqual(
      [],
    );
  });

  it('core/fretboard.ts 确实持有唯一的换算实现', () => {
    const fb = files.find((f) => f.rel === 'core/fretboard.ts');
    expect(fb).toBeDefined();
    expect(/6\s*-\s*[A-Za-z_]/.test(fb?.code ?? '')).toBe(true);
  });

  it('INV-4：全项目没有 playbackRate（变速靠重新调度，不用音源速率）', () => {
    const offenders = files.filter((f) => /playbackRate/.test(f.code)).map((f) => f.rel);
    expect(offenders, `禁止使用 playbackRate：${offenders.join(', ')}`).toEqual([]);
  });

  it('R1：core 层不依赖 react / audio / storage / ui', () => {
    const offenders = files
      .filter((f) => f.rel.startsWith('core/'))
      .filter((f) => /from\s+['"](react|react-dom|@\/audio\/|@\/storage\/|@\/ui\/)/.test(f.code))
      .map((f) => f.rel);
    expect(offenders, `core 层不得依赖上层：${offenders.join(', ')}`).toEqual([]);
  });

  it('data 层只依赖 core / types', () => {
    const offenders = files
      .filter((f) => f.rel.startsWith('data/'))
      .filter((f) => /from\s+['"](react|@\/audio\/|@\/storage\/|@\/ui\/|@\/state\/)/.test(f.code))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('合规：源码中不出现"额度 / 剩余次数 / 今日 N 次 / AI 云端"', () => {
    const offenders = files
      .filter((f) => /额度|剩余次数|今日\s*\d+\s*次|AI\s*云端/.test(f.code))
      .map((f) => f.rel);
    expect(offenders, `禁止的文案出现在：${offenders.join(', ')}`).toEqual([]);
  });

  it('业务代码不得直接下标 chord.diagram（必须走 fretboard 的 fretAt）', () => {
    const offenders = business
      .filter((f) => /diagram\s*\[\s*\d/.test(stripComments(f.code)))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
