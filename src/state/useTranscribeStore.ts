/**
 * 扒谱 Store（T-17）：任务列表 + 上传/录制 + Worker 推理进度 + 取消。
 *
 * 流程：主线程 decodeToMono16k（Worker 无 AudioContext）→ 建 job →
 * LocalHeuristicProvider 零拷贝 transfer → 进度 patch → 成功存草稿/音频 → draft。
 */
import { create } from 'zustand';
import type { JobId } from '@/types/tab';
import type { TranscribeProgress, TranscriptionJob } from '@/types/app';
import { AppError, ERROR_CODES, LOCAL_ENGINE_ID, MAX_AUDIO_MB, MAX_AUDIO_SEC } from '@/core/constants';
import { audioEngine } from '@/audio/AudioEngine';
import { localHeuristicProvider } from '@/transcribe/LocalHeuristicProvider';
import { createJob, jobRepo } from '@/storage/jobRepo';
import { useAppStore } from '@/state/useAppStore';

export const ACCEPTED_EXT: readonly string[] = ['mp3', 'wav', 'm4a', 'flac', 'ogg'];
export const ACCEPT_ATTR = '.mp3,.wav,.m4a,.flac,.ogg,audio/*';

export interface TranscribeSubmitOptions {
  sourceName: string;
  sourceType: 'file' | 'mic';
  instrument: 'solo' | 'accompaniment';
  rightsConfirmed: boolean;
}

interface TranscribeState {
  jobs: TranscriptionJob[];
  loaded: boolean;
  loading: boolean;
  /** 正在推理的 job id */
  busyJobId: JobId | null;
  progressPct: number;
  stageLabel: string;
  /** 录制中状态 */
  recording: boolean;
  recordingSeconds: number;
  inputLevel: number;
  lastRecordedBlob: Blob | null;
  lastRecordedDuration: number;

  load(): Promise<void>;
  refresh(): Promise<void>;
  deleteJob(id: JobId): Promise<void>;
  submit(source: { blob: Blob }, opts: TranscribeSubmitOptions): Promise<JobId>;
  cancel(id: JobId): Promise<void>;
  setRecording(v: boolean): void;
  setRecordingSeconds(v: number): void;
  setInputLevel(v: number): void;
  setLastRecorded(blob: Blob | null, duration: number): void;
}

export const useTranscribeStore = create<TranscribeState>((set, get) => ({
  jobs: [],
  loaded: false,
  loading: false,
  busyJobId: null,
  progressPct: 0,
  stageLabel: '',
  recording: false,
  recordingSeconds: 0,
  inputLevel: 0,
  lastRecordedBlob: null,
  lastRecordedDuration: 0,

  async load() {
    set({ loading: true });
    try {
      const jobs = await jobRepo.list();
      set({ jobs, loaded: true, loading: false });
    } catch (err) {
      set({ loading: false });
      const msg = err instanceof Error ? err.message : String(err);
      useAppStore.getState().toast('error', `读取扒谱任务失败：${msg}`);
    }
  },

  async refresh() {
    const jobs = await jobRepo.list();
    set({ jobs });
  },

  async deleteJob(id) {
    await jobRepo.remove(id);
    set({ jobs: get().jobs.filter((j) => j.id !== id) });
  },

  async submit(source, opts) {
    if (!opts.rightsConfirmed) {
      throw new AppError(ERROR_CODES.E_PERMISSION, '请先确认音频权属');
    }
    if (source.blob.size > MAX_AUDIO_MB * 1024 * 1024) {
      throw new AppError(ERROR_CODES.E_DECODE, `音频超过 ${MAX_AUDIO_MB}MB，请裁剪后再试`);
    }

    const job = createJob({
      sourceName: opts.sourceName,
      sourceType: opts.sourceType,
      durationSec: 0,
      instrument: opts.instrument,
      rightsConfirmed: true,
    });
    await jobRepo.save(job);
    set({ jobs: [job, ...get().jobs], busyJobId: job.id, progressPct: 1, stageLabel: '解码音频' });
    void get().refresh();

    // 主线程解码（Worker 内没有 AudioContext）
    const decoded = await audioEngine.decodeToMono16k(source.blob);
    const effectiveSec = Math.min(MAX_AUDIO_SEC, decoded.durationSec);
    const stored = await jobRepo.get(job.id);
    if (stored) await jobRepo.save({ ...stored, durationSec: Math.round(effectiveSec) });

    try {
      const result = await localHeuristicProvider.transcribe(
        {
          pcm: decoded.pcm,
          sampleRate: 16000,
          durationSec: effectiveSec,
          peaks: decoded.peaks,
        },
        { instrument: opts.instrument, keyHint: 'auto', jobId: job.id },
        (p: TranscribeProgress) => {
          set({ progressPct: p.pct, stageLabel: p.label });
          void jobRepo.patch(job.id, { progress: p.pct, stage: p.stage }).catch(() => undefined);
        },
      );

      // 成功：草稿 + 原音频（peaks 保留），任务进 draft
      await jobRepo.saveDraft(job.id, result.tab);
      await jobRepo.putAudio(job.id, source.blob, decoded.peaks);
      await jobRepo.patch(job.id, {
        status: 'draft',
        progress: 100,
        stage: 'assemble',
        avgConfidence: result.avgConfidence,
        resultTabId: null,
      });
      set({ busyJobId: null, progressPct: 100 });
      useAppStore.getState().toast(
        'success',
        `扒谱完成 · 平均置信度 ${Math.round(result.avgConfidence * 100)}% · 待校对`,
      );
      await get().refresh();
      return job.id;
    } catch (err) {
      const interrupted = get().busyJobId === null;
      await jobRepo.setStatus(job.id, interrupted ? 'interrupted' : 'failed');
      set({ busyJobId: null, progressPct: 0 });
      await get().refresh();
      const msg = err instanceof Error ? err.message : String(err);
      if (!interrupted) useAppStore.getState().toast('error', `推理失败：${msg}`);
      throw err;
    }
  },

  async cancel(id) {
    localHeuristicProvider.cancel(id);
    set({ busyJobId: null, progressPct: 0, stageLabel: '' });
    await jobRepo.setStatus(id, 'interrupted');
    useAppStore.getState().toast('info', '已取消');
    await get().refresh();
  },

  setRecording(v) {
    set({ recording: v });
  },
  setRecordingSeconds(v) {
    set({ recordingSeconds: v });
  },
  setInputLevel(v) {
    set({ inputLevel: v });
  },
  setLastRecorded(blob, duration) {
    set({ lastRecordedBlob: blob, lastRecordedDuration: duration });
  },
}));

/** 本地引擎展示信息（UI 右栏常驻，诚实标注） */
export const TRANSCRIBE_ENGINE_INFO = {
  id: LOCAL_ENGINE_ID,
  label: '本地轻量引擎 · 不限次',
};
