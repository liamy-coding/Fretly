/**
 * AudioContext 单例与音频 IO（架构 T-09）。
 *
 * ★ Web Audio 不可用时不抛异常，全部方法降级返回 null / 抛 AppError(E_AUDIO)，
 *   由 UI 显示红色横幅（PRD §4.2 错误态）。
 * ★ 解码必须在主线程：Worker 内没有 AudioContext（架构 Q-B）。
 */
import {
  AppError,
  ERROR_CODES,
  MAX_AUDIO_MB,
  MAX_AUDIO_SEC,
  PEAK_CHUNK,
  TARGET_SAMPLE_RATE,
} from '@/core/constants';

export interface DecodedAudio {
  /** 16 kHz mono，已去首尾静音 + 峰归一化 */
  pcm: Float32Array;
  sampleRate: 16000;
  durationSec: number;
  /** 每 512 采样一对 [min, max] ∈ [-1,1] */
  peaks: [number, number][];
  rms: number;
  silenceRatio: number;
}

export interface Capabilities {
  audioContext: boolean;
  offlineAudioContext: boolean;
  worker: boolean;
  indexedDb: boolean;
  getUserMedia: boolean;
}

type AudioContextCtor = typeof AudioContext;
type WebkitWindow = Window & { webkitAudioContext?: AudioContextCtor };

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  // window.AudioContext 的标准全局在部分 lib 里类型不全，经 unknown 兜底取值
  const anyWindow = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return anyWindow.AudioContext ?? anyWindow.webkitAudioContext ?? null;
}

export function detectCapabilities(): Capabilities {
  const hasWindow = typeof window !== 'undefined';
  const hasNavigator = typeof navigator !== 'undefined';
  return {
    audioContext: getAudioContextCtor() !== null,
    offlineAudioContext: hasWindow && typeof (window as WebkitWindow & { OfflineAudioContext?: unknown }).OfflineAudioContext !== 'undefined',
    worker: hasWindow && typeof Worker !== 'undefined',
    indexedDb: hasWindow && typeof indexedDB !== 'undefined',
    getUserMedia: hasNavigator && !!navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function',
  };
}

