/**
 * Worker 侧 ① 解码与预处理（架构 §7.1，T-14）。
 *
 * Worker 内没有 AudioContext —— pcm 由主线程 decodeToMono16k 产出后 transfer 过来。
 * 这里只做纯计算：去首尾静音、峰归一化、RMS / 静音占比质量预判。
 */
import { clamp } from '@/core/constants';

export interface DecodedBuffer {
  /** 已去首尾静音 + 二次峰归一化的 pcm（16k mono） */
  pcm: Float32Array;
  /** 首部被裁掉的秒数（用于把分析时间轴对齐回原始音频） */
  startOffsetSec: number;
  /** 有效信号段长度（秒），供进度条与上限提示 */
  activeSec: number;
  /** 归一化后 RMS（0–1） */
  rms: number;
  /** 静音帧占比（0–1）；> 0.8 应提前失败 */
  silenceRatio: number;
}

export interface QualityGate {
  ok: boolean;
  reason: string;
  rms: number;
  silenceRatio: number;
}

/** 滑动窗 RMS 是否低于静音阈值 */
function windowSilent(
  pcm: Float32Array,
  from: number,
  to: number,
  threshold: number,
): boolean {
  const end = Math.min(to, pcm.length);
  if (end <= from) return true;
  let sum = 0;
  for (let i = from; i < end; i += 1) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / (end - from)) < threshold;
}

/** 去首尾静音：滑动窗 RMS < 0.005 视为静音；返回裁剪区间（保留原数组引用切片） */
export function trimSilence(
  pcm: Float32Array,
  threshold = 0.005,
  window = 512,
): { samples: Float32Array; startSample: number } {
  if (pcm.length === 0) return { samples: pcm, startSample: 0 };
  let start = 0;
  while (start < pcm.length && windowSilent(pcm, start, start + window, threshold)) {
    start += window;
  }
  let end = pcm.length;
  while (end > start && windowSilent(pcm, Math.max(start, end - window), end, threshold)) {
    end -= window;
  }
  if (end <= start) {
    // 几乎全静音：保留一个窗长避免零长度下游崩溃
    return { samples: pcm.slice(0, Math.max(1, Math.min(pcm.length, window))), startSample: start };
  }
  return { samples: pcm.slice(start, end), startSample: start };
}

/** 峰归一化到 0.9 */
export function peakNormalize(pcm: Float32Array, peak = 0.9): Float32Array {
  if (pcm.length === 0) return pcm;
  let max = 0;
  for (let i = 0; i < pcm.length; i += 1) max = Math.max(max, Math.abs(pcm[i]));
  if (max <= 1e-9) return pcm;
  const gain = clamp(peak / max, 0, 4);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) out[i] = pcm[i] * gain;
  return out;
}

/** RMS + 静音占比（512 采样一帧） */
export function measureStats(pcm: Float32Array): { rms: number; silenceRatio: number } {
  if (pcm.length === 0) return { rms: 0, silenceRatio: 1 };
  let sum = 0;
  let silentFrames = 0;
  let frames = 0;
  for (let i = 0; i < pcm.length; i += 512) {
    const end = Math.min(pcm.length, i + 512);
    let frameSum = 0;
    for (let j = i; j < end; j += 1) frameSum += pcm[j] * pcm[j];
    const rms = Math.sqrt(frameSum / Math.max(1, end - i));
    sum += frameSum;
    frames += 1;
    if (rms < 0.005) silentFrames += 1;
  }
  return {
    rms: Math.sqrt(sum / pcm.length),
    silenceRatio: frames > 0 ? silentFrames / frames : 1,
  };
}

/** 质量预判：几乎无声 / 静音占比过高时提前失败（架构 §7.1 step 2） */
export function qualityGate(input: Float32Array): QualityGate {
  const { rms, silenceRatio } = measureStats(input);
  if (rms < 0.005) {
    return { ok: false, reason: '检测到音频几乎无声', rms, silenceRatio };
  }
  if (silenceRatio > 0.8) {
    return { ok: false, reason: '音频静音占比过高，建议换用清音版本', rms, silenceRatio };
  }
  return { ok: true, reason: '', rms, silenceRatio };
}

/**
 * ① 阶段主入口：归一化 → 去首尾静音 → 质量统计。
 * 主线程已做过一次归一化与裁剪，这里再做一次长度保持的精细处理，
 * 保证音头（attack）不被误裁。返回 DecodedBuffer。
 */
export function decodePcm(input: Float32Array, sampleRate = 16000): DecodedBuffer {
  const normalized = peakNormalize(input, 0.9);
  const gate = qualityGate(normalized);
  if (!gate.ok) {
    // 静音过多交给 dsp.worker 抛质量错误；这里仍返回（由调用方决定是否中断）
    return {
      pcm: normalized,
      startOffsetSec: 0,
      activeSec: normalized.length / sampleRate,
      rms: gate.rms,
      silenceRatio: gate.silenceRatio,
    };
  }

  const trimmed = trimSilence(normalized, 0.005, 512);
  const again = peakNormalize(trimmed.samples, 0.9);
  const stats = measureStats(again);
  return {
    pcm: again,
    startOffsetSec: trimmed.startSample / sampleRate,
    activeSec: again.length / sampleRate,
    rms: stats.rms,
    silenceRatio: stats.silenceRatio,
  };
}
