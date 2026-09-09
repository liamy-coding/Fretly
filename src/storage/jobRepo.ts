/**
 * 扒谱任务 / 草稿 / 音频 的生命周期（PRD C-11，架构 T-11）。
 *
 * 淘汰策略：草稿保留最近 20 条；原音频保留最近 10 个（按 updatedAt 淘汰）；
 * 入库成功后删除音频 Blob、只保留 peaks（§9.6）。
 */
import type { JobId, Tab } from '@/types/tab';
import type { JobStatus, StageKey, TranscriptionJob } from '@/types/app';
import { MAX_AUDIOS, MAX_DRAFTS, nowIso } from '@/core/constants';
import { newId } from '@/core/id';
import {
  deleteRecord,
  getAllRecords,
  getRecord,
  putRecord,
  type AudioRecord,
  type DraftRecord,
} from '@/storage/db';

export interface CreateJobInput {
  sourceName: string;
  sourceType: 'file' | 'mic';
  durationSec: number;
  instrument: 'solo' | 'accompaniment';
  rightsConfirmed: boolean;
}

export function createJob(input: CreateJobInput): TranscriptionJob {
  const now = nowIso();
  return {
    id: newId('job'),
    status: 'processing',
    sourceName: input.sourceName,
    sourceType: input.sourceType,
    durationSec: Math.round(input.durationSec),
    instrument: input.instrument,
    progress: 0,
    stage: '',
    avgConfidence: null,
    rightsConfirmed: input.rightsConfirmed,
    hasAudio: false,
    peaks: [],
    resultTabId: null,
    createdAt: now,
    updatedAt: now,
  };
}

export const jobRepo = {
  async list(): Promise<TranscriptionJob[]> {
    const jobs = await getAllRecords('jobs');
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async get(id: JobId): Promise<TranscriptionJob | undefined> {
    return getRecord('jobs', id);
  },

  async save(job: TranscriptionJob): Promise<TranscriptionJob> {
    const next: TranscriptionJob = { ...job, updatedAt: nowIso() };
    await putRecord('jobs', next);
    return next;
  },

  async patch(
    id: JobId,
    patch: Partial<Pick<TranscriptionJob, 'status' | 'progress' | 'stage' | 'avgConfidence' | 'resultTabId' | 'hasAudio' | 'peaks'>>,
  ): Promise<TranscriptionJob | undefined> {
    const job = await getRecord('jobs', id);
    if (!job) return undefined;
    return jobRepo.save({ ...job, ...patch });
  },

  async setStatus(id: JobId, status: JobStatus, stage: StageKey | '' = ''): Promise<void> {
    await jobRepo.patch(id, { status, stage });
  },

  async remove(id: JobId): Promise<void> {
    await deleteRecord('jobs', id);
    await deleteRecord('drafts', id);
    await deleteRecord('audios', id);
  },

  // ── 草稿 ────────────────────────────────────────────────────────
  async saveDraft(jobId: JobId, tab: Tab): Promise<void> {
    const record: DraftRecord = { jobId, tab, updatedAt: nowIso() };
    await putRecord('drafts', record);
    await jobRepo.pruneDrafts();
  },

  async loadDraft(jobId: JobId): Promise<Tab | undefined> {
    const record = await getRecord('drafts', jobId);
    return record?.tab;
  },

  async deleteDraft(jobId: JobId): Promise<void> {
    await deleteRecord('drafts', jobId);
  },

  /** 草稿超过 20 条时按 updatedAt 淘汰最旧的 */
  async pruneDrafts(): Promise<void> {
    const drafts = await getAllRecords('drafts');
    if (drafts.length <= MAX_DRAFTS) return;
    const stale = [...drafts].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(0, drafts.length - MAX_DRAFTS);
    for (const d of stale) await deleteRecord('drafts', d.jobId);
  },

  // ── 原音频 ──────────────────────────────────────────────────────
  async putAudio(jobId: JobId, blob: Blob, peaks: [number, number][]): Promise<void> {
    const existing = await getRecord('audios', jobId);
    const record: AudioRecord = {
      jobId,
      blob,
      peaks: peaks.length > 0 ? peaks : (existing?.peaks ?? []),
      updatedAt: nowIso(),
    };
    await putRecord('audios', record);
    await jobRepo.patch(jobId, { hasAudio: true, peaks: record.peaks });
    await jobRepo.pruneAudios();
  },

  async getAudio(jobId: JobId): Promise<AudioRecord | undefined> {
    return getRecord('audios', jobId);
  },

  async getPeaks(jobId: JobId): Promise<[number, number][]> {
    const record = await getRecord('audios', jobId);
    return record?.peaks ?? [];
  },

  /** 入库成功后调用：删 Blob 留 peaks */
  async deleteAudioBlob(jobId: JobId): Promise<void> {
    const record = await getRecord('audios', jobId);
    if (!record) return;
    await putRecord('audios', { ...record, blob: null, updatedAt: nowIso() });
    await jobRepo.patch(jobId, { hasAudio: false, peaks: record.peaks });
  },

  /** 音频超过 10 个时按 updatedAt 淘汰最旧的（仍会保留其 peaks 记录在 audios 里） */
  async pruneAudios(): Promise<void> {
    const audios = await getAllRecords('audios');
    const withBlob = audios.filter((a) => a.blob !== null);
    if (withBlob.length <= MAX_AUDIOS) return;
    const stale = [...withBlob]
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, withBlob.length - MAX_AUDIOS);
    for (const a of stale) {
      await putRecord('audios', { ...a, blob: null, updatedAt: nowIso() });
      await jobRepo.patch(a.jobId, { hasAudio: false });
    }
  },
};
