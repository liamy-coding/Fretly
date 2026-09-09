/**
 * 扒谱 Provider 端口与注册表（架构 T-13 / PRD C-09）。
 *
 * TranscriptionProvider / TranscribeInput / TranscribeOptions / TranscribeProgress /
 * TranscriptionResult 的规范类型已定义在 types/app.ts，这里仅做类型再导出并补上
 * Worker 消息协议与 RemoteProvider 空壳 + 注册表。
 */
import type {
  TranscriptionProvider,
  TranscriptionResult,
  TranscribeInput,
  TranscribeOptions,
  TranscribeProgress,
} from '@/types/app';
import type { JobId } from '@/types/tab';
import { AppError, ERROR_CODES, LOCAL_ENGINE_ID, LOCAL_ENGINE_LABEL } from '@/core/constants';

export type {
  TranscriptionProvider,
  TranscriptionResult,
  TranscribeInput,
  TranscribeOptions,
  TranscribeProgress,
};

// ── Worker 消息协议（架构 §2.6 文件 25）────────────────────────────
export interface WorkerRunRequest {
  type: 'run';
  /** 16 kHz mono，已归一化；postMessage 时 transfer 所有权 */
  pcm: Float32Array;
  sampleRate: 16000;
  durationSec: number;
  peaks: [number, number][];
  opts: TranscribeOptions;
}

export interface WorkerCancelRequest {
  type: 'cancel';
  jobId: JobId;
}

export type WorkerRequest = WorkerRunRequest | WorkerCancelRequest;

export interface WorkerProgressMessage {
  type: 'progress';
  progress: TranscribeProgress;
}

export interface WorkerDoneMessage {
  type: 'done';
  jobId: JobId;
  result: TranscriptionResult;
}

export interface WorkerErrorMessage {
  type: 'error';
  jobId: JobId;
  message: string;
  code?: string;
}

export type WorkerResponse = WorkerProgressMessage | WorkerDoneMessage | WorkerErrorMessage;

/** 7 阶段进度权重（架构 §7 总原则：10/15/25/20/10/15/5） */
export const STAGE_WEIGHTS: Record<TranscribeProgress['stage'], number> = {
  decode: 10,
  onset: 15,
  pitch: 25,
  chroma: 20,
  beat: 10,
  dp: 15,
  assemble: 5,
};

export const STAGE_LABELS: Record<TranscribeProgress['stage'], string> = {
  decode: '解码音频',
  onset: '检测音符起点',
  pitch: '估计音高',
  chroma: '识别和弦',
  beat: '分析节拍',
  dp: '映射指板',
  assemble: '生成初稿',
};

// ── RemoteProvider 空壳（enabled = false，UI 不出现）───────────────
/**
 * 预留的云端接口位：POST /api/transcribe。
 * M1 明确不接线（架构 Q / PRD 决策 1），因此 enabled 恒为 false，
 * transcribe 一律抛 E_NOT_IMPLEMENTED。
 */
export const remoteProvider: TranscriptionProvider = {
  id: 'remote-v1',
  label: '云端引擎（未启用）',
  enabled: false,
  async transcribe() {
    throw new AppError(ERROR_CODES.E_NOT_IMPLEMENTED, '云端扒谱服务未启用（本地引擎已足够）');
  },
  cancel(): void {
    /* 无 Worker 可取消 */
  },
};

/** 供 UI 读取的注册表；顺序即 UI 引擎选择顺序 */
export const transcriptionProviders: readonly TranscriptionProvider[] = [
  remoteProvider,
];

/** 按 id 取 provider（UI 只展示 enabled 的实现） */
export function providerById(id: string): TranscriptionProvider | undefined {
  return transcriptionProviders.find((p) => p.id === id);
}

/** 本地引擎的稳定身份（LocalHeuristicProvider 实现时直接引用） */
export const LOCAL_PROVIDER_ID = LOCAL_ENGINE_ID;
export const LOCAL_PROVIDER_LABEL = LOCAL_ENGINE_LABEL;
