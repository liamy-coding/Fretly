/**
 * LocalHeuristicProvider（架构 T-13 / PRD C-09、C-10）。
 *
 * 唯一启用实现的扒谱 Provider：
 *  - 创建/复用 Web Worker（Vite `new Worker(new URL(...))` 打包）
 *  - `postMessage(pcm, [pcm.buffer])` 零拷贝移交主线程解码结果
 *  - 进度转发、cancel() → worker.terminate()、超时保护
 */
import type {
  TranscriptionProvider,
  TranscriptionResult,
  TranscribeInput,
  TranscribeOptions,
  TranscribeProgress,
} from '@/types/app';
import type { JobId } from '@/types/tab';
import { AppError, ERROR_CODES, LOCAL_ENGINE_ID, LOCAL_ENGINE_LABEL, MAX_AUDIO_SEC } from '@/core/constants';
import type {
  WorkerDoneMessage,
  WorkerErrorMessage,
  WorkerProgressMessage,
  WorkerRequest,
} from '@/transcribe/provider';

/** 推理超时（秒）：300s 音频允许 180s 上限，防止异常卡死 */
const TIMEOUT_MS = 180_000;

interface ActiveJob {
  worker: Worker;
  timer: ReturnType<typeof setTimeout>;
  resolve: (r: TranscriptionResult) => void;
  reject: (e: Error) => void;
}

export class LocalHeuristicProvider implements TranscriptionProvider {
  readonly id = LOCAL_ENGINE_ID;
  readonly label = LOCAL_ENGINE_LABEL;
  readonly enabled = true;

  private readonly active = new Map<JobId, ActiveJob>();

  transcribe(
    input: TranscribeInput,
    opts: TranscribeOptions,
    onProgress: (p: TranscribeProgress) => void,
  ): Promise<TranscriptionResult> {
    // 取消已存在的同名任务
    this.cancel(opts.jobId);

    if (input.durationSec > MAX_AUDIO_SEC + 5) {
      return Promise.reject(new AppError(ERROR_CODES.E_DECODE, `音频超过 ${MAX_AUDIO_SEC} 秒，请裁剪后再试`));
    }

    const worker = this.createWorker();
    const promise = new Promise<TranscriptionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.terminate(opts.jobId);
        reject(new AppError(ERROR_CODES.E_WORKER, '推理超时，请裁剪音频或换用更短的片段'));
      }, TIMEOUT_MS);

      this.active.set(opts.jobId, { worker, timer, resolve, reject });

      worker.onmessage = (e: MessageEvent<WorkerProgressMessage | WorkerDoneMessage | WorkerErrorMessage>) => {
        const msg = e.data;
        if (msg.type === 'progress') {
          onProgress(msg.progress);
          return;
        }
        if (msg.type === 'done') {
          this.finish(opts.jobId);
          resolve(msg.result);
          return;
        }
        // error
        this.finish(opts.jobId);
        reject(new AppError(ERROR_CODES.E_WORKER, msg.message || '本地推理失败'));
      };

      worker.onerror = (err) => {
        this.finish(opts.jobId);
        reject(new AppError(ERROR_CODES.E_WORKER, err.message || 'Worker 异常'));
      };

      const req: WorkerRequest = {
        type: 'run',
        pcm: input.pcm,
        sampleRate: 16000,
        durationSec: input.durationSec,
        peaks: input.peaks,
        opts,
      };
      worker.postMessage(req, [input.pcm.buffer]);
    });

    return promise;
  }

  cancel(jobId: JobId): void {
    this.finish(jobId);
  }

  private createWorker(): Worker {
    return new Worker(new URL('./worker/dsp.worker.ts', import.meta.url), { type: 'module' });
  }

  private finish(jobId: JobId): void {
    const entry = this.active.get(jobId);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.worker.onmessage = null;
    entry.worker.onerror = null;
    entry.worker.terminate();
    this.active.delete(jobId);
  }

  private terminate(jobId: JobId): void {
    const entry = this.active.get(jobId);
    if (!entry) return;
    entry.worker.terminate();
    this.active.delete(jobId);
  }
}

/** UI 统一使用这个单例（与 jobRepo 引用同一 job id 空间） */
export const localHeuristicProvider = new LocalHeuristicProvider();

/** 注册表：本地引擎是唯一启用的 provider */
export const availableProviders: readonly TranscriptionProvider[] = [localHeuristicProvider];

export function providerById(id: string): TranscriptionProvider | undefined {
  return availableProviders.find((p) => p.id === id);
}
