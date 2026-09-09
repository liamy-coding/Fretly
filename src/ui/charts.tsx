/**
 * 纯展示图表（架构 §2.10-48，T-18）：和弦指位图、速度柱/折线、打卡日历。
 * 全部为纯函数组件（SVG），不触碰 DOM/音频/存储。
 */
import type { ReactNode } from 'react';
import type { ProgressiveState } from '@/core/progressive';
import type { RoundRecord } from '@/core/progressive';
import { parseDiagram } from '@/core/fretboard';

export function chordPosition(diagram: string): { string: number; fret: number }[] {
  return parseDiagram(diagram);
}

/**
 * 渲染列号：positions[i]（i=0→1弦 … i=5→6弦）→ SVG 列（0=最左）。
 * 物理方向 6 弦（低音）最左 / 1 弦（高音）最右 → col = 5 - i。
 * ★ 纯渲染镜像，不是 `6 - x` 的弦号↔图索引换算（那类只允许在 fretboard.ts）。
 */
export function chordStringColumn(i: number): number {
  return 5 - i;
}

// ── 和弦指位图 ────────────────────────────────────────────────────
export function ChordDiagram({
  diagram,
  name = '',
  size = 'md',
}: {
  diagram: string;
  name?: string;
  size?: 'sm' | 'md';
}) {
  const W = size === 'sm' ? 64 : 84;
  const H = size === 'sm' ? 82 : 108;
  const positions = parseDiagram(diagram);
  if (positions.length === 0) return null;
  const frets = positions.map((p) => p.fret);
  const maxFret = Math.max(...frets, 0);
  const base = maxFret >= 5 ? Math.max(1, Math.min(...frets.filter((f) => f > 0))) : 0;
  const rows = 5; // 显示 5 品窗
  const mx = 12;
  const top = 18;
  const sGap = (W - mx * 2) / 5;
  const fGap = (H - top - 16) / rows;
  const stringCol = (i: number) => mx + chordStringColumn(i) * sGap;
  const fretRow = (f: number) => top + (f - base + 0.5) * fGap;
  const muted = (i: number) => frets[i] === -1;
  const open = (i: number) => frets[i] === 0;

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="text-ink" role="img" aria-label={`${name} 和弦指位`}>
      {/* 品柱（竖线 = 弦） */}
      {Array.from({ length: 6 }, (_, i) => (
        <line key={`s${i}`} x1={stringCol(i)} y1={top} x2={stringCol(i)} y2={H - 12} stroke="#94a3b8" strokeWidth={i === 0 || i === 5 ? 1.4 : 1} />
      ))}
      {/* 弦（横线 = 品） */}
      {base === 0 && (
        <line x1={mx} y1={top} x2={mx + sGap * 5} y2={top} stroke="#334155" strokeWidth={3.4} />
      )}
      {Array.from({ length: rows + 1 }, (_, r) => {
        if (base === 0 && r === 0) return null;
        return (
          <line
            key={`f${r}`}
            x1={mx}
            y1={top + r * fGap}
            x2={mx + sGap * 5}
            y2={top + r * fGap}
            stroke="#cbd5e1"
            strokeWidth={1}
          />
        );
      })}
      {base > 0 && (
        <text x={mx - 8} y={top + fGap * 0.5} fontSize={9} textAnchor="middle" fill="#64748b">
          {base}
        </text>
      )}
      {/* 指位点 */}
      {positions.map((p, i) => {
        if (muted(i) || open(i)) return null;
        const y = fretRow(p.fret);
        return <circle key={i} cx={stringCol(i)} cy={y} r={sGap * 0.3} fill="#2563eb" />;
      })}
      {/* x / o */}
      {positions.map((p, i) => {
        if (muted(i)) {
          return (
            <text key={`m${i}`} x={stringCol(i)} y={top - 7} fontSize={10} textAnchor="middle" fill="#ef4444" fontWeight={700}>
              ×
            </text>
          );
        }
        if (open(i)) {
          return (
            <text key={`o${i}`} x={stringCol(i)} y={top - 7} fontSize={10} textAnchor="middle" fill="#334155" fontWeight={700}>
              ○
            </text>
          );
        }
        return null;
      })}
      {name && (
        <text x={W / 2} y={H - 2} fontSize={size === 'sm' ? 9 : 11} textAnchor="middle" fontWeight={600}>
          {name}
        </text>
      )}
    </svg>
  );
}

