/**
 * Karplus-Strong 拨弦合成 + 示范音轨（架构 §6.4 / T-09）。
 *
 * ★ 变速不变调的实现前提：合成参数（midi / 力度 / 衰减）与 tempo 完全无关。
 *   变速只改 tick→秒 的换算，绝不使用音源上的速率属性（架构 INV-4）。
 */
import type { TransportEvent } from '@/types/app';
import type { Midi } from '@/types/tab';
import { clamp } from '@/core/constants';
import { midiToFreq } from '@/core/fretboard';
import { tickToSec } from '@/core/tick';
import { audioEngine } from '@/audio/AudioEngine';

export interface KarplusOptions {
  freq: number;
  sampleRate: number;
  seconds: number;
  /** 0.494–0.5，越低衰减越快 */
  damping: number;
  /** 低通反馈系数，0.5 = 平均两点 */
  blend: number;
  /** 激励低通，0.2–0.9，力度越大越亮 */
  brightness: number;
  velocity: number;
}

interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * 二阶恒峰值带通谐振器系数（direct-form II transposed，a0 归一）。
 * 琴体共振用：只改频谱（谐振峰）不改基频、零 DC、线性时不变。
 */
export function resonatorCoeffs(freq: number, q: number, gain: number, sr: number): BiquadCoeffs {
  const w = (2 * Math.PI * freq) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (alpha * gain) / a0,
    b1: 0,
    b2: (-alpha * gain) / a0,
    a1: (-2 * Math.cos(w)) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** 谐振器叠加到信号（并联，保留干信号）：y = b0*x + z1 …，out[i] += y */
export function applyBiquad(buf: Float32Array<ArrayBuffer>, c: BiquadCoeffs): void {
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const x = buf[i];
    const y = c.b0 * x + z1;
    z1 = c.b1 * x - c.a1 * y + z2;
    z2 = c.b2 * x - c.a2 * y;
    buf[i] += y;
  }
}

/** 琴体共振：110Hz(Q4,G0.35) 木箱体暖感 + 200Hz(Q6,G0.25) 声板/空气感 */
export function bodyResonance(buf: Float32Array<ArrayBuffer>, sampleRate: number): void {
  applyBiquad(buf, resonatorCoeffs(110, 4, 0.35, sampleRate));
  applyBiquad(buf, resonatorCoeffs(200, 6, 0.25, sampleRate));
}

/** 扫弦级高频衰减：压制 2.5kHz 以上金属泛音（high-shelf 负增益）。命名常量便于试听调参。 */
export const STRUM_SHELF_FREQ = 2500;
export const STRUM_SHELF_GAIN_DB = -5;

/**
 * 二阶 high-shelf（RBJ）系数；gainDb 为负 → 高频衰减，只减不增，不削波。
 * 复用 BiquadCoeffs 结构与 direct-form II transposed 写法（与 resonatorCoeffs 同风格）。
 * 验证：H(DC)=1、H(Nyquist)=10^(gainDb/20)（负增益时 <1），零直流、线性时不变。
 */
export function highShelfCoeffs(freq: number, gainDb: number, sr: number): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freq) / sr;
  const cosw0 = Math.cos(w0);
  const alpha = (Math.sin(w0) / 2) * Math.sqrt(2); // S=1 默认 shelf 斜率
  const sqA = Math.sqrt(A);
  const b0 = A * ((A + 1) + (A - 1) * cosw0 + 2 * sqA * alpha);
  const b1 = -2 * A * ((A - 1) + (A + 1) * cosw0);
  const b2 = A * ((A + 1) + (A - 1) * cosw0 - 2 * sqA * alpha);
  const a0 = (A + 1) - (A - 1) * cosw0 + 2 * sqA * alpha;
  const a1 = 2 * ((A - 1) - (A + 1) * cosw0);
  const a2 = (A + 1) - (A - 1) * cosw0 - 2 * sqA * alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/**
 * 扫弦级高频软化：返回**新数组**，不改入参。
 * （PluckCache 命中返回的是共享引用，严禁原地改，故先 copy 再滤波。）
 */
