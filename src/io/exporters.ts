/**
 * 导出：JSON / ASCII / PDF（打印）（PRD A-06，架构 T-12）。
 * 三个纯函数 + 三个触发浏览器行为的动作（后者不单测）。
 */
import type { Tab } from '@/types/tab';
import { asciiColsPerMeasure } from '@/io/importers';
import { ASCII_COL_TICKS } from '@/io/importers';
import { STRING_NUMBERS } from '@/core/fretboard';

const LABELS: Record<number, string> = { 1: 'e', 2: 'B', 3: 'G', 4: 'D', 5: 'A', 6: 'E' };
const MEASURES_PER_LINE = 4;

/** JSON 导出（可被本产品重新导入，往返无损） */
export function tabToJson(tab: Tab): string {
  return JSON.stringify(tab, null, 2);
}

/**
 * ASCII 六线谱导出。一列 = 120 ticks，4/4 一小节 16 列 / 3/4 一小节 12 列，
 * 每行 4 小节，行尾用 `|` 收口 —— 与 asciiImporter 的宽松解析互为逆操作。
 */
export function tabToAscii(tab: Tab): string {
  const ts = tab.timeSignature;
  const cols = asciiColsPerMeasure(ts);
  const measures = tab.tracks[0]?.measures ?? [];
  const lines: string[] = [tab.title, `${tab.artist} · 调 ${tab.key} · BPM ${tab.bpm} · ${ts[0]}/${ts[1]}`, ''];

  for (let start = 0; start < measures.length; start += MEASURES_PER_LINE) {
    const chunk = measures.slice(start, start + MEASURES_PER_LINE);
    for (const string of STRING_NUMBERS) {
      const cells: string[] = [];
      for (const measure of chunk) {
        const grid = new Array<string>(cols).fill('-');
        for (const note of measure.notes) {
          if (note.string !== string) continue;
          const col = Math.min(cols - 1, Math.max(0, Math.round(note.startTick / ASCII_COL_TICKS)));
          const digits = String(Math.max(0, note.fret));
          for (let i = 0; i < digits.length && col + i < cols; i += 1) grid[col + i] = digits.charAt(i);
        }
        cells.push(grid.join(''));
      }
      lines.push(`${LABELS[string]}|${cells.join('|')}|`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function download(filename: string, content: string, mime: string): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function safeFileName(title: string): string {
  // 去掉 Windows / macOS 文件名非法字符
  return title.replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名';
}

export function exportJson(tab: Tab): void {
  download(`${safeFileName(tab.title)}.fretly.json`, tabToJson(tab), 'application/json');
}

export function exportAscii(tab: Tab): void {
  download(`${safeFileName(tab.title)}.txt`, tabToAscii(tab), 'text/plain');
}

/**
 * PDF 导出：注入 `printing` 类（样式见 styles/index.css 的 @media print），
 * 隐藏导航 / 控制栏 / 右栏，六线谱黑白且按小节避免分页截断。
 */
export function exportPdf(): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const root = document.documentElement;
  root.classList.add('printing');
  const cleanup = () => {
    root.classList.remove('printing');
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.print();
  // 部分浏览器不触发 afterprint，兜底 3s 后移除
  setTimeout(cleanup, 3000);
}