// ── 渐进加速：每轮成绩柱状图 ─────────────────────────────────────
export function BpmBars({ state }: { state: ProgressiveState }) {
  const rounds = state.rounds;
  if (rounds.length === 0) return null;
  const max = Math.max(state.targetBpm, ...rounds.map((r) => r.bpm), 1);
  const H = 72;
  const W = Math.max(120, rounds.length * 22 + 24);
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      {rounds.map((r: RoundRecord, i) => {
        const h = Math.max(3, (r.bpm / max) * (H - 18));
        const x = 12 + i * 22;
        return (
          <g key={`${i}-${r.index}`}>
            <rect x={x} y={H - 8 - h} width={14} height={h} rx={2} fill={r.passed ? '#16a34a' : '#f59e0b'} />
            {i === rounds.length - 1 && (
              <text x={x + 7} y={H - 8 - h - 3} fontSize={9} textAnchor="middle" fill="#64748b">
                {r.bpm}
              </text>
            )}
          </g>
        );
      })}
      <line x1={4} y1={H - 9} x2={W - 4} y2={H - 9} stroke="#cbd5e1" />
    </svg>
  );
}

// ── 速度折线 ──────────────────────────────────────────────────────
export function TempoLine({
  points,
  targetBpm,
}: {
  /** 按时间升序；label 可为日期 */
  points: { label: string; bpm: number }[];
  targetBpm?: number;
}) {
  if (points.length < 1) return null;
  const W = 300;
  const H = 96;
  const pad = 8;
  const maxY = Math.max(targetBpm ?? 0, ...points.map((p) => p.bpm), 10) * 1.15;
  const x = (i: number) => pad + (points.length === 1 ? W / 2 : (i * (W - pad * 2)) / (points.length - 1));
  const y = (bpm: number) => H - pad - ((H - pad * 2) * bpm) / maxY;
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.bpm).toFixed(1)}`).join(' ');
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="h-24 w-full">
      {[0.25, 0.5, 0.75, 1].map((g) => {
        const yy = pad + (H - pad * 2) * (1 - g);
        return <line key={g} x1={pad} y1={yy} x2={W - pad} y2={yy} stroke="#f1f5f9" />;
      })}
      {targetBpm && (
        <line
          x1={pad}
          y1={y(targetBpm)}
          x2={W - pad}
          y2={y(targetBpm)}
          stroke="#f59e0b"
          strokeDasharray="4 3"
          strokeWidth={1}
        />
      )}
      <path d={d} fill="none" stroke="#2563eb" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(p.bpm)} r={2.6} fill="#2563eb" />
      ))}
    </svg>
  );
}

// ── 打卡日历（近 12 周热力图）────────────────────────────────────
export function CalendarHeatmap({
  minutesByDay,
  todayKey,
}: {
  /** dateKey 'YYYY-MM-DD' → 分钟数 */
  minutesByDay: Record<string, number>;
  todayKey: string;
}) {
  const cell = 11;
  const gap = 2;
  const cols = 13;
  const rows = 7;
  const W = cols * (cell + gap) + 4;
  const H = rows * (cell + gap) + 4;
  const dayKey = (offset: number): string => {
    const [y, m, d] = todayKey.split('-').map(Number);
    const date = new Date(y, m - 1, d + offset);
    const mm = `${date.getMonth() + 1}`.padStart(2, '0');
    const dd = `${date.getDate()}`.padStart(2, '0');
    return `${date.getFullYear()}-${mm}-${dd}`;
  };
  const dow = new Date(todayKey + 'T00:00:00').getDay(); // 0 = Sun
  // 行 0..6 = 周一..周日；当前周一在最后一列
  const mondayOffset = -((dow + 6) % 7);
  const firstColOffset = mondayOffset - (cols - 1) * 7;

  const color = (minutes: number | undefined): string => {
    if (!minutes || minutes <= 0) return '#f1f5f9';
    if (minutes < 15) return '#dbeafe';
    if (minutes < 45) return '#93c5fd';
    if (minutes < 90) return '#3b82f6';
    return '#1d4ed8';
  };

  const boxes: ReactNode[] = [];
  for (let col = 0; col < cols; col += 1) {
    for (let row = 0; row < rows; row += 1) {
      const key = dayKey(firstColOffset + col * rows + row);
      const minutes = minutesByDay[key];
      boxes.push(
        <rect
          key={key}
          x={2 + col * (cell + gap)}
          y={2 + row * (cell + gap)}
          width={cell}
          height={cell}
          rx={2}
          fill={color(minutes)}
        >
          <title>{`${key}: ${minutes ?? 0} 分钟`}</title>
        </rect>,
      );
    }
  }

  return (
    <div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        {boxes}
      </svg>
      <div className="mt-1 flex items-center gap-1 text-[10px] text-gray-400">
        <span>少</span>
        {['#f1f5f9', '#dbeafe', '#93c5fd', '#3b82f6', '#1d4ed8'].map((c) => (
          <span key={c} className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: c }} />
        ))}
        <span>多</span>
      </div>
    </div>
  );
}