export function strumFilter(buf: Float32Array<ArrayBuffer>, sr: number): Float32Array<ArrayBuffer> {
  const c = highShelfCoeffs(STRUM_SHELF_FREQ, STRUM_SHELF_GAIN_DB, sr);
  const out = new Float32Array(buf.length);
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const x = buf[i];
    const y = c.b0 * x + z1;
    z1 = c.b1 * x - c.a1 * y + z2;
    z2 = c.b2 * x - c.a2 * y;
    out[i] = y;
  }
  return out;
}

/**
 * Karplus-Strong 拨弦模型（纯函数，可单测）：
 *   白噪声激励 → 一阶低通 + 去直流 → 延迟线 + 一阶低通反馈循环
 *   → 指数衰减包络 + 3ms 淡入（消 click）+ 20ms 淡出
 */
export function karplus(o: KarplusOptions): Float32Array<ArrayBuffer> {
  const sampleRate = o.sampleRate > 0 ? o.sampleRate : 44100;
  const freq = Math.max(20, o.freq);
  const seconds = Math.max(0.02, o.seconds);
  const n = Math.max(2, Math.round(sampleRate / freq));
  const length = Math.max(1, Math.ceil(seconds * sampleRate));
  const out = new Float32Array(length);
  const delay = new Float32Array(n);

  // 1) 激励
  let lp = 0;
  let mean = 0;
  for (let i = 0; i < n; i += 1) {
    const white = Math.random() * 2 - 1;
    lp += clamp(o.brightness, 0.05, 1) * (white - lp);
    delay[i] = lp;
    mean += lp;
  }
  mean /= n;
  let peak = 0;
  for (let i = 0; i < n; i += 1) {
    delay[i] -= mean;
    peak = Math.max(peak, Math.abs(delay[i]));
  }
  if (peak > 0) {
    for (let i = 0; i < n; i += 1) delay[i] /= peak;
  }

  // 2) 延迟线循环：y[i] = loopGain × (blend × d[k] + (1 − blend) × d[k−1])
  //    damping 沿用架构 §6.4 的 0.494–0.5 记法：它是"半增益"，环增益 = 2 × damping
  //    （damping = 0.5 表示无损，越低衰减越快），否则音头会在 20ms 内死掉。
  const loopGain = clamp(2 * clamp(o.damping, 0.3, 0.5), 0.9, 1);
  const blend = clamp(o.blend, 0, 1);
  let idx = 0;
  let prev = 0;
  for (let i = 0; i < length; i += 1) {
    const cur = delay[idx];
    out[i] = cur;
    delay[idx] = loopGain * (blend * cur + (1 - blend) * prev);
    prev = cur;
    idx = (idx + 1) % n;
  }

  // 3) 包络（力度→衰减：强拨弦衰减更快，符合真实拨弦）
  const decayRate = (1.2 + freq / 400) * (1 + 0.8 * (clamp(o.velocity, 0, 1) - 0.5));
  const fadeIn = Math.max(1, Math.min(Math.round(0.003 * sampleRate), Math.floor(length / 8) || 1));
  const fadeOut = Math.max(1, Math.min(Math.round(0.02 * sampleRate), Math.floor(length / 4) || 1));
  const gain = clamp(o.velocity, 0, 1) * 0.9;
  for (let i = 0; i < length; i += 1) {
    let env = Math.exp((-i / sampleRate) * decayRate);
    if (i < fadeIn) env *= i / fadeIn;
    const tail = length - i;
    if (tail < fadeOut) env *= tail / fadeOut;
    out[i] *= env * gain;
  }

  // 4) 琴体共振：叠加两个低阶谐振峰（木箱体暖感），零 DC、LTI，只改频谱不改基频
  bodyResonance(out, sampleRate);

  // 5) 音头噪声（pick attack 瞬态）：~12ms 低通白噪声，tau=3ms，去掉「电子起音」
  const attackLen = Math.min(length, Math.round(0.012 * sampleRate));
  let lpNoise = 0;
  for (let i = 0; i < attackLen; i += 1) {
    const white = Math.random() * 2 - 1;
    lpNoise += 0.35 * (white - lpNoise);
    const env = Math.exp(-i / sampleRate / 0.003);
    out[i] += lpNoise * 0.25 * clamp(o.velocity, 0, 1) * env;
  }

  // 6) 削波保护：叠加共振+噪声后峰归一 0.98（保证 velocity=1 也不削波）
  let peakOut = 0;
  for (let i = 0; i < length; i += 1) peakOut = Math.max(peakOut, Math.abs(out[i]));
  if (peakOut > 0.98) {
    const g = 0.98 / peakOut;
    for (let i = 0; i < length; i += 1) out[i] *= g;
  }

  return out;
}

