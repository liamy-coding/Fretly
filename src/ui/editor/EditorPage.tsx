/**
 * 校对编辑器（架构 §2.10-54，T-23）：扒谱草稿校对。
 * 布局：波形时间轴（可关）→ 待确认进度条 → 六线谱（点选音符/小节）→
 * 右栏：待确认清单 / 音符属性 / 节奏模板 / 小节和弦。自动保存 + 撤销重做 + 入库。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useEditorStore } from '@/state/useEditorStore';
import { useAppStore } from '@/state/useAppStore';
import { jobRepo } from '@/storage/jobRepo';
import type { NoteId, Tab } from '@/types/tab';
import { TabCanvas } from '@/ui/tab/TabCanvas';
import {
  Waveform,
  RhythmLibrary,
  NoteInspector,
  PendingList,
  ChordEditorRow,
} from '@/ui/editor/EditorPanels';
import { Button, Card, IconButton, Progress, TextField, Spinner, EmptyState, Badge } from '@/ui/kit';
import { useHotkeys } from '@/ui/kit';

export default function EditorPage() {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const store = useEditorStore();
  const toast = useAppStore((s) => s.toast);
  const [peaks, setPeaks] = useState<[number, number][]>([]);
  const [loading, setLoading] = useState(true);
  const [showWave, setShowWave] = useState(true);
  const [titleDraft, setTitleDraft] = useState('');
  const draft = store.draft;

  // 打开任务草稿（支持 /transcribe/:jobId/edit）
  useEffect(() => {
    if (!jobId) return;
    setLoading(true);
    void (async () => {
      const ok = await store.openJobDraft(jobId as never);
      if (ok) {
        const p = await jobRepo.getPeaks(jobId as never);
        setPeaks(p ?? []);
        setTitleDraft(useEditorStore.getState().draft?.title ?? '');
      }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  useEffect(() => {
    if (draft) setTitleDraft(draft.title);
  }, [draft?.id, draft?.title]);

  const selection = store.selection;
  const measureIndexes = useMemo(() => (selection ? [selection.measureIndex] : []), [selection]);
  const selectedNote = useMemo(() => {
    if (!draft || !selection || selection.noteIds.length === 0) return null;
    const id = selection.noteIds[0];
    const note = draft.tracks[0]?.measures[selection.measureIndex]?.notes.find((n) => n.id === id);
    return note ? { note, measureIndex: selection.measureIndex } : null;
  }, [draft, selection]);

  useHotkeys(
    [
      { key: 'z', mod: true, shift: false, handler: () => store.undo() },
      { key: 'z', mod: true, shift: true, handler: () => store.redo() },
    ],
    [store.canUndo, store.canRedo],
  );

  const commitTitle = useCallback(() => {
    if (!draft) return;
    const t = titleDraft.trim();
    if (t && t !== draft.title) store.updateMeta({ title: t });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [titleDraft, draft?.id]);

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }

  if (!draft) {
    return (
      <div className="p-8">
        <EmptyState title="没有可校对的草稿" desc="该扒谱任务没有草稿（可能已入库或草稿被清理）。">
          <Button onClick={() => navigate('/transcribe')}>回扒谱页</Button>
        </EmptyState>
      </div>
    );
  }

  const progressPct = store.pendingTotal > 0 ? (1 - store.pending.length / store.pendingTotal) * 100 : 100;
  const hasPending = store.pending.length > 0;

  const onNoteClick = (noteId: string | null, mi: number) => {
    store.setSelection({ measureIndex: mi, noteIds: noteId ? [noteId as NoteId] : [] });
  };

  const doSaveToLibrary = () => {
    void (async () => {
      const saved = await store.saveToLibrary();
      if (saved) navigate(`/tab/${saved.id}`);
    })();
  };

  return (
    <div className="space-y-3 p-3 pb-24">
      {/* 顶栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" icon="back" onClick={() => navigate('/transcribe')}>
          返回
        </Button>
        <div className="flex items-center gap-1">
          <IconButton name="skipBack" label="撤销 (⌘Z)" disabled={!store.canUndo} onClick={() => store.undo()} />
          <IconButton name="skipFwd" label="重做 (⇧⌘Z)" disabled={!store.canRedo} onClick={() => store.redo()} />
        </div>
        <div className="mr-auto min-w-0 flex-1 sm:max-w-xs">
          <TextField
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            aria-label="曲名"
            className="font-semibold"
          />
        </div>
        <Badge tone={store.dirty ? 'amber' : 'success'}>{store.saving ? '保存中…' : store.dirty ? '有未保存修改' : store.lastSavedAt ? '已自动保存' : '仅本地草稿'}</Badge>
        <Button
          onClick={() => {
            void store.flush().then(() => toast('info', '已保存草稿'));
          }}
          variant="outline"
          disabled={!store.dirty}
        >
          保存
        </Button>
        <Button onClick={doSaveToLibrary} disabled={store.saving}>
          入库
        </Button>
      </div>

      {/* 待确认进度 */}
      <Card className="p-3">
        <div className="mb-1 flex items-center justify-between text-sm">
          <span className="font-medium">待确认进度</span>
          <span className="text-ink-soft">
            {hasPending ? `剩 ${store.pending.length} 处` : '全部已处理'}
          </span>
        </div>
        <Progress value={progressPct} />
        <p className="mt-1 text-xs text-ink-soft">
          低置信（&lt;45%）的音符与和弦需要你确认。点「接受」表示认可当前结果；黄底虚线即低置信音符。
        </p>
      </Card>

      {/* 波形 */}
      {showWave && (
        <Card className="p-2">
          <div className="flex items-center justify-between px-1">
            <span className="text-xs text-ink-soft">原音频波形</span>
            <button type="button" className="text-xs text-ink-soft hover:text-ink" onClick={() => setShowWave(false)}>
              隐藏
            </button>
          </div>
          <Waveform peaks={peaks} />
        </Card>
      )}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_280px]">
        {/* 六线谱 */}
        <div className="min-w-0 rounded-xl border border-line bg-surface p-3">
          <TabCanvas
            tab={draft as Tab}
            mode="editor"
            onNoteClick={onNoteClick}
            onSeek={(tick) => {
              // 编辑器点空白：定位到小节（无音频不播）
              const idx = Math.max(0, (draft?.tracks[0]?.measures.findIndex((m) => tick >= m.startTick && tick < m.startTick + m.ticks) ?? -1));
              if (idx >= 0) store.setSelection({ measureIndex: idx, noteIds: [] });
            }}
            selectedNoteId={selection?.noteIds[0] ?? null}
            highlightMeasure={selection?.measureIndex ?? null}
            showConfidence
            showFinger
          />
        </div>

        {/* 右栏 */}
        <aside className="space-y-3">
          <PendingList pending={store.pending} />
          {selectedNote && (
            <NoteInspector measureIndex={selectedNote.measureIndex} noteId={selectedNote.note.id} tab={draft as Tab} />
          )}
          {selection && !selectedNote && (
            <Card className="p-3">
              <div className="mb-1 flex items-center justify-between">
                <h3 className="text-sm font-semibold">第 {selection.measureIndex + 1} 小节</h3>
                <Button size="xs" variant="ghost" onClick={() => store.setSelection(null)}>
                  取消选择
                </Button>
              </div>
              <ChordEditorRow measureIndex={selection.measureIndex} tab={draft as Tab} />
            </Card>
          )}
          <RhythmLibrary tab={draft as Tab} measureIndexes={measureIndexes} />
        </aside>
      </div>
    </div>
  );
}
