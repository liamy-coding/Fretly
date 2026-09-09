/**
 * 编辑器右侧面板（架构 §2.10-55，T-23）：节奏型模板库、音符属性、和弦/低置信候选。
 * 全部通过 useEditorStore 进行可撤销编辑。
 */
import type { Note, Tab } from '@/types/tab';
import type { PendingItem } from '@/types/app';
import { useEditorStore } from '@/state/useEditorStore';
import { useAppStore } from '@/state/useAppStore';
import { PATTERN_BY_ID, RHYTHM_PATTERNS } from '@/data/rhythmPatterns';
import { fretToMidi } from '@/core/fretboard';
import { chordPosition } from '@/ui/charts';
import { Button, Badge, Card, Slider } from '@/ui/kit';
import { ChordDiagram } from '@/ui/charts';

// ── 波形时间轴（峰值条）──────────────────────────────────────────
export function Waveform({ peaks, height = 48 }: { peaks: [number, number][]; height?: number }) {
  if (peaks.length === 0) {
    return <div className="h-10 rounded-lg bg-gray-50 text-center text-xs leading-10 text-gray-300">无波形数据</div>;
  }
  const step = Math.max(1, Math.floor(peaks.length / 800));
  const sliced: [number, number][] = [];
  for (let i = 0; i < peaks.length; i += step) sliced.push(peaks[i]);
  return (
    <svg width="100%" viewBox={`0 0 ${sliced.length} ${100}`} preserveAspectRatio="none" style={{ height }} className="w-full">
      {sliced.map((p, i) => {
        const top = 50 + (p[0] ?? 0) * 45;
        const bottom = 50 + (p[1] ?? 0) * 45;
        return <rect key={i} x={i} y={top} width={1} height={Math.max(1, bottom - top)} fill="#2563eb" opacity={0.8} />;
      })}
    </svg>
  );
}

// ── 节奏型模板库 ─────────────────────────────────────────────────
export function RhythmLibrary({ tab, measureIndexes }: { tab: Tab; measureIndexes: number[] }) {
  const applyPattern = useEditorStore((s) => s.applyPattern);
  const toast = (t: 'info' | 'warn' | 'success', text: string) => useAppStore.getState().toast(t, text);
  const allCount = tab.tracks[0]?.measures.length ?? 0;
  const allIndexes = tab.tracks[0]!.measures.map((m) => m.index);
  const scopeText = measureIndexes.length === allCount ? '整曲' : measureIndexes.length ? `${measureIndexes.length} 个小节` : '未选';
  const applyTo = (id: string) => {
    if (measureIndexes.length > 0) {
      applyPattern(measureIndexes, id);
      toast('success', `已应用「${PATTERN_BY_ID[id]?.name ?? id}」到所选小节`);
    } else {
      toast('warn', '请先在谱面点选要替换的小节');
    }
  };
  return (
    <Card className="p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">节奏型模板</h3>
        <Badge>{scopeText}</Badge>
      </div>
      <p className="mb-2 text-xs text-ink-soft">
        应用范围 {scopeText}（共 {allCount} 小节）。先点选谱面小节，或用下方「整曲」按钮。
      </p>
      <ul className="fretly-scroll max-h-72 space-y-1 overflow-y-auto">
        {RHYTHM_PATTERNS.map((p) => {
          const patternName = PATTERN_BY_ID[p.id]?.name ?? p.name;
          return (
            <li key={p.id} className="flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-black/5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-xs font-medium">
                  <Badge tone={p.type === 'strum' ? 'brand' : 'neutral'}>{p.type === 'strum' ? '扫' : '分解'}</Badge>
                  <span>{patternName}</span>
                  <span className="text-[10px] text-gray-400">
                    {p.timeSignature[0]}/{p.timeSignature[1]}
                  </span>
                </div>
                <div className="font-mono text-[10px] text-ink-soft">{p.pattern}</div>
                <div className="truncate text-[10px] text-gray-400">{p.desc}</div>
              </div>
              <Button size="xs" variant="outline" onClick={() => applyTo(p.id)}>
                应用
              </Button>
            </li>
          );
        })}
      </ul>
      <div className="mt-2 flex gap-2">
        <Button
          size="xs"
          variant="subtle"
          onClick={() => {
            const first = allIndexes[0];
            if (first === undefined) return;
            const id = PATTERN_BY_ID[tab.rhythmPattern.id ?? ''] ? (tab.rhythmPattern.id as string) : RHYTHM_PATTERNS[0].id;
            applyPattern(allIndexes, id);
            toast('success', `已用「${PATTERN_BY_ID[id]?.name ?? id}」替换整曲节奏`);
          }}
        >
          整曲用默认节奏
        </Button>
      </div>
    </Card>
  );
}