/** 力度档：5 档，减少缓存条目数 */
export function velocityBucket(velocity: number): number {
  return Math.round(clamp(velocity, 0, 1) * 4) / 4;
}

export function pluckKey(midi: Midi, velocity: number): string {
  return `${midi}:${velocityBucket(velocity)}`;
}

/** 音高越高衰减越快，低音弦留得久一点 */
export function pluckSeconds(midi: Midi): number {
  return clamp(2.6 - (midi - 40) * 0.045, 0.9, 2.6);
}

/** 高音衰减更快：环增益 = 2 × damping，取值落在架构 §6.4 的 0.494–0.5 区间 */
export function dampingFor(midi: Midi): number {
  return clamp(0.5 - (midi - 40) * 0.00006, 0.496, 0.5);
}

/**
 * 纯缓存层：按 (midi, 力度档) 缓存 Float32Array，不依赖 AudioContext。
 * 48 小节 × 6 音 ≈ 300 个音符，唯一组合通常 ≤ 40 → 命中率 > 90%。
 */
export class PluckCache {
  private readonly map = new Map<string, Float32Array<ArrayBuffer>>();
  private hitCount = 0;
  private missCount = 0;

  constructor(private readonly sampleRate: number = 44100) {}

  get size(): number {
    return this.map.size;
  }

  get hits(): number {
    return this.hitCount;
  }

  get misses(): number {
    return this.missCount;
  }

  get(midi: Midi, velocity: number): Float32Array<ArrayBuffer> {
    const key = pluckKey(midi, velocity);
    const cached = this.map.get(key);
    if (cached) {
      this.hitCount += 1;
      return cached;
    }
    this.missCount += 1;
    const samples = karplus({
      freq: midiToFreq(midi),
      sampleRate: this.sampleRate,
      seconds: pluckSeconds(midi),
      damping: dampingFor(midi),
      blend: 0.5,
      brightness: clamp(0.25 + velocity * 0.6, 0.2, 0.9),
      velocity,
    });
    this.map.set(key, samples);
    return samples;
  }

  clear(): void {
    this.map.clear();
    this.hitCount = 0;
    this.missCount = 0;
  }
}

export interface PluckOptions {
  midi: Midi;
  velocity: number;
  /** AudioContext 绝对时间（秒） */
  when?: number;
  durationSec?: number;
  /** 闷音：截断到 ~60ms 并额外衰减 6dB */
  mute?: boolean;
  /** 扫弦：走 strumFilter 软化高频（单音缓存仍共享，仅 AudioBuffer 走独立二级缓存） */
  strum?: boolean;
}

/** 合成器：AudioBuffer 缓存 + 三条总线（master / metronome / demo） */
export class Synth {
  private readonly cache: PluckCache;
  private readonly buffers = new Map<string, AudioBuffer>();
  /** 扫弦路径的独立 AudioBuffer 缓存：消费单音缓存副本 → strumFilter → 单独缓存 */
  private readonly strumBuffers = new Map<string, AudioBuffer>();
  private disposed = false;

  constructor(sampleRate?: number) {
    this.cache = new PluckCache(sampleRate ?? audioEngine.context?.sampleRate ?? 44100);
  }

  get ready(): boolean {
    return audioEngine.context !== null;
  }

  get stats(): { samples: number; buffers: number; hits: number; misses: number } {
    return {
      samples: this.cache.size,
      buffers: this.buffers.size,
      hits: this.cache.hits,
      misses: this.cache.misses,
    };
  }

  async ensureContext(): Promise<void> {
    await audioEngine.resume();
  }

