/**
 * ★ Transport：唯一时间与 tempo 真相源（架构 §6.1–§6.3 / T-10）。
 *
 * 核心：锚点（anchor）分段线性映射。tempo 会变，所以 tick ↔ AudioContext 时间
 * 不能用单一线性公式，而以「最近一次 tempo 生效点」为锚点：
 *   tickToTime(t) = a.ctxTime + (t − a.tick) × 60 / (a.bpm × 480)
 *   timeToTick(s) = a.tick + (s − a.ctxTime) × a.bpm × 480 / 60
 *
 * 不变量：
 *   INV-1 anchor 只在 play() / seek() / applyPendingTempo() 三处被改写。
 *   INV-2 已 start(when) 的音符永不撤销（无爆音）。
 *   INV-3 Metronome / DemoTrack 只能经 onSchedule 拿 when。
 *   INV-4 任何发声路径都不使用音源的速率属性（变速靠重新调度，天然保音高）。
 */
import type {
  BeatInfo,
  BoundaryEvent,
  ScheduledNote,
  Transport as TransportInterface,
  TransportEvent,
  TransportLoadOptions,
} from '@/types/app';
import type { Tick, TimeSignature } from '@/types/tab';
import { LOOKAHEAD, SCHEDULER_MS, TICKS_PER_BEAT, clamp } from '@/core/constants';
import { measureIndexOf, measureStartTick, nextMeasureLine } from '@/core/tick';
import { audioEngine } from '@/audio/AudioEngine';

export interface Anchor {
  ctxTime: number;
  tick: Tick;
  bpm: number;
}

/** tick → AudioContext 绝对时间（秒） */
export function anchorTickToTime(a: Anchor, tick: Tick, ticksPerBeat: number = TICKS_PER_BEAT): number {
  if (a.bpm <= 0) return a.ctxTime;
  return a.ctxTime + ((tick - a.tick) * 60) / (a.bpm * ticksPerBeat);
}

/** AudioContext 绝对时间（秒）→ tick */
export function anchorTimeToTick(a: Anchor, t: number, ticksPerBeat: number = TICKS_PER_BEAT): number {
  return a.tick + ((t - a.ctxTime) * a.bpm * ticksPerBeat) / 60;
}

export type ScheduleCallback = (e: TransportEvent) => void;
export type BoundaryCallback = (e: BoundaryEvent) => void;

export class TransportImpl implements TransportInterface {
  private notes: ScheduledNote[] = [];
  private opts: TransportLoadOptions = {
    bpm: 90,
    timeSignature: [4, 4],
    ticksPerBeat: TICKS_PER_BEAT,
    totalTicks: 0,
    loop: null,
  };
  private anchor: Anchor = { ctxTime: 0, tick: 0, bpm: 90 };
  private pendingTempo: number | null = null;
  private pendingTempoAt: Tick | null = null;
  private cursorNote = 0;
  private cursorBeat: Tick = 0;
  private subdivision: 1 | 2 | 4 = 1;
  private playing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private scheduleCbs = new Set<ScheduleCallback>();
  private boundaryCbs = new Set<BoundaryCallback>();
  private lastMeasureIndex = -1;
  private disposed = false;

  // ── 时钟 ────────────────────────────────────────────────────────
  /** 有 AudioContext 用采样时钟（不漂移），否则退回 performance.now() */
  private now(): number {
    const ctx = audioEngine.context;
    if (ctx) return ctx.currentTime;
    return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
  }

  get timeSignature(): TimeSignature {
    return this.opts.timeSignature;
  }

  private get measureTicks(): number {
    const [num, den] = this.opts.timeSignature;
    return Math.round((num / den) * 4 * this.opts.ticksPerBeat);
  }

  private get beatStep(): number {
    return Math.max(1, Math.round(this.opts.ticksPerBeat / this.subdivision));
  }

  private get endTick(): Tick {
    return this.opts.loop ? this.opts.loop.end : this.opts.totalTicks;
  }

  get currentTick(): Tick {
    if (!this.playing) return this.anchor.tick;
    return anchorTimeToTick(this.anchor, this.now(), this.opts.ticksPerBeat);
  }

  get currentBpm(): number {
    return this.anchor.bpm;
  }