// ── 音符属性 ─────────────────────────────────────────────────────
export function NoteInspector({
  measureIndex,
  noteId,
  tab,
}: {
  measureIndex: number;
  noteId: string;
  tab: Tab;
}) {
  const setNote = useEditorStore((s) => s.setNote);
  const deleteNote = useEditorStore((s) => s.deleteNote);
  const setSelection = useEditorStore((s) => s.setSelection);
  const note = tab.tracks[0]?.measures[measureIndex]?.notes.find((n) => n.id === noteId);
  if (!note) return null;
  const midi = fretToMidi(note.string, note.fret);

  return (
    <Card className="p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">音符属性</h3>
        <span className="font-mono text-xs text-brand">MIDI {midi}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <label className="block">
          <span className="text-ink-soft">弦</span>
          <select
            className="mt-0.5 w-full rounded-lg border border-line px-1.5 py-1"
            value={note.string}
            onChange={(e) => setNote(note.id, { string: Number(e.target.value) as Note['string'] })}
          >
            {[1, 2, 3, 4, 5, 6].map((s) => (
              <option key={s} value={s}>
                {s} 弦
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-ink-soft">品</span>
          <input
            type="number"
            min={0}
            max={24}
            className="mt-0.5 w-full rounded-lg border border-line px-1.5 py-1"
            value={note.fret}
            onChange={(e) => setNote(note.id, { fret: Number(e.target.value) })}
          />
        </label>
        <label className="block">
          <span className="text-ink-soft">指法</span>
          <select
            className="mt-0.5 w-full rounded-lg border border-line px-1.5 py-1"
            value={note.finger ?? ''}
            onChange={(e) => setNote(note.id, { finger: e.target.value ? (Number(e.target.value) as 1 | 2 | 3 | 4) : null })}
          >
            <option value="">—</option>
            {[1, 2, 3, 4].map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-ink-soft">拨弦</span>
          <select
            className="mt-0.5 w-full rounded-lg border border-line px-1.5 py-1"
            value={note.stroke ?? ''}
            onChange={(e) => setNote(note.id, { stroke: (e.target.value || null) as Note['stroke'] })}
          >
            <option value="">—</option>
            <option value="D">下扫</option>
            <option value="U">上扫</option>
            <option value="P">拨片</option>
          </select>
        </label>
      </div>
      <div className="mt-2">
        <span className="text-xs text-ink-soft">时长（tick）：</span>
        <Slider min={120} max={4800} step={60} value={note.durationTick} onChange={(v) => setNote(note.id, { durationTick: v })} />
        <span className="font-mono text-xs text-ink-soft">{note.durationTick}</span>
      </div>
      <div className="mt-3 flex gap-2">
        <Button
          size="xs"
          variant="danger"
          icon="trash"
          onClick={() => {
            deleteNote(note.id);
            setSelection({ measureIndex, noteIds: [] });
          }}
        >
          删除
        </Button>
      </div>
    </Card>
  );
}

// ── 低置信待确认清单 ─────────────────────────────────────────────
export function PendingList({ pending }: { pending: PendingItem[] }) {
  const confirmPending = useEditorStore((s) => s.confirmPending);
  const confirmAllPending = useEditorStore((s) => s.confirmAllPending);
  if (pending.length === 0) return null;
  return (
    <Card className="p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">待确认 {pending.length}</h3>
        <Button size="xs" onClick={() => confirmAllPending()}>
          全部接受
        </Button>
      </div>
      <ul className="fretly-scroll max-h-52 space-y-1 overflow-y-auto">
        {pending.slice(0, 30).map((p) => (
          <li key={p.id} className="flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-black/5">
            <span className="font-mono text-[10px] text-ink-soft">
              {p.kind === 'note' ? '音' : p.kind === 'chord' ? '和弦' : '节奏'}
            </span>
            <span className="text-xs">第 {p.measureIndex + 1} 小节</span>
            <span className="ml-auto rounded bg-amber-50 px-1 text-[10px] text-amber-700">
              {Math.round(p.confidence * 100)}%
            </span>
            <Button size="xs" variant="subtle" onClick={() => confirmPending([p.id])}>
              接受
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ── 和弦替换候选 ─────────────────────────────────────────────────
export function ChordEditorRow({ measureIndex, tab }: { measureIndex: number; tab: Tab }) {
  const setMeasureChord = useEditorStore((s) => s.setMeasureChord);
  const measure = tab.tracks[0]?.measures[measureIndex];
  if (!measure) return null;
  return (
    <div className="mt-2 space-y-2">
      {measure.chords.map((c, i) => (
        <div key={`${c.tick}-${i}`} className="flex items-center gap-2 rounded-lg bg-canvas p-2">
          <ChordDiagram diagram={c.diagram} name={c.name} size="sm" />
          <div className="min-w-0 text-xs">
            <div className="truncate font-medium">{c.name}</div>
            <div className="text-gray-400">tick {c.tick} · 置信 {Math.round(c.confidence * 100)}%</div>
          </div>
          <div className="ml-auto flex gap-1">
            <button
              type="button"
              title="删除该和弦标记"
              className="text-gray-300 hover:text-red-600"
              onClick={() => setMeasureChord(measureIndex, { name: '', diagram: 'xxxxxx', tick: c.tick, confidence: 1 })}
            >
              ×
            </button>
          </div>
        </div>
      ))}
      <div className="flex gap-2 text-xs">
        <input
          className="w-20 rounded-lg border border-line px-1.5 py-1"
          placeholder="和弦名"
          id={`chord-add-${measureIndex}`}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const name = (e.target as HTMLInputElement).value.trim();
              if (!name) return;
              setMeasureChord(measureIndex, { name, diagram: defaultDiagram(name), confidence: 1 });
              (e.target as HTMLInputElement).value = '';
            }
          }}
        />
        <Button size="xs" variant="outline" onClick={() => useEditorStore.getState().setSelection(null)}>
          关闭面板
        </Button>
      </div>
    </div>
  );
}

function defaultDiagram(_name: string): string {
  // 默认开放（不发声占位）：六根弦全 ×，由用户用和弦面板修正
  return 'xxxxxx';
}

export function chordMidiNames(diagram: string): number[] {
  return chordPosition(diagram).filter((p) => p.fret >= 0).map((p) => fretToMidi(p.string as 1 | 2 | 3 | 4 | 5 | 6, p.fret));
}

export { PATTERN_BY_ID };
