/**
 * 节拍器（PRD B-05，架构 §6.4 / T-09）。
 * 与示范音轨共享同一个 tempo 来源：when 只能从 Transport.onSchedule 拿（架构 INV-3）。
 */
import type { BeatInfo, TransportEvent } from '@/types/app';
import { TICKS_PER_BEAT, clamp } from '@/core/constants';
import { audioEngine } from '@/audio/AudioEngine';

export const ACCENT_FREQ = 1200;
export const NORMAL_FREQ = 800;
export const CLICK_MS = 20;

/**
 * 纯函数：渲染一次点击的采样（短促正弦 + 指数衰减）。
 * 重音 1200Hz、其余 800Hz；重音峰值 ×1.6。
 */
export function renderClick(sampleRate: number, freq: number, accent: boolean): Float32Array<ArrayBuffer> {
  const length = Math.max(1, Math.round((CLICK_MS / 1000) * sampleRate));
  const out = new Float32Array(length);
  const peak = accent ? 0.64 : 0.4;
  const decay = 220;
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    const env = Math.exp(-t * decay);
    const fadeIn = Math.min(1, i / Math.max(1, sampleRate * 0.001));
    out[i] = Math.sin(2 * Math.PI * freq * t) * env * peak * fadeIn;
  }
  return out;
}

export interface ScheduleSource {
  onSchedule(cb: (e: TransportEvent) => void): () => void;
}

export interface MetronomeDeps {
  context: () => AudioContext | null;
  bus: () => GainNode | null;
}

export class Metronome {
  private detachFn: (() => void) | null = null;
  private enabled = true;
  private volume = 0.7;
  private readonly buffers = new Map<string, AudioBuffer>();

  constructor(private readonly deps: MetronomeDeps) {}

  attach(transport: ScheduleSource): void {
    this.detachFn?.();
    this.detachFn = transport.onSchedule((e) => {
      if (!this.enabled || e.kind !== 'beat' || !e.beat) return;
      this.fire(e.when, e.beat);
    });
  }

  detach(): void {
    this.detachFn?.();
    this.detachFn = null;
  }

  private fire(when: number, beat: BeatInfo): void {
    const ctx = this.deps.context();
    const bus = this.deps.bus();
    if (!ctx || !bus) return;

    // 非正拍的细分音轻一点，避免听觉噪声
    const onBeat = beat.tick % TICKS_PER_BEAT === 0;
    const freq = beat.accent ? ACCENT_FREQ : NORMAL_FREQ;
    const key = `${freq}:${beat.accent ? 'a' : 'n'}`;

    let buffer = this.buffers.get(key);
    if (!buffer) {
      buffer = ctx.createBuffer(1, Math.max(1, Math.round((CLICK_MS / 1000) * ctx.sampleRate)), ctx.sampleRate);
      buffer.copyToChannel(renderClick(ctx.sampleRate, freq, beat.accent), 0);
      this.buffers.set(key, buffer);
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = onBeat ? 1 : 0.6;
    src.connect(gain);
    gain.connect(bus);
    src.start(when);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.applyGain();
  }

  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    this.applyGain();
  }

  private applyGain(): void {
    audioEngine.setBusGain('metronome', this.enabled ? this.volume : 0);
  }

  dispose(): void {
    this.detach();
    this.buffers.clear();
  }
}

/** 便捷工厂：接入全局 AudioEngine 的三条总线 */
export function createMetronome(): Metronome {
  return new Metronome({
    context: () => audioEngine.context,
    bus: () => audioEngine.bus.metronome,
  });
}
