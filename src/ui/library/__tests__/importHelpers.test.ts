// @vitest-environment node
/**
 * ImportModal 纯逻辑单测（项目未安装 @testing-library，故只测抽出的纯函数）。
 *
 * 覆盖：
 *  1. partialPromptMessage 三分支（failedAt / 无 failedAt / warnings）
 *  2. 文件体积守卫边界（XML 8MB、JSON 20MB，含 7.9/8.1 与字节级 8MB±1 边界）
 *  3. P0 回归锁：jsonImporter.fromText === true，但 UI 分流必须「只有 ascii 走文本」
 *     —— 通过 isTextInput 断言，防止两套输入源判断再次分叉。
 *  4. 超限文案含具体数值（importXmlTooLarge / importJsonTooLarge）
 *
 * QA 补充（Edward）：字节级边界、P0 复现锁、超限文案数值、tooLargeMessage。
 */
import { describe, expect, it } from 'vitest';
import { COPY, MAX_IMPORT_JSON_MB, MAX_IMPORT_XML_MB } from '@/core/constants';
import { jsonImporter } from '@/io/importers';
import type { ImportResult } from '@/types/app';
import {
  isFileTooLarge,
  isTextInput,
  maxImportMb,
  partialPromptMessage,
  successWarningMessage,
  type ImportKind,
} from '@/ui/library/importHelpers';

/** 构造最小可用的 ImportResult */
function makeResult(over: Partial<ImportResult>): ImportResult {
  return { ok: true, partial: true, parsedMeasures: 0, ...over };
}

describe('importHelpers —— isTextInput（P0 回归锁）', () => {
  it('只有 ascii 走文本输入', () => {
    expect(isTextInput('ascii')).toBe(true);
    expect(isTextInput('json')).toBe(false);
    expect(isTextInput('musicxml')).toBe(false);
  });

  it('回归锁：jsonImporter.fromText 为 true，但 UI 分流不得依赖它', () => {
    // 这是 bug 的根因 —— 导入器声明的 fromText 语义含糊，不能用于 UI 分流
    expect(jsonImporter.fromText).toBe(true);
    // 因此 UI 必须走显式规则：只有 ascii 走文本
    expect(isTextInput('json')).toBe(false);
    expect(isTextInput('ascii')).toBe(true);
  });

  it('P0 复现锁：JSON 必须走「文件分支」而非「文本分支」', () => {
    // 完整复刻原 P0：用户选 JSON 文件。
    // 只要 isTextInput('json') 返回 true（= 错误地依赖 fromText 分流），本断言即报红。
    const kind: ImportKind = 'json';
    const wouldUseTextBranch = isTextInput(kind);
    expect(wouldUseTextBranch).toBe(false);

    // 反向验证：ASCII 才是唯一文本分支
    expect(isTextInput('ascii')).toBe(true);
    expect(isTextInput('musicxml')).toBe(false);
  });
});

describe('importHelpers —— 文件体积守卫', () => {
  const MB = 1024 * 1024;

  it('阈值按格式取：XML 8MB、JSON 20MB，其余（MusicXML）走 XML 阈值', () => {
    expect(maxImportMb('json')).toBe(MAX_IMPORT_JSON_MB);
    expect(maxImportMb('musicxml')).toBe(MAX_IMPORT_XML_MB);
    expect(maxImportMb('ascii')).toBe(MAX_IMPORT_XML_MB);
    expect(MAX_IMPORT_XML_MB).toBe(8);
    expect(MAX_IMPORT_JSON_MB).toBe(20);
  });

  it('MusicXML：7.9MB 通过、8.1MB 拒绝、恰好 8MB 通过（> 比较）', () => {
    expect(isFileTooLarge('musicxml', 7.9 * MB)).toBe(false);
    expect(isFileTooLarge('musicxml', 8.1 * MB)).toBe(true);
    expect(isFileTooLarge('musicxml', 8 * MB)).toBe(false);
  });

  it('JSON：19.9MB 通过、20.1MB 拒绝、恰好 20MB 通过', () => {
    expect(isFileTooLarge('json', 19.9 * MB)).toBe(false);
    expect(isFileTooLarge('json', 20.1 * MB)).toBe(true);
    expect(isFileTooLarge('json', 20 * MB)).toBe(false);
  });

  // ── 字节级边界（QA 补充）：严格 `>` 语义 —— 恰好阈值通过，多 1 字节即拒绝 ──
  it('字节级边界：MusicXML 恰好 8MB 通过、8MB+1 字节拒绝（严格 >）', () => {
    expect(isFileTooLarge('musicxml', 8 * MB)).toBe(false);
    expect(isFileTooLarge('musicxml', 8 * MB + 1)).toBe(true);
  });

  it('字节级边界：JSON 恰好 20MB 通过、20MB+1 字节拒绝（严格 >）', () => {
    expect(isFileTooLarge('json', 20 * MB)).toBe(false);
    expect(isFileTooLarge('json', 20 * MB + 1)).toBe(true);
  });

  it('字节级边界：0 字节 / 极小文件一律通过', () => {
    expect(isFileTooLarge('musicxml', 0)).toBe(false);
    expect(isFileTooLarge('json', 1)).toBe(false);
  });

  it('ASCII 走文本、无文件体积概念，但也按 XML 阈值兜底（>8MB 拒绝）', () => {
    expect(isFileTooLarge('ascii', 8.1 * MB)).toBe(true);
  });
});

