/**
 * 导入弹窗的纯逻辑助手（T-精修）。
 *
 * 这里只放**无副作用、无 React 依赖**的纯函数，便于单测：
 *  - 输入源分流（只有 ASCII 走文本框，其余一律走文件）
 *  - 文件体积守卫
 *  - partial（部分解析）确认弹窗的标题 / 正文文案
 *
 * 注意：importers.ts 中 `jsonImporter.fromText === true`，但 UI **不得**用它做分流判断，
 * 否则会出现「JSON 走文本框、文件永远导不进来」的 P0 bug。分流统一走 isTextInput()。
 */
import { COPY, MAX_IMPORT_JSON_MB, MAX_IMPORT_XML_MB } from '@/core/constants';
import type { ImportResult } from '@/types/app';

/** 导入弹窗支持的输入格式（与 Segmented 选项一致） */
export type ImportKind = 'json' | 'musicxml' | 'ascii';

/**
 * 输入源分流：**只有 ASCII 走粘贴文本，JSON / MusicXML 一律走文件**。
 *
 * 渲染与提交必须共用此函数，避免两套判断源不一致（P0 回归锁）。
 */
export function isTextInput(kind: ImportKind): boolean {
  return kind === 'ascii';
}

/** 按格式返回体积上限（MB）：MusicXML 为 XML，体积上限比 JSON 更保守 */
export function maxImportMb(kind: ImportKind): number {
  return kind === 'json' ? MAX_IMPORT_JSON_MB : MAX_IMPORT_XML_MB;
}

/**
 * 文件体积守卫。
 *
 * 注意用 `>` 比较：恰好等于阈值的文件视为**合法**（8.0MB 通过，8.1MB 拒绝）。
 */
export function isFileTooLarge(kind: ImportKind, sizeBytes: number): boolean {
  return sizeBytes > maxImportMb(kind) * 1024 * 1024;
}

/**
 * partial 确认弹窗文案：标题固定，正文按「小节数 / 起始失败位置 / warnings / reason」拼装。
 *
 * @param result 解析结果；`failedAt` 为 0-based 小节索引，展示时 +1。
 */
export function partialPromptMessage(result: ImportResult): { title: string; message: string } {
  const title = '谱面部分解析成功';
  const lines: string[] = [];

  lines.push(`成功解析 ${result.parsedMeasures} 小节`);

  if (result.failedAt !== undefined && result.failedAt !== null) {
    lines.push(`第 ${result.failedAt + 1} 小节附近起无法识别`);
  }

  const warnings = result.warnings ?? [];
  if (warnings.length > 0) {
    lines.push(...warnings.map((w) => `提示：${w}`));
  }

  if (result.reason) {
    lines.push(result.reason);
  }

  lines.push(COPY.partialAsk);

  return { title, message: lines.join('\n') };
}

/**
 * 导入成功但携带 warnings 时的提示文案（MusicXML 的「反复记号已忽略」等）。
 *
 * MusicXML 路径恒 `partial: false`，却有 warnings；这些信息若不展示，用户会误以为
 * 谱面完整。这里把 warnings 收敛成一行 toast 文案，供完全成功路径提示。
 *
 * @returns 需提示的文案；无 warnings 时返回 null（调用方不提示）。
 */
export function successWarningMessage(result: ImportResult): string | null {
  const warnings = result.warnings ?? [];
  if (warnings.length === 0) return null;
  return `导入完成，但需注意：${warnings.join('；')}`;
}
