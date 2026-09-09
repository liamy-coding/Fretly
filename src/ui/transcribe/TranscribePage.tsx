/**
 * 扒谱页（架构 §2.10-53，T-22）：拖拽/选择音频上传、麦克风录制、权属勾选、
 * 乐器选项、本地引擎 7 阶段进度与取消、任务列表、「效果预期」与低置信诚实提示。
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranscribeStore, ACCEPT_ATTR, TRANSCRIBE_ENGINE_INFO, type TranscribeSubmitOptions } from '@/state/useTranscribeStore';
import { useAppStore } from '@/state/useAppStore';
import { audioEngine } from '@/audio/AudioEngine';
import type { JobId } from '@/types/tab';
import { Badge, Button, Card, Checkbox, Icon, Progress, Segmented, Spinner } from '@/ui/kit';

export default function TranscribePage() {
  const navigate = useNavigate();
  const store = useTranscribeStore();
  const toast = useAppStore((s) => s.toast);
  const [source, setSource] = useState<{ blob: Blob; name: string; sizeText: string } | null>(null);
  const [instrument, setInstrument] = useState<TranscribeSubmitOptions['instrument']>('solo');
  const [rights, setRights] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void store.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onFile = (file: File | null) => {
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      toast('warn', '音频超过 50MB，请先裁剪（最长支持 5 分钟）');
      return;
    }
    setSource({ blob: file, name: file.name, sizeText: (file.size / 1024 / 1024).toFixed(1) + ' MB' });
  };

  const submit = (src: { blob: Blob; name: string }, type: 'file' | 'mic') => {
    void (async () => {
      if (!rights) {
        toast('warn', '请先勾选「我确认拥有该音频的合法权利」');
        return;
      }
      try {
        const jobId = await store.submit(src, {
          sourceName: src.name,
          sourceType: type,
          instrument,
          rightsConfirmed: true,
        });
        navigate(`/transcribe/${jobId}/edit`);
      } catch (err) {
        toast('error', err instanceof Error ? err.message : '扒谱失败');
      }
    })();
  };

  const startMic = () => {
    if (store.recording) return;
    void (async () => {
      try {
        await audioEngine.resume();
        store.setRecording(true);
        store.setLastRecorded(null, 0);
        const { blob, durationSec } = await audioEngine.recordMic(300, (lv) => store.setInputLevel(lv), (sec) => store.setRecordingSeconds(sec));
        store.setRecording(false);
        store.setInputLevel(0);
        store.setLastRecorded(blob, Math.round(durationSec));
        toast('success', `录音完成（${Math.round(durationSec)} 秒）`);
      } catch (err) {
        store.setRecording(false);
        toast('error', err instanceof Error ? err.message : '录音失败');
      }
    })();
  };

  const pendingSource = source ?? (store.lastRecordedBlob ? { blob: store.lastRecordedBlob, name: `录音 ${store.lastRecordedDuration}s` } : null);

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 pb-24">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h1 className="text-lg font-bold">扒谱</h1>
          <p className="text-xs text-ink-soft">{TRANSCRIBE_ENGINE_INFO.label} · 音频仅在本地处理，不上传服务器</p>
        </div>
        <Badge tone="amber" className="ml-auto">
          效果一般 · 请以听感校对
        </Badge>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_300px]">
        {/* 左：上传 / 录制 / 提交 */}
        <div className="space-y-4">
          <Card className="p-4">
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileRef.current?.click()}
              onKeyDown={(e) => e.key === 'Enter' && fileRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                onFile(e.dataTransfer.files?.[0] ?? null);
              }}
              className={source ? 'border border-line bg-canvas/60 p-3' : 'cursor-pointer border-2 border-dashed border-line p-8 text-center'}
            >
              <input ref={fileRef} type="file" accept={ACCEPT_ATTR} className="hidden" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
              {source ? (
                <div className="flex items-center gap-3">
                  <Icon name="upload" size={22} className="text-brand" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{source.name}</div>
                    <div className="text-xs text-ink-soft">{source.sizeText} · 点击可更换</div>
                  </div>
                  <Button variant="ghost" onClick={(e) => { e.stopPropagation(); setSource(null); }}>
                    移除
                  </Button>
                </div>
              ) : (
                <div className="text-ink-soft">
                  <Icon name="upload" size={26} className="mx-auto mb-1 text-gray-300" />
                  <p className={dragging ? 'text-brand' : ''}>拖入音频，或点击选择文件</p>
                  <p className="mt-1 text-xs text-gray-400">支持 MP3 / WAV / M4A / FLAC / OGG · 最长 5 分钟 · 单把吉他更准</p>
                </div>
              )}
            </div>

            {/* 录音 */}
            <div className="mt-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant={store.recording ? 'danger' : 'outline'}
                  icon="mic"
                  disabled={store.recording}
                  onClick={startMic}
                >
                  {store.recording ? `录音中 ${Math.floor(store.recordingSeconds)}s` : '麦克风录制'}
                </Button>
                {store.recording && (
                  <span className="text-xs text-ink-soft">最长 5 分钟，超时自动停止并进入待提交状态</span>
                )}
                {store.lastRecordedBlob && !store.recording && (
                  <span className="text-xs text-ink-soft">
                    已录制 {store.lastRecordedDuration}s
                    {pendingSource?.name.startsWith('录音') ? '（可提交下方）' : ''}
                  </span>
                )}
              </div>
              {store.recording && (
                <div className="mt-2 flex items-center gap-2">
                  <Progress value={Math.min(100, (store.recordingSeconds / 300) * 100)} />
                  <span className="w-14 text-right font-mono text-xs">{Math.floor(store.recordingSeconds)}s</span>
                </div>
              )}
              <div className="mt-1 h-1.5 w-full rounded-full bg-gray-100">
                <div className="h-full rounded-full bg-red-400 transition-all" style={{ width: `${Math.min(100, store.inputLevel * 100)}%` }} />
              </div>
            </div>
          </Card>

          <Card className="p-4">
            <h2 className="mb-2 text-sm font-semibold">设置与提交</h2>
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-ink-soft">乐器类型</span>
                <Segmented
                  value={instrument}
                  onChange={setInstrument}
                  options={[
                    { value: 'solo', label: '独奏' },
                    { value: 'accompaniment', label: '伴奏' },
                  ]}
                />
              </div>
              <Checkbox checked={rights} onChange={setRights} label="我确认拥有该音频的合法权利（仅本地处理）" />
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={!pendingSource || store.busyJobId !== null || !rights}
                  onClick={() => pendingSource && submit(pendingSource, source ? 'file' : 'mic')}
                >
                  {store.busyJobId ? '处理中…' : '开始扒谱'}
                </Button>
              </div>
            </div>
          </Card>

          {/* 进度 */}
          {store.busyJobId && (
            <Card className="p-4">
              <div className="mb-1 flex justify-between text-sm">
                <span className="font-medium">{store.stageLabel}</span>
                <span className="font-mono">{store.progressPct}%</span>
              </div>
              <Progress value={store.progressPct} />
              <p className="mt-1 text-xs text-ink-soft">本地启发式引擎正在分析…… 可在任务列表取消</p>
            </Card>
          )}
        </div>

        {/* 右：效果预期 */}
        <div className="space-y-3">
          <Card className="p-4">
            <h2 className="mb-2 text-sm font-semibold">效果预期</h2>
            <ul className="space-y-1.5 text-xs leading-relaxed text-ink-soft">
              <li>· 适合：清音单音旋律 / 分解和弦 / 节拍清晰的伴奏</li>
              <li>· 一般：失真音色、快速扫弦、多乐器混录</li>
              <li>· 输出：可编辑六线谱草稿 + 置信度标注（低置信会标出待确认）</li>
              <li>· 引擎准确度有限，生成后请打开编辑器逐段校对</li>
            </ul>
          </Card>
          <Card className="p-4">
            <h2 className="mb-2 text-sm font-semibold">任务记录</h2>
            {store.jobs.length === 0 ? (
              <p className="text-xs text-ink-soft">暂无任务。</p>
            ) : (
              <ul className="divide-y divide-line">
                {store.jobs.map((job) => (
                  <li key={job.id} className="py-2">
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{job.sourceName}</div>
                        <div className="text-xs text-ink-soft">
                          {job.durationSec}s · {job.sourceType === 'mic' ? '录音' : '文件'}
                          {job.avgConfidence !== null && ` · 置信度 ${Math.round(job.avgConfidence * 100)}%`}
                        </div>
                      </div>
                      <JobAction jobId={job.id} onOpenEditor={() => navigate(`/transcribe/${job.id}/edit`)} />
                    </div>
                    {job.status === 'draft' && (
                      <div className="mt-1.5 flex items-center gap-2">
                        <span className="h-1.5 w-1.5 rounded-full bg-amber" />
                        <span className="text-xs text-amber">待校对 · 可打开编辑器</span>
                        <Button size="xs" onClick={() => navigate(`/transcribe/${job.id}/edit`)}>
                          打开编辑器
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function JobAction({ jobId, onOpenEditor }: { jobId: JobId; onOpenEditor: () => void }) {
  const store = useTranscribeStore();
  const job = store.jobs.find((j) => j.id === jobId);
  if (!job) return null;
  if (job.status === 'processing') {
    return (
      <Button
        size="xs"
        variant="outline"
        onClick={() => {
          void store.cancel(jobId);
        }}
      >
        取消
      </Button>
    );
  }
  if (job.status === 'draft') {
    return (
      <Button size="xs" variant="subtle" onClick={onOpenEditor}>
        校对
      </Button>
    );
  }
  if (job.status === 'archived' && job.resultTabId) {
    return <Badge tone="success">已入库</Badge>;
  }
  if (job.status === 'failed' || job.status === 'interrupted') {
    return (
      <Button
        size="xs"
        variant="ghost"
        onClick={() => {
          void store.deleteJob(jobId);
        }}
      >
        删除
      </Button>
    );
  }
  return <Spinner className="h-4 w-4" />;
}