describe('importHelpers —— 超限文案（含具体数值）', () => {
  it('UI 实际使用的 COPY 文案必须含具体数值（不得退回旧的 50MB 泛化文案）', () => {
    expect(COPY.importXmlTooLarge).toContain('8MB');
    expect(COPY.importJsonTooLarge).toContain('20MB');
    // 这两条不应是旧的 50MB 通用文案
    expect(COPY.importXmlTooLarge).not.toBe(COPY.fileTooLarge);
    expect(COPY.importJsonTooLarge).not.toBe(COPY.fileTooLarge);
  });
});

describe('importHelpers —— successWarningMessage（MusicXML warnings 提示）', () => {
  it('无 warnings 时返回 null（不额外提示）', () => {
    expect(successWarningMessage(makeResult({ parsedMeasures: 4 }))).toBeNull();
    expect(successWarningMessage(makeResult({ parsedMeasures: 4, warnings: [] }))).toBeNull();
  });

  it('有 warnings 时收敛成一行文案，多条以「；」连接', () => {
    const msg = successWarningMessage(makeResult({ parsedMeasures: 8, warnings: ['反复记号已忽略'] }));
    expect(msg).toContain('反复记号已忽略');
    const multi = successWarningMessage(makeResult({ parsedMeasures: 8, warnings: ['反复记号已忽略', '和弦标记缺失'] }));
    expect(multi).toContain('反复记号已忽略；和弦标记缺失');
  });

  it('回归锁：MusicXML 成功路径恒 partial=false 但有 warnings，必须能提示', () => {
    // 复刻 musicXmlToTab 的成功返回形状：ok=true / partial=false / warnings 非空
    const r: ImportResult = { ok: true, partial: false, parsedMeasures: 6, warnings: [COPY.repeatIgnored] };
    expect(partialPromptMessage(r).message).toContain('成功解析 6 小节');
    expect(successWarningMessage(r)).not.toBeNull();
  });
});

describe('importHelpers —— partialPromptMessage', () => {
  it('有 failedAt：显示 +1 后的 1-based 小节号', () => {
    const r = makeResult({ parsedMeasures: 12, failedAt: 4 });
    const { title, message } = partialPromptMessage(r);
    expect(title).toBe('谱面部分解析成功');
    expect(message).toContain('成功解析 12 小节');
    expect(message).toContain('第 5 小节附近起无法识别');
  });

  it('无 failedAt：不出现「附近起无法识别」这句', () => {
    const r = makeResult({ parsedMeasures: 3 });
    const { message } = partialPromptMessage(r);
    expect(message).toContain('成功解析 3 小节');
    expect(message).not.toContain('无法识别');
  });

  it('有 warnings：逐条带「提示：」前缀列出', () => {
    const r = makeResult({ parsedMeasures: 8, warnings: ['和弦标记缺失', '反复记号已忽略'] });
    const { message } = partialPromptMessage(r);
    expect(message).toContain('提示：和弦标记缺失');
    expect(message).toContain('提示：反复记号已忽略');
  });

  it('reason 存在时一并展示（ASCII 部分字符未识别的场景）', () => {
    const r = makeResult({ parsedMeasures: 5, failedAt: 0, reason: '部分字符未识别，已按延音处理' });
    const { message } = partialPromptMessage(r);
    expect(message).toContain('第 1 小节附近起无法识别');
    expect(message).toContain('部分字符未识别，已按延音处理');
  });

  it('failedAt 为 0 而非 undefined 时也必须渲染（防止 falsy 判断漏掉第 1 小节）', () => {
    const r = makeResult({ parsedMeasures: 1, failedAt: 0 });
    expect(partialPromptMessage(r).message).toContain('第 1 小节附近起无法识别');
  });

  it('空 warnings 数组等同无 warnings', () => {
    const r = makeResult({ parsedMeasures: 2, warnings: [] });
    expect(partialPromptMessage(r).message).not.toContain('提示：');
  });
});

describe('importHelpers —— ImportKind 完整性', () => {
  it('三种 kind 均有确定的分流与阈值', () => {
    const kinds: ImportKind[] = ['json', 'musicxml', 'ascii'];
    for (const k of kinds) {
      expect(typeof isTextInput(k)).toBe('boolean');
      expect(maxImportMb(k)).toBeGreaterThan(0);
    }
  });
});