  /** 当前小节号：由 currentTick 派生（单一真相源），供播放头与高亮同源对齐 */
  get currentMeasure(): number {
    return measureIndexOf(this.currentTick, this.opts.timeSignature, this.opts.ticksPerBeat);
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  // ── 装载与播放 ──────────────────────────────────────────────────
  load(notes: ScheduledNote[], opts: TransportLoadOptions): void {
    this.notes = [...notes].sort((a, b) => a.tick - b.tick);
    this.opts = { ...opts, ticksPerBeat: TICKS_PER_BEAT };
    this.anchor = { ctxTime: this.now(), tick: 0, bpm: opts.bpm };
    this.pendingTempo = null;
    this.pendingTempoAt = null;
    this.resetCursors(0);
  }

  async play(fromTick?: Tick, opts?: { countInBars?: number }): Promise<void> {
    if (this.disposed) return;
    await audioEngine.resume();

    const countInBars = Math.max(0, opts?.countInBars ?? 0);
    const target = fromTick ?? this.anchor.tick;
    const begin = countInBars > 0 ? target - countInBars * this.measureTicks : target;

    this.anchor = { ctxTime: this.now(), tick: begin, bpm: this.anchor.bpm };
    this.resetCursors(begin);
    this.playing = true;
    this.startTimer();
  }

  pause(): void {
    if (!this.playing) return;
    // 冻结：把当前 tick 写回锚点，恢复时从该 tick 继续
    const tick = this.currentTick;
    this.anchor = { ctxTime: this.now(), tick, bpm: this.anchor.bpm };
    this.playing = false;
    this.stopTimer();
  }

  stop(): void {
    this.playing = false;
    this.stopTimer();
    this.anchor = { ctxTime: this.now(), tick: this.opts.loop?.start ?? 0, bpm: this.anchor.bpm };
    this.resetCursors(this.anchor.tick);
  }

  seek(tick: Tick): void {
    const target = Math.max(0, tick);
    this.anchor = { ctxTime: this.now(), tick: target, bpm: this.anchor.bpm };
    this.resetCursors(target);
  }

  /** 默认在下一个小节线生效（渐进加速提速）；immediate = true 用于拖变速滑块 */
  setTempo(bpm: number, o?: { immediate?: boolean }): void {
    const next = clamp(Math.round(bpm), 1, 400);
    if (o?.immediate) {
      const tick = this.currentTick;
      this.anchor = { ctxTime: this.now(), tick, bpm: next };
      this.pendingTempo = null;
      this.pendingTempoAt = null;
      this.resetCursors(tick);
      return;
    }
    this.pendingTempo = next;
    this.pendingTempoAt = nextMeasureLine(this.currentTick, this.opts.timeSignature, this.opts.ticksPerBeat);
  }

  setLoop(range: { start: Tick; end: Tick } | null): void {
    this.opts = { ...this.opts, loop: range ? { ...range } : null };
    if (range) {
      const tick = this.currentTick;
      if (tick < range.start || tick >= range.end) {
        this.anchor = { ctxTime: this.now(), tick: range.start, bpm: this.anchor.bpm };
        this.resetCursors(range.start);
      }
    }
  }

  setSubdivision(sub: 1 | 2 | 4): void {
    this.subdivision = sub;
    this.cursorBeat = Math.ceil(this.currentTick / this.beatStep) * this.beatStep;
  }

  // ── 订阅 ────────────────────────────────────────────────────────
  onSchedule(cb: ScheduleCallback): () => void {
    this.scheduleCbs.add(cb);
    return () => this.scheduleCbs.delete(cb);
  }

  onBoundary(cb: BoundaryCallback): () => void {
    this.boundaryCbs.add(cb);
    return () => this.boundaryCbs.delete(cb);
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimer();
    this.scheduleCbs.clear();
    this.boundaryCbs.clear();
  }

  // ── 内部 ────────────────────────────────────────────────────────
  private resetCursors(tick: Tick): void {
    this.cursorNote = this.locate(tick);
    this.cursorBeat = Math.ceil(tick / this.beatStep) * this.beatStep;
    this.lastMeasureIndex = Math.max(-1, measureIndexOf(tick, this.opts.timeSignature, this.opts.ticksPerBeat));
  }

  /** 第一个 tick >= target 的音符下标 */
  private locate(tick: Tick): number {
    let lo = 0;
    let hi = this.notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.notes[mid].tick < tick) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => this.pump(), SCHEDULER_MS);
    this.pump();
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 25ms 调度循环 + 0.1s lookahead（架构 §6.2） */
  private pump(): void {
    if (!this.playing) return;
    const now = this.now();
    const horizon = now + LOOKAHEAD;

    while (this.cursorNote < this.notes.length) {
      const note = this.notes[this.cursorNote];
      // 预备拍区（负 tick）不出声；循环区外的音符跳过
      if (note.tick < 0 || (this.opts.loop && note.tick >= this.opts.loop.end)) {
        this.cursorNote += 1;
        continue;
      }
      const when = anchorTickToTime(this.anchor, note.tick, this.opts.ticksPerBeat);
      if (when >= horizon) break;
      this.emitSchedule({ kind: 'note', tick: note.tick, when, note });
      this.cursorNote += 1;
    }

    while (this.cursorBeat < this.endTick) {
      const when = anchorTickToTime(this.anchor, this.cursorBeat, this.opts.ticksPerBeat);
      if (when >= horizon) break;
      this.emitSchedule({ kind: 'beat', tick: this.cursorBeat, when, beat: this.beatOf(this.cursorBeat) });
      this.cursorBeat += this.beatStep;
    }

    this.checkBoundaries(now);
  }