  private bufferFor(midi: Midi, velocity: number): AudioBuffer | null {
    const key = pluckKey(midi, velocity);
    const cached = this.buffers.get(key);
    if (cached) return cached;

    const ctx = audioEngine.context;
    if (!ctx) return null;
    const samples = this.cache.get(midi, velocity);
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buffer.copyToChannel(samples, 0);
    this.buffers.set(key, buffer);
    return buffer;
  }

  private bufferForStrum(midi: Midi, velocity: number): AudioBuffer | null {
    const key = pluckKey(midi, velocity);
    const cached = this.strumBuffers.get(key);
    if (cached) return cached;

    const ctx = audioEngine.context;
    if (!ctx) return null;
    const base = this.cache.get(midi, velocity); // 共享单音缓存（只读引用）
    const filtered = strumFilter(base, ctx.sampleRate); // 副本滤波，不改 base
    const buffer = ctx.createBuffer(1, filtered.length, ctx.sampleRate);
    buffer.copyToChannel(filtered, 0);
    this.strumBuffers.set(key, buffer);
    return buffer;
  }

  pluck(o: PluckOptions): void {
    if (this.disposed) return;
    const ctx = audioEngine.context;
    const demo = audioEngine.bus.demo;
    if (!ctx || !demo) return;

    const buffer = o.strum ? this.bufferForStrum(o.midi, o.velocity) : this.bufferFor(o.midi, o.velocity);
    if (!buffer) return;

    const when = Math.max(ctx.currentTime, o.when ?? ctx.currentTime);
    const duration = o.mute
      ? Math.min(0.06, o.durationSec ?? 0.06)
      : Math.max(0.08, o.durationSec ?? pluckSeconds(o.midi));

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(o.mute ? 0.5 : 1, when);
    const releaseStart = Math.max(when, when + duration - 0.03);
    gain.gain.setValueAtTime(o.mute ? 0.5 : 1, releaseStart);
    gain.gain.linearRampToValueAtTime(0, when + duration);

    src.connect(gain);
    gain.connect(demo);
    src.start(when);
    src.stop(when + duration + 0.02);
  }

  /** 扫弦：多个 source 以 offsetSec 依次触发（架构 §6.4，不用 AudioWorklet） */
  rake(notes: { midi: Midi; velocity: number; offsetSec: number; durationSec: number }[]): void {
    const ctx = audioEngine.context;
    if (!ctx) return;
    const t0 = ctx.currentTime;
    for (const n of notes) {
      this.pluck({
        midi: n.midi,
        velocity: n.velocity,
        when: t0 + Math.max(0, n.offsetSec),
        durationSec: n.durationSec,
        strum: true,
      });
    }
  }

  setBusGain(bus: 'master' | 'metronome' | 'demo', v: number): void {
    audioEngine.setBusGain(bus, v);
  }

  dispose(): void {
    this.disposed = true;
    this.buffers.clear();
    this.strumBuffers.clear();
    this.cache.clear();
  }
}

// ── 示范音轨 ──────────────────────────────────────────────────────
export interface ScheduleSource {
  onSchedule(cb: (e: TransportEvent) => void): () => void;
  readonly currentBpm: number;
}

/**
 * 订阅 Transport.onSchedule（唯一调度出口，架构 INV-3），
 * 把 note 事件翻译成合成器拨弦。闷音（stroke === 'X'）截断到 60ms。
 */
export class DemoTrack {
  private detachFn: (() => void) | null = null;
  private volume = 0.8;
  private enabled = true;

  constructor(private readonly synth: Synth) {}

  attach(transport: ScheduleSource): void {
    this.detachFn?.();
    this.detachFn = transport.onSchedule((e) => {
      if (!this.enabled || e.kind !== 'note' || !e.note) return;
      const durationSec = Math.max(0.05, tickToSec(e.note.durationTick, transport.currentBpm));
      this.synth.pluck({
        midi: e.note.midi,
        velocity: e.note.velocity,
        when: e.when,
        durationSec,
        mute: e.note.stroke === 'X',
        strum: e.note.stroke === 'D' || e.note.stroke === 'U',
      });
    });
  }

  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    this.synth.setBusGain('demo', this.enabled ? this.volume : 0);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.synth.setBusGain('demo', on ? this.volume : 0);
  }

  dispose(): void {
    this.detachFn?.();
    this.detachFn = null;
  }
}