class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private metronomeGain: GainNode | null = null;
  private demoGain: GainNode | null = null;
  private failed = false;
  /** 当前进行中的录音停止句柄（供手动停止） */
  private activeRecordingStop: (() => void) | null = null;

  readonly capabilities: Capabilities = detectCapabilities();

  get context(): AudioContext | null {
    return this.ensure();
  }

  /** 惰性创建 AudioContext；不可用时返回 null（不抛） */
  ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (this.failed) return null;
    const Ctor = getAudioContextCtor();
    if (!Ctor) {
      this.failed = true;
      return null;
    }
    const ctx = new Ctor();
    const master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);

    const metronome = ctx.createGain();
    metronome.gain.value = 0.7;
    metronome.connect(master);

    const demo = ctx.createGain();
    demo.gain.value = 0.8;
    demo.connect(master);

    this.ctx = ctx;
    this.masterGain = master;
    this.metronomeGain = metronome;
    this.demoGain = demo;
    return ctx;
  }

  get bus(): { master: GainNode | null; metronome: GainNode | null; demo: GainNode | null } {
    this.ensure();
    return { master: this.masterGain, metronome: this.metronomeGain, demo: this.demoGain };
  }

  async resume(): Promise<boolean> {
    const ctx = this.ensure();
    if (!ctx) return false;
    // state 在部分 lib 窄化为不含 running 的子集，这里统一经标准联合类型比较
    const st = ctx.state as AudioContextState;
    if (st === 'running') return true;
    try {
      await ctx.resume();
      return (ctx.state as AudioContextState) === 'running';
    } catch {
      // Safari 17 需要用户手势解锁：失败再试一次（架构 Q-K）
      try {
        await ctx.resume();
        return (ctx.state as AudioContextState) === 'running';
      } catch {
        return false;
      }
    }
  }

  /** 当前时钟（秒）。无 AudioContext 时退回 performance.now()，接口保持一致 */
  now(): number {
    const ctx = this.ctx;
    if (ctx) return ctx.currentTime;
    return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
  }

  setBusGain(bus: 'master' | 'metronome' | 'demo', value: number): void {
    const gains = this.bus;
    const node = bus === 'master' ? gains.master : bus === 'metronome' ? gains.metronome : gains.demo;
    if (!node || !this.ctx) return;
    node.gain.setValueAtTime(Math.max(0, Math.min(1, value)), this.ctx.currentTime);
  }

  /** 创建一段静音 AudioBuffer（节拍器与试听共用） */
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer | null {
    const ctx = this.ensure();
    if (!ctx) return null;
    return ctx.createBuffer(channels, Math.max(1, length), sampleRate);
  }

  createBufferSource(): AudioBufferSourceNode | null {
    const ctx = this.ensure();
    if (!ctx) return null;
    return ctx.createBufferSource();
  }

  // ── 解码 ────────────────────────────────────────────────────────
  /**
   * 文件 → 16 kHz mono Float32Array。
   * 立体声混单声道 → 线性插值重采样 → 去首尾静音 → 峰归一化 0.9 → 抽 peaks。
   */
  async decodeToMono16k(file: Blob): Promise<DecodedAudio> {
    if (file.size > MAX_AUDIO_MB * 1024 * 1024) {
      throw new AppError(ERROR_CODES.E_DECODE, `音频超过 ${MAX_AUDIO_MB}MB`);
    }
    const ctx = this.ensure();
    if (!ctx) throw new AppError(ERROR_CODES.E_AUDIO, '当前浏览器不支持 Web Audio');

    const arrayBuffer = await file.arrayBuffer();
    let decoded: AudioBuffer;
    try {
      decoded = await ctx.decodeAudioData(arrayBuffer);
    } catch (err) {
      throw new AppError(ERROR_CODES.E_DECODE, '音频解码失败，请换一个文件试试', err);
    }

    const srcRate = decoded.sampleRate;
    const channels = decoded.numberOfChannels;
    const length = decoded.length;

    // 1) 立体声 → 单声道
    const mono = new Float32Array(length);
    if (channels === 1) {
      mono.set(decoded.getChannelData(0));
    } else {
      const ch0 = decoded.getChannelData(0);
      const ch1 = decoded.getChannelData(1);
      for (let i = 0; i < length; i += 1) mono[i] = (ch0[i] + ch1[i]) / 2;
    }

    // 2) peaks（在原始采样率上每 512 采样一对 min/max）
    const peaks: [number, number][] = [];
    for (let i = 0; i < length; i += PEAK_CHUNK) {
      let min = 1;
      let max = -1;
      const end = Math.min(length, i + PEAK_CHUNK);
      for (let j = i; j < end; j += 1) {
        const v = mono[j];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (min > max) {
        min = 0;
        max = 0;
      }
      peaks.push([Math.max(-1, min), Math.min(1, max)]);
    }

    // 3) 线性插值重采样到 16 kHz
    const ratio = srcRate / TARGET_SAMPLE_RATE;
    const outLength = Math.max(1, Math.floor(length / ratio));
    const resampled = new Float32Array(outLength);
    for (let i = 0; i < outLength; i += 1) {
      const srcPos = i * ratio;
      const i0 = Math.floor(srcPos);
      const i1 = Math.min(length - 1, i0 + 1);
      const frac = srcPos - i0;
      resampled[i] = mono[i0] * (1 - frac) + mono[i1] * frac;
    }

    const trimmed = trimSilence(resampled);
    const normalized = peakNormalize(trimmed, 0.9);
    const stats = measure(normalized);

    return {
      pcm: normalized,
      sampleRate: TARGET_SAMPLE_RATE as 16000,
      durationSec: Math.min(MAX_AUDIO_SEC, normalized.length / TARGET_SAMPLE_RATE),
      peaks,
      rms: stats.rms,
      silenceRatio: stats.silenceRatio,
    };
  }

  // ── 麦克风录制（C-02）──────────────────────────────────────────
  /**
   * 最长 300 秒。用 MediaRecorder 落 Blob 再解码，避免引入 AudioWorklet。
   * onLevel 每帧回调 0–1 的输入电平；权限被拒抛 E_PERMISSION。
   */
  async recordMic(
    maxSec: number = MAX_AUDIO_SEC,
    onLevel?: (level: number) => void,
    onTick?: (elapsedSec: number) => void,
  ): Promise<{ blob: Blob; durationSec: number }> {
    if (!this.capabilities.getUserMedia) {
      throw new AppError(ERROR_CODES.E_PERMISSION, '当前浏览器不支持录音');
    }
    const ctx = this.ensure();
    if (!ctx) throw new AppError(ERROR_CODES.E_AUDIO, '当前浏览器不支持 Web Audio');

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      throw new AppError(ERROR_CODES.E_PERMISSION, '麦克风权限被拒绝', err);
    }

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);

    const recorder = new MediaRecorder(stream);
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    const startedAt = Date.now();
    const levelBuf = new Float32Array(analyser.fftSize);
    let raf = 0;
    const pump = () => {
      analyser.getFloatTimeDomainData(levelBuf);
      let sum = 0;
      for (let i = 0; i < levelBuf.length; i += 1) sum += levelBuf[i] * levelBuf[i];
      const rms = Math.sqrt(sum / levelBuf.length);
      onLevel?.(Math.min(1, rms * 4));
      onTick?.((Date.now() - startedAt) / 1000);
      if (recorder.state === 'recording') raf = requestAnimationFrame(pump);
    };

    const done = new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
    });

    recorder.start();
    raf = requestAnimationFrame(pump);

    const stop = () => {
      if (recorder.state === 'recording') recorder.stop();
      cancelAnimationFrame(raf);
      stream.getTracks().forEach((t) => t.stop());
      source.disconnect();
      analyser.disconnect();
      this.activeRecordingStop = null;
    };

    this.activeRecordingStop = stop;
    const timer = setTimeout(stop, maxSec * 1000);
    const blob = await done;
    clearTimeout(timer);
    stop();

    return { blob, durationSec: (Date.now() - startedAt) / 1000 };
  }

  /** 手动停止当前录音（供 UI「停止录音」按钮调用）；无录音进行中则无操作 */
  stopRecording(): void {
    this.activeRecordingStop?.();
  }
}

