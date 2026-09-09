/**
 * tick 数学（PRD §5.1，架构 §9.2）。
 * 全项目**只有**位置/时长用 tick；秒只出现在 Transport 内部与 Synth 的 when。
 */
import type { BeatInfo, TransportLoadOptions } from '@/types/app';
import type { Tick, TimeSignature } from '@/types/tab';
import { TICKS_PER_BEAT } from '@/core/constants';

/** tick → 秒：tick × 60 / (480 × bpm) */
export function tickToSec(tick: number, bpm: number, ticksPerBeat: number = TICKS_PER_BEAT): number {
  if (bpm <= 0) return 0;
  return (tick * 60) / (ticksPerBeat * bpm);
}

/** 秒 → tick */
export function secToTick(sec: number, bpm: number, ticksPerBeat: number = TICKS_PER_BEAT): number {
  return (sec * ticksPerBeat * bpm) / 60;
}

/** 一小节的 tick 数：numerator / denominator × 4 × 480 */
export function measureTicks(
  timeSignature: TimeSignature,
  ticksPerBeat: number = TICKS_PER_BEAT,
): number {
  return Math.round(((timeSignature[0] / timeSignature[1]) * 4 * ticksPerBeat));
}

export function measureIndexOf(
  tick: Tick,
  timeSignature: TimeSignature,
  ticksPerBeat: number = TICKS_PER_BEAT,
): number {
  const per = measureTicks(timeSignature, ticksPerBeat);
  if (per <= 0) return 0;
  return Math.max(0, Math.floor(tick / per));
}

export function measureStartTick(
  index: number,
  timeSignature: TimeSignature,
  ticksPerBeat: number = TICKS_PER_BEAT,
): number {
  return Math.max(0, index) * measureTicks(timeSignature, ticksPerBeat);
}

/** 严格大于 tick 的下一条小节线（用于渐进加速"下一小节生效"） */
export function nextMeasureLine(
  tick: Tick,
  timeSignature: TimeSignature,
  ticksPerBeat: number = TICKS_PER_BEAT,
): number {
  return measureStartTick(measureIndexOf(tick, timeSignature, ticksPerBeat) + 1, timeSignature, ticksPerBeat);
}

export interface LoopRange {
  start: Tick;
  end: Tick;
}

/**
 * A-B 循环的跳转目标：播放头越过 loop.end 时回到 loop.start。
 * 无循环且越过曲尾时返回 null（由调用方决定 stop 或回到 0）。
 */
export function loopJumpTarget(
  tick: Tick,
  loop: LoopRange | null,
  totalTicks: Tick,
): { tick: Tick; roundEnd: boolean } | null {
  if (loop && tick >= loop.end) return { tick: loop.start, roundEnd: true };
  if (tick >= totalTicks) return { tick: 0, roundEnd: false };
  return null;
}

/** 归一化拍号字符串，便于比较与展示 */
export function timeSignatureKey(ts: TimeSignature): '4/4' | '3/4' {
  return ts[0] === 3 && ts[1] === 4 ? '3/4' : '4/4';
}

/**
 * 枚举 [fromTick, toTick) 区间内的所有拍点（含 subdivision）。
 * count-in 期间 fromTick 为负，accent 仍按"每小节第一拍"判定。
 */
export function enumerateBeats(opts: {
  fromTick: Tick;
  toTick: Tick;
  timeSignature: TimeSignature;
  subdivision: 1 | 2 | 4;
  ticksPerBeat?: number;
}): BeatInfo[] {
  const tpb = opts.ticksPerBeat ?? TICKS_PER_BEAT;
  const per = measureTicks(opts.timeSignature, tpb);
  const step = Math.max(1, Math.round(tpb / opts.subdivision));
  const out: BeatInfo[] = [];

  const first = Math.ceil(opts.fromTick / step) * step;
  let index = 0;
  for (let t = first; t < opts.toTick; t += step) {
    const inMeasure = ((t % per) + per) % per;
    out.push({
      tick: t,
      index,
      accent: inMeasure === 0,
      subdivision: opts.subdivision,
    });
    index += 1;
  }
  return out;
}

/** 从 TransportLoadOptions 派生总 tick 数（供 UI 与调度器共享） */
export function totalTicksOf(opts: Pick<TransportLoadOptions, 'totalTicks'>): Tick {
  return Math.max(0, opts.totalTicks);
}