  private beatOf(tick: Tick): BeatInfo {
    const per = this.measureTicks;
    const inMeasure = ((tick % per) + per) % per;
    return {
      tick,
      index: Math.round(inMeasure / this.beatStep),
      accent: inMeasure === 0,
      subdivision: this.subdivision,
    };
  }

  private checkBoundaries(now: number): void {
    let cur = anchorTimeToTick(this.anchor, now, this.opts.ticksPerBeat);

    // 1) 待生效的 tempo：跨过小節线才改写 anchor
    if (this.pendingTempo !== null && this.pendingTempoAt !== null && cur >= this.pendingTempoAt) {
      const at = this.pendingTempoAt;
      const nextBpm = this.pendingTempo;
      this.anchor = { ctxTime: anchorTickToTime(this.anchor, at, this.opts.ticksPerBeat), tick: at, bpm: nextBpm };
      this.pendingTempo = null;
      this.pendingTempoAt = null;
      this.cursorNote = this.locate(at);
      this.cursorBeat = Math.ceil(at / this.beatStep) * this.beatStep;
      this.emitBoundary({
        kind: 'tempoApplied',
        tick: at,
        measureIndex: measureIndexOf(at, this.opts.timeSignature, this.opts.ticksPerBeat),
        bpm: nextBpm,
      });
      cur = anchorTimeToTick(this.anchor, now, this.opts.ticksPerBeat);
    }

    // 2) 一轮结束（有循环）→ 不 stop，直接把锚点搬回 loop.start
    if (this.opts.loop && cur >= this.opts.loop.end) {
      const loop = this.opts.loop;
      this.emitBoundary({
        kind: 'roundEnd',
        tick: loop.end,
        measureIndex: measureIndexOf(loop.end, this.opts.timeSignature, this.opts.ticksPerBeat),
        bpm: this.anchor.bpm,
      });
      this.anchor = { ctxTime: now, tick: loop.start, bpm: this.anchor.bpm };
      this.cursorNote = this.locate(loop.start);
      this.cursorBeat = Math.ceil(loop.start / this.beatStep) * this.beatStep;
      this.lastMeasureIndex = Math.max(
        -1,
        measureIndexOf(loop.start, this.opts.timeSignature, this.opts.ticksPerBeat),
      );
      return;
    }

    // 3) 曲尾
    if (cur >= this.opts.totalTicks && this.opts.totalTicks > 0) {
      this.emitBoundary({
        kind: 'end',
        tick: this.opts.totalTicks,
        measureIndex: measureIndexOf(this.opts.totalTicks, this.opts.timeSignature, this.opts.ticksPerBeat),
        bpm: this.anchor.bpm,
      });
      this.stop();
      return;
    }

    // 4) 跨小节（低频事件，供 React 与 MeasureCovered 使用）
    const mi = measureIndexOf(cur, this.opts.timeSignature, this.opts.ticksPerBeat);
    if (mi > this.lastMeasureIndex) {
      for (let m = Math.max(0, this.lastMeasureIndex); m < mi; m += 1) {
        this.emitBoundary({
          kind: 'measure',
          tick: measureStartTick(m, this.opts.timeSignature, this.opts.ticksPerBeat),
          measureIndex: m,
          bpm: this.anchor.bpm,
        });
      }
      this.lastMeasureIndex = mi;
    }
  }

  private emitSchedule(e: TransportEvent): void {
    for (const cb of this.scheduleCbs) cb(e);
  }

  private emitBoundary(e: BoundaryEvent): void {
    for (const cb of this.boundaryCbs) cb(e);
  }
}

export function createTransport(): TransportInterface {
  return new TransportImpl();
}
