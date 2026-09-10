/**
 * 练习页（架构 §2.10-50，T-21）：加载曲谱 → practiceController.loadTab；
 * 播放/暂停/变速/A-B/节拍器/示范/渐进加速；六线谱 + 右栏和弦预告 + 难点标记。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Tab, TabId } from '@/types/tab';
import { useLibraryStore } from '@/state/useLibraryStore';
import { practiceController } from '@/state/practiceController';
import { usePracticeStore, type PracticeViewMode } from '@/state/usePracticeStore';
import { useAppStore } from '@/state/useAppStore';
import { measureStartTick } from '@/core/tick';
import { COPY } from '@/core/constants';
import { TabCanvas } from '@/ui/tab/TabCanvas';
import { ROW_H } from '@/ui/tab/tabRender';
import { ChordDiagram } from '@/ui/charts';
import PracticeToolbar from '@/ui/practice/PracticeToolbar';
import ProgressivePanel from '@/ui/practice/ProgressivePanel';
import { Button, EmptyState, Icon, Segmented, Spinner, cn } from '@/ui/kit';

export default function PracticePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const loadMeta = useLibraryStore((s) => s.loadMeta);
  const toast = useAppStore((s) => s.toast);
  const viewMode = usePracticeStore((s) => s.viewMode);
  const setViewMode = usePracticeStore((s) => s.setViewMode);
  const currentMeasure = usePracticeStore((s) => s.currentMeasure);
  const markers = usePracticeStore((s) => s.markers);
  const session = usePracticeStore((s) => s.session);
  const showMarkers = usePracticeStore((s) => s.showMarkers);
  const setShowMarkers = usePracticeStore((s) => s.setShowMarkers);
  const [tab, setTab] = useState<Tab | null>(null);
  const [loading, setLoading] = useState(true);
  const [focusDone, setFocusDone] = useState(false);
  /**
   * 跨层「强制恢复跟随」信号（架构 §1）：+1 触发。
   * 非零初值以覆盖 TabCanvas 重挂载场景（viewMode 切走再切回）。
   */
  const [followNonce, setFollowNonce] = useState(1);
  const bumpFollow = () => setFollowNonce((n) => n + 1);

  // 跟随状态镜像（仅用于页头可选展示；不回传给 TabCanvas，避免 setState 回环）
  const [, setFollowEnabled] = useState(true);

  // 加载曲谱
  useEffect(() => {
    let disposed = false;
    if (!id) return;
    setLoading(true);
    void (async () => {
      try {
        const t = await loadMeta(id as TabId);
        if (disposed) return;
        if (!t) {
          toast('error', '曲谱不存在或已删除');
          navigate('/library');
          return;
        }
        setTab(t);
        practiceController.loadTab(t);
        bumpFollow();
      } catch (e) {
        toast('error', e instanceof Error ? e.message : '加载失败');
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // 离开时结束会话 + 停掉音频
  useEffect(() => {
    return () => {
      practiceController.pause();
      practiceController.endSession();
    };
  }, []);

  // 支持 /practice/:id?focus=N 定位难点
  useEffect(() => {
    if (!tab || focusDone) return;
    const raw = params.get('focus');
    const measureIndex = raw !== null ? Number(raw) : NaN;
    if (!Number.isFinite(measureIndex)) return;
    const marker = tab.markers.find((m) => m.measure === measureIndex);
    setFocusDone(true);
    if (marker) {
      practiceController.focusMarker(marker);
    } else {
      practiceController.addMarker(measureIndex, '从档案跳转');
      practiceController.focusMarker({
        id: `focus-${measureIndex}-${Date.now()}`,
        measure: measureIndex,
        note: '从档案跳转',
        createdAt: new Date().toISOString(),
        loopCount: 0,
      });
    }
    // 焦点跳转后强制恢复跟随（PRD §5.3）
    bumpFollow();
    toast('info', `已定位到第 ${measureIndex + 1} 小节（60% 速度循环）`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, focusDone]);

  const upcoming = useMemo(() => {
    if (!tab) return [];
    const measures = tab.tracks[0]?.measures ?? [];
    const out: { index: number; name: string; diagram: string; confidence: number }[] = [];
    // 「接下来」应从**下一小节**开始预告，而非把当前小节也算进去（否则看起来延迟一小节）
    const start = Math.min(measures.length, currentMeasure + 1);
    for (let m = start; m < Math.min(measures.length, start + 4); m += 1) {
      const measure = measures[m];
      const chord = measure.chords[0];
      out.push({
        index: m,
        name: chord?.name ?? '—',
        diagram: chord?.diagram ?? '',
        confidence: chord?.confidence ?? 1,
      });
    }
    return out;
  }, [tab, currentMeasure]);

  const onSeek = (tick: number) => {
    practiceController.seek(tick);
    bumpFollow();
  };

  const onNoteClick = (noteId: string | null, measureIndex: number) => {
    if (!tab || !noteId) return;
    const note = tab.tracks[0]?.measures[measureIndex]?.notes.find((n) => n.id === noteId);
    if (note) {
      practiceController.previewNote(note.string, note.fret);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }

  if (!tab) {
    return (
      <div className="p-8">
        <EmptyState title="无法开始练习" desc="没有可用的曲谱数据。">
          <Button onClick={() => navigate('/library')}>回谱库</Button>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3 pb-24">
      {/* 页头 */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" icon="back" onClick={() => navigate('/library')}>
          返回
        </Button>
        <div className="min-w-0">
          <h1 className="truncate text-base font-bold">{tab.title}</h1>
          <p className="truncate text-xs text-ink-soft">
            {tab.artist} · ♩ {tab.bpm} · 调 {tab.key} · {COPY.capoLabel} {tab.capo === 0 ? COPY.capoNone : tab.capo} ·
            拍号 {tab.timeSignature[0]}/{tab.timeSignature[1]}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Segmented<PracticeViewMode>
            value={viewMode}
            onChange={setViewMode}
            options={[
              { value: 'tab', label: '六线谱' },
              { value: 'chords', label: '和弦' },
              { value: 'listen', label: '听' },
            ]}
          />
          <button
            type="button"
            onClick={() => {
              const m = usePracticeStore.getState().currentMeasure;
              practiceController.addMarker(m);
              toast('success', `已把第 ${m + 1} 小节标为难点`);
            }}
            className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-ink-soft hover:text-ink"
          >
            <Icon name="flag" size={13} />
            标难点
          </button>
        </div>
      </div>

      <PracticeToolbar tab={tab} onResetFollow={bumpFollow} />

      {session.active && (
        <div className="flex flex-wrap gap-2 text-xs text-ink-soft">
          <span>会话 {Math.floor(session.effectiveSeconds / 60)}:{String(Math.floor(session.effectiveSeconds % 60)).padStart(2, '0')}</span>
          <span>· 已过 {session.passedRounds}/{session.rounds} 轮</span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_240px]">
        {/* 主区（单行谱面高度，不使用两行 min-h 以免大片留白） */}
        <div className="min-w-0 rounded-xl border border-line bg-surface p-3" style={{ minHeight: ROW_H + 24 }}>
          {viewMode === 'tab' && (
            <TabCanvas
              tab={tab}
              mode="practice"
              playheadTick={() => practiceController.currentTick}
              loop={usePracticeStore.getState().loop}
              onSeek={onSeek}
              onNoteClick={onNoteClick}
              showFinger={useAppStore.getState().settings.showFingerNumbers}
              singleRow
              follow
              onFollowChange={setFollowEnabled}
              resetNonce={followNonce}
            />
          )}
          {viewMode === 'chords' && (
            <div className="space-y-2">
              {(tab.tracks[0]?.measures ?? []).map((m, i) => (
                <button
                  key={m.index}
                  type="button"
                  onClick={() => practiceController.seek(measureStartTick(m.index, tab.timeSignature))}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-black/5',
                    i === currentMeasure && 'bg-brand-soft',
                  )}
                >
                  <span className="w-8 text-right font-mono text-xs text-ink-soft">{i + 1}</span>
                  <span className="w-16 font-semibold">{m.chords[0]?.name ?? '—'}</span>
                  {m.sectionLabel && <span className="text-xs text-ink-soft">{m.sectionLabel}</span>}
                </button>
              ))}
            </div>
          )}
          {viewMode === 'listen' && (
            <EmptyState icon="practice" title="聆听模式" desc="播放示范音轨，专注听节奏与换和弦位置。可在控制条调示范音量。" />
          )}
        </div>

        {/* 右栏 */}
        <aside className="space-y-3">
          <div className="rounded-xl border border-line bg-surface p-3">
            <h3 className="mb-2 text-sm font-semibold">接下来</h3>
            <div className="space-y-3">
              {upcoming.map((u, i) => (
                <div key={`${u.index}-${i}`} className={cn('flex items-center gap-2', i === 0 && 'rounded-lg bg-brand-soft p-1')}>
                  <span className="w-5 text-right font-mono text-xs text-ink-soft">{u.index + 1}</span>
                  <ChordDiagram diagram={u.diagram} name={u.name} size="sm" />
                  {u.confidence < 0.45 && <span className="text-xs text-amber" title="低置信和弦">!</span>}
                </div>
              ))}
              {upcoming.length === 0 && <p className="text-xs text-ink-soft">没有更多小节</p>}
            </div>
          </div>

          <ProgressivePanel tab={tab} />

          <div className="rounded-xl border border-line bg-surface p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold">难点标记</h3>
              <button type="button" className="text-xs text-ink-soft hover:text-ink" onClick={() => setShowMarkers(!showMarkers)}>
                {showMarkers ? '收起' : '展开'}
              </button>
            </div>
            {showMarkers && markers.length === 0 ? (
              <p className="text-xs text-ink-soft">在练习中把难小节标成难点，之后可从档案页一键回炉。</p>
            ) : (
              showMarkers &&
              markers.map((mk) => (
                <button
                  key={mk.id}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left text-xs hover:bg-black/5"
                  onClick={() => {
                    // 先定位目标小节，再 bump nonce 强制恢复跟随（否则从自由浏览态跳转会停在旧位置）
                    practiceController.focusMarker(mk);
                    bumpFollow();
                  }}
                >
                  <Icon name="flag" size={12} className="text-amber" />
                  <span>第 {mk.measure + 1} 小节</span>
                  {mk.note && <span className="truncate text-ink-soft">· {mk.note}</span>}
                  <span className="ml-auto rounded bg-gray-100 px-1 text-[10px] text-ink-soft">练过 {mk.loopCount} 次</span>
                </button>
              ))
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