/** 去首尾静音：滑动窗 RMS < 0.005 视为静音 */
export function trimSilence(pcm: Float32Array, threshold = 0.005, window = 512): Float32Array {
  if (pcm.length === 0) return pcm;
  const isSilent = (from: number, to: number): boolean => {
    let sum = 0;
    const end = Math.min(to, pcm.length);
    for (let i = from; i < end; i += 1) sum += pcm[i] * pcm[i];
    return Math.sqrt(sum / Math.max(1, end - from)) < threshold;
  };

  let start = 0;
  while (start < pcm.length && isSilent(start, start + window)) start += window;
  let end = pcm.length;
  while (end > start && isSilent(Math.max(start, end - window), end)) end -= window;
  if (end <= start) return pcm.slice(0, Math.max(1, Math.min(pcm.length, window)));
  return pcm.slice(start, end);
}

export function peakNormalize(pcm: Float32Array, peak = 0.9): Float32Array {
  if (pcm.length === 0) return pcm;
  let max = 0;
  for (let i = 0; i < pcm.length; i += 1) max = Math.max(max, Math.abs(pcm[i]));
  if (max <= 0) return pcm;
  const g = peak / max;
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) out[i] = pcm[i] * g;
  return out;
}

export function measure(pcm: Float32Array): { rms: number; silenceRatio: number } {
  if (pcm.length === 0) return { rms: 0, silenceRatio: 1 };
  let sum = 0;
  let silentFrames = 0;
  let frames = 0;
  for (let i = 0; i < pcm.length; i += 512) {
    let frameSum = 0;
    const end = Math.min(pcm.length, i + 512);
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

export const audioEngine = new AudioEngine();
