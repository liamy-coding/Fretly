/**
 * ★ practiceController：练习会话唯一编排器（架构 §5.2 / §5.4，T-17）。
 *
 * 职责：
 *  - 订阅 Transport.onBoundary（低频）→ 翻译成 PracticeEvent → reducePractice → 节流写库
 *  - 会话开始/结束判定（首次播放 / 暂停 ≥60s / 离开页面 / 标签页隐藏 ≥5min）
 *  - 渐进加速训练状态机（startBpm / pass / raise）
 *  - 节拍器 / 示范音轨的开关与音量
 *
 * 铁律：
 *  - 只有本文件能派发 PracticeEvent（R5）
 *  - 熟练度只在 SessionEnded 时由 reducePractice 内 recomputeMastery 重算一次
 *  - 变速不用音源速率属性；只调 Transport.setTempo
 */
import type {
  BoundaryEvent,
  PracticeSession,
  Transport as TransportInterface,
  TransportLoadOptions,
} from '@/types/app';
import type { Marker, Tab, TabId, Tick } from '@/types/tab';
import {
  COUNTED_MIN_SEC,
  MAX_BPM,
  MAX_RATIO,
  MIN_BPM,
  MIN_RATIO,
  NEXT_CHORD_LOOKAHEAD_TICKS,
  PAUSE_END_SEC,
  PASS_WINDOW_MS,
  clamp,
  nowIso,
} from '@/core/constants';
import type {
  PracticeEvent,
  ProgressiveConfig,
  ProgressiveState,
} from '@/core/progressive';
import {
  applyRaise,
  computeTargetBpm,
  createProgressive,
  reducePractice,
  registerFail,
  registerPass,
} from '@/core/progressive';
import { newId } from '@/core/id';
import { flattenNotes, tabToScheduledNotes, totalTicksOfTab } from '@/core/tabFactory';
import { measureIndexOf, measureStartTick, tickToSec } from '@/core/tick';
import { fretToMidi } from '@/core/fretboard';
import { audioEngine } from '@/audio/AudioEngine';
import { createTransport } from '@/audio/Transport';
import { DemoTrack, Synth } from '@/audio/synth';
import { createMetronome } from '@/audio/metronome';
import { tabRepo } from '@/storage/tabRepo';
import { useAppStore } from '@/state/useAppStore';
import {
  usePracticeStore,
  type LoopRange,
  type Subdivision,
} from '@/state/usePracticeStore';

interface SessionTrack {
  active: boolean;
  tabId: TabId | null;
  startedAt: string;
  startBpm: number;
  endBpm: number;
  rounds: number;
  passedRounds: number;
  progressiveUsed: boolean;
  /** 本会话新增覆盖的小节（SessionEnded 一次性合并） */
  newCovered: number[];
  effectiveSeconds: number;
  pauseTimer: ReturnType<typeof setTimeout> | null;
  playSince: number | null;
}

class PracticeController {
  private transport: TransportInterface | null = null;
  private synth: Synth | null = null;
  private demoTrack: DemoTrack | null = null;
  private metronome: ReturnType<typeof createMetronome> | null = null;

  private tab: Tab | null = null;
  private totalTicks = 0;
  private currentLoop: LoopRange | null = null;
  private session: SessionTrack = {
    active: false,
    tabId: null,
    startedAt: '',
    startBpm: 0,
    endBpm: 0,
    rounds: 0,
    passedRounds: 0,
    progressiveUsed: false,
    newCovered: [],
    effectiveSeconds: 0,
    pauseTimer: null,
    playSince: null,
  };
  private prog: ProgressiveState | null = null;
  private passWindowTimer: ReturnType<typeof setTimeout> | null = null;
  private passDeadline = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushAt = 0;
  private secTicker: ReturnType<typeof setInterval> | null = null;
  private lastEmittedMeasure = -1;

  // ── 初始化 ──────────────────────────────────────────────────────
  private ensure(): { transport: TransportInterface; synth: Synth; demo: DemoTrack } {
    if (!this.transport) {
      this.transport = createTransport();
      this.synth = new Synth();
      this.demoTrack = new DemoTrack(this.synth);
      this.demoTrack.attach(this.transport);
      this.metronome = createMetronome();
      this.metronome.attach(this.transport);
      const settings = useAppStore.getState().settings;
      this.demoTrack.setVolume(settings.demoTrack.volume);
      this.demoTrack.setEnabled(settings.demoTrack.enabled);
      this.metronome.setVolume(0.7);
      this.metronome.setEnabled(false);
      this.transport.onBoundary((e) => this.handleBoundary(e));
    }
    return { transport: this.transport!, synth: this.synth!, demo: this.demoTrack! };
  }

  get isReady(): boolean {
    return this.transport !== null;
  }

  get currentTab(): Tab | null {
    return this.tab;
  }

  get currentBpm(): number {
    return this.transport?.currentBpm ?? this.tab?.bpm ?? 0;
  }

  get currentTick(): number {
    return this.transport?.currentTick ?? 0;
  }

  get playing(): boolean {
    return this.transport?.isPlaying ?? false;
  }

  get transportBpm(): number {
    return this.transport?.currentBpm ?? 0;
  }

  get totalTicksOfSong(): number {
    return this.totalTicks;
  }

  // ── 装载 ────────────────────────────────────────────────────────
  loadTab(tab: Tab): void {
    const { transport } = this.ensure();
    this.tab = tab;
    this.totalTicks = totalTicksOfTab(tab);
    this.lastEmittedMeasure = -1;
    const notes = tabToScheduledNotes(tab);
    const opts: TransportLoadOptions = {
      bpm: tab.bpm,
      timeSignature: tab.timeSignature,
      ticksPerBeat: 480,
      totalTicks: this.totalTicks,
      loop: null,
    };
    transport.load(notes, opts);
    this.setTempoInternal(tab.bpm);
    usePracticeStore.getState().setTab(tab);
    usePracticeStore.getState().setCurrentBpm(tab.bpm);
    // 双保险：换曲后首屏小节高亮/右栏预告归 0（setTab 已重置，此处显式兜底）
    usePracticeStore.getState().setCurrentMeasure(0);
    usePracticeStore.getState().setSession({
      active: false,
      startedAt: null,
      effectiveSeconds: 0,
      startBpm: 0,
      endBpm: 0,
      rounds: 0,
      passedRounds: 0,
      progressiveUsed: false,
    });
    this.endActiveSessionIfAny();
  }

  // ── 播放控制 ────────────────────────────────────────────────────
  async play(fromTick?: Tick, opts?: { countInBars?: number }): Promise<void> {
    const { transport } = this.ensure();
    await audioEngine.resume();
    const settings = useAppStore.getState().settings;
    const countInBars =
      opts?.countInBars ??
      (settings.metronome.countIn && settings.metronome.enabled ? 1 : 0);
    if (!this.session.active) this.beginSession();
    await transport.play(fromTick ?? this.transport?.currentTick ?? 0, countInBars > 0 ? { countInBars } : undefined);
    this.syncMeasureState();
    usePracticeStore.getState().setPlaying(true);
    this.startSecTicker();
  }

  async togglePlay(): Promise<void> {
    if (this.transport?.isPlaying) {
      this.pause();
    } else {
      await this.play();
    }
  }

  pause(): void {
    const { transport } = this.ensure();
    transport.pause();
    usePracticeStore.getState().setPlaying(false);
    this.recordPlayTime();
    this.stopSecTicker();
    if (this.session.active) {
      // 暂停 ≥60s → 自动结束会话
      this.clearPauseTimer();
      this.session.pauseTimer = setTimeout(() => {
        if (this.session.active) this.endSession();
      }, PAUSE_END_SEC * 1000);
    }
  }

  resumeFromPause(): void {
    this.clearPauseTimer();
    void this.play();
  }

  seek(tick: Tick): void {
    const { transport } = this.ensure();
    transport.seek(Math.max(0, Math.round(tick)));
    this.syncMeasureState();
  }

  private seekToMeasure(index: number): void {
    const tab = this.tab;
    if (!tab) return;
    const per = tab.tracks[0]?.measures[index]?.ticks ?? 0;
    if (per <= 0) return;
    const target = measureStartTick(index, tab.timeSignature);
    if (this.transport?.isPlaying) {
      this.seek(target);
    } else {
      this.seek(target);
    }
    usePracticeStore.getState().setCurrentMeasure(index);
  }

  prevMeasure(): void {
    const idx = Math.max(0, this.currentMeasureIndex() - 1);
    this.seekToMeasure(idx);
  }

  nextMeasure(): void {
    const tab = this.tab;
    if (!tab) return;
    const count = tab.tracks[0]?.measures.length ?? 0;
    const idx = Math.min(count - 1, this.currentMeasureIndex() + 1);
    this.seekToMeasure(idx);
  }

  private currentMeasureIndex(): number {
    const tab = this.tab;
    if (!tab) return 0;
    const tick = this.transport?.currentTick ?? 0;
    return measureIndexOf(tick, tab.timeSignature);
  }

  /**
   * 播放头锚点被移动后调用：让 store.currentMeasure 立即对齐 Transport，
   * 并重置边界守卫，避免向后 seek / 重播后小节高亮（右栏）滞留旧值（T-01 子问题 1）。
   */
  private syncMeasureState(targetTick?: number): void {
    const tab = this.tab;
    const t = this.transport;
    if (!tab || !t) return;
    const mi = measureIndexOf(targetTick ?? t.currentTick, tab.timeSignature);
    this.lastEmittedMeasure = mi;
    usePracticeStore.getState().setCurrentMeasure(mi);
  }

  // ── 变速 ────────────────────────────────────────────────────────
  setRatio(ratio: number): void {
    const r = clamp(Math.round(ratio * 100) / 100, MIN_RATIO, MAX_RATIO);
    const bpm = this.ratioBpm(r);
    this.setTempoInternal(bpm);
    usePracticeStore.getState().setRatio(r);
  }

  private ratioBpm(ratio: number): number {
    const base = this.tab?.bpm ?? 90;
    return clamp(Math.round(base * ratio), MIN_BPM, MAX_BPM);
  }

  private setTempoInternal(bpm: number, immediate = true): void {
    if (!this.transport) return;
    this.transport.setTempo(clamp(Math.round(bpm), MIN_BPM, MAX_BPM), { immediate });
    usePracticeStore.getState().setCurrentBpm(clamp(Math.round(bpm), MIN_BPM, MAX_BPM));
  }

  // ── 循环 ────────────────────────────────────────────────────────
  setLoop(range: LoopRange | null): void {
    const { transport } = this.ensure();
    this.currentLoop = range;
    transport.setLoop(range);
    // 设循环可能立刻把锚点搬回 loop.start（当前 tick 越界时）；同步 store 镜像，
    // 避免右栏和弦预告 / 和弦视图高亮 / 标难点按钮滞留旧小节（QA 回归点）。
    this.syncMeasureState();
    usePracticeStore.getState().setLoop(range);
  }

  toggleLoop(): void {
    if (this.currentLoop) {
      this.setLoop(null);
    } else {
      // 默认整曲循环
      this.setLoop({ start: 0, end: this.totalTicks });
    }
  }

  // ── 节拍器 / 示范音轨 ───────────────────────────────────────────
  setMetronomeOn(on: boolean): void {
    this.ensure();
    this.metronome?.setEnabled(on);
    usePracticeStore.getState().setMetronomeOn(on);
  }

  setSubdivision(sub: Subdivision): void {
    this.ensure();
    const map: Record<Subdivision, 1 | 2 | 4> = { '1/4': 1, '1/8': 2, '1/16': 4 };
    this.transport?.setSubdivision(map[sub]);
    usePracticeStore.getState().setSubdivision(sub);
  }

  setDemo(on: boolean, volume: number): void {
    const { demo } = this.ensure();
    demo.setEnabled(on);
    demo.setVolume(volume);
    usePracticeStore.getState().setDemo(on, volume);
  }

  // ── 难点标记 ────────────────────────────────────────────────────
  addMarker(measure: number, note = ''): void {
    const tab = this.tab;
    if (!tab) return;
    const marker: Marker = { id: newId('mk'), measure, note, createdAt: nowIso(), loopCount: 0 };
    const next: Tab = { ...tab, markers: [...tab.markers, marker], updatedAt: nowIso(), revision: tab.revision + 1 };
    this.tab = next;
    usePracticeStore.getState().setMarkers(next.markers);
    void tabRepo.put(next).catch(() => undefined);
  }

  removeMarker(markerId: string): void {
    const tab = this.tab;
    if (!tab) return;
    const markers = tab.markers.filter((m) => m.id !== markerId);
    const next: Tab = { ...tab, markers, updatedAt: nowIso(), revision: tab.revision + 1 };
    this.tab = next;
    usePracticeStore.getState().setMarkers(markers);
    void tabRepo.put(next).catch(() => undefined);
  }

  /** 从「错题本/难点标记」设为循环：A-B = [N-1, N+1]，速度 60%，滚动到该小节 */
  focusMarker(marker: Marker): void {
    const tab = this.tab;
    if (!tab) return;
    const count = tab.tracks[0]?.measures.length ?? 0;
    const start = Math.max(0, marker.measure - 1);
    const end = Math.min(count, marker.measure + 2);
    this.setLoop({ start: measureStartTick(start, tab.timeSignature), end: measureStartTick(end, tab.timeSignature) });
    this.setRatio(0.6);
    this.seekToMeasure(marker.measure);
    const next = tab.markers.map((m) => (m.id === marker.id ? { ...m, loopCount: m.loopCount + 1 } : m));
    this.tab = { ...tab, markers: next };
    usePracticeStore.getState().setMarkers(next);
    void tabRepo.put(this.tab).catch(() => undefined);
  }

  // ── 渐进加速 ────────────────────────────────────────────────────
  async startProgressive(cfg: ProgressiveConfig): Promise<void> {
    const tab = this.tab;
    if (!tab) return;
    const targetBpm = computeTargetBpm(tab.bpm, cfg.targetRatio);
    const state = createProgressive(cfg, tab.bpm);
    state.active = true;
    this.prog = state;

    const range: LoopRange =
      this.currentLoop ?? { start: 0, end: this.totalTicks };
    if (!this.currentLoop) this.setLoop(range);

    usePracticeStore.getState().setProgressive(state);
    usePracticeStore.getState().setProgressiveActive(true);
    usePracticeStore.getState().setSession({ progressiveUsed: true });

    this.setTempoInternal(state.startBpm);
    this.transport?.setLoop(range);
    if (state.targetBpm < MIN_BPM) {
      // 极端慢曲无需训练
      useAppStore.getState().toast('info', '目标速度过低，无需提速训练');
      return;
    }
    void targetBpm;
    await this.play(range.start, { countInBars: 0 });
  }

  pauseProgressive(): void {
    this.pause();
    if (this.prog) {
      this.prog = { ...this.prog, active: false };
      usePracticeStore.getState().setProgressive(this.prog);
      usePracticeStore.getState().setProgressiveActive(false);
      usePracticeStore.getState().setPassWindowMsLeft(null);
    }
  }

  /** 用户点「本轮过了」（5 秒窗口内） */
  markPassed(): void {
    if (!this.prog || !this.prog.active) return;
    if (Date.now() > this.passDeadline) {
      this.failRound();
      return;
    }
    this.clearPassTimer();
    const state = this.prog;
    const bpm = this.transport?.currentBpm ?? state.currentBpm;
    const at = nowIso();

    // RoundPassed + 达标数
    const after = registerPass(state, bpm, at);
    usePracticeStore.getState().setProgressive(after);
    this.dispatch({ type: 'RoundPassed', tabId: this.tab!.id, at, bpm });

    const raise = applyRaise(after, at);
    if (raise.raised) {
      this.dispatch({
        type: 'TempoRaised',
        tabId: this.tab!.id,
        at,
        fromBpm: raise.fromBpm,
        toBpm: raise.toBpm,
      });
      if (raise.targetReached) {
        this.dispatch({ type: 'TargetReached', tabId: this.tab!.id, at, bpm: raise.toBpm });
        useAppStore.getState().toast('success', '已达成目标速度 🎉');
      }
      usePracticeStore.getState().setProgressive({ ...raise.state, active: true });
      // 下一个小节线生效，不打断播放
      this.setTempoInternal(raise.toBpm, false);
    } else {
      usePracticeStore.getState().setProgressive({ ...after, active: true });
    }
    this.passWindowMsLeft();
  }

  private failRound(): void {
    if (!this.prog || !this.prog.active) return;
    this.clearPassTimer();
    const bpm = this.transport?.currentBpm ?? this.prog.currentBpm;
    const at = nowIso();
    const next = registerFail(this.prog, bpm, at);
    this.prog = next;
    usePracticeStore.getState().setProgressive(next);
    this.dispatch({ type: 'RoundFailed', tabId: this.tab!.id, at, bpm });
    this.passWindowMsLeft();
  }

  private openPassWindow(): void {
    this.clearPassTimer();
    this.passDeadline = Date.now() + PASS_WINDOW_MS;
    usePracticeStore.getState().setPassWindowMsLeft(PASS_WINDOW_MS);
    this.passWindowTimer = setTimeout(() => {
      this.failRound();
      usePracticeStore.getState().setPassWindowMsLeft(null);
    }, PASS_WINDOW_MS);
  }

  private clearPassTimer(): void {
    if (this.passWindowTimer) clearTimeout(this.passWindowTimer);
    this.passWindowTimer = null;
    this.passDeadline = 0;
    usePracticeStore.getState().setPassWindowMsLeft(null);
  }

  private passWindowMsLeft(): void {
    // 轮次面板读取使用 progressive.rounds 即可；窗口按钮消失由 failRound 处理
  }

  // ── 会话 ────────────────────────────────────────────────────────
  private beginSession(): void {
    const tab = this.tab;
    if (!tab || this.session.active) return;
    this.session = {
      active: true,
      tabId: tab.id,
      startedAt: nowIso(),
      startBpm: this.transport?.currentBpm ?? tab.bpm,
      endBpm: this.transport?.currentBpm ?? tab.bpm,
      rounds: 0,
      passedRounds: 0,
      progressiveUsed: false,
      newCovered: [],
      effectiveSeconds: 0,
      pauseTimer: null,
      playSince: null,
    };
    this.dispatch({ type: 'SessionStarted', tabId: tab.id, at: nowIso(), bpm: this.session.startBpm });
    usePracticeStore.getState().setSession({
      active: true,
      startedAt: this.session.startedAt,
      effectiveSeconds: 0,
      startBpm: this.session.startBpm,
      endBpm: this.session.startBpm,
      rounds: 0,
      passedRounds: 0,
      progressiveUsed: false,
    });
  }

  endSession(): void {
    if (!this.session.active) {
      this.endActiveSessionIfAny();
      return;
    }
    this.finalizeSession(false);
  }

  private endActiveSessionIfAny(): void {
    if (this.session.active) this.finalizeSession(true);
  }

  private finalizeSession(forceEnd: boolean): void {
    if (!this.session.active) return;
    const tab = this.tab;
    if (!tab) {
      this.session.active = false;
      return;
    }
    this.recordPlayTime();
    this.stopSecTicker();
    this.clearPauseTimer();
    this.clearPassTimer();
    this.detachTransportSubscriptions();

    const endedAt = nowIso();
    const endBpm = this.transport?.currentBpm ?? tab.bpm;
    const eff = Math.round(this.session.effectiveSeconds);
    const counted = eff >= COUNTED_MIN_SEC;

    const event: PracticeEvent & { type: 'SessionEnded' } = {
      type: 'SessionEnded',
      tabId: tab.id,
      at: endedAt,
      startedAt: this.session.startedAt,
      endedAt,
      effectiveSeconds: eff,
      startBpm: this.session.startBpm,
      endBpm,
      rounds: this.session.rounds,
      passedRounds: this.session.passedRounds,
      progressiveUsed: this.session.progressiveUsed,
      coveredMeasures: this.session.newCovered,
    };

    const finalStats = reducePractice(tab.practice, tab, event);
    const finalTab: Tab = { ...tab, practice: finalStats, updatedAt: endedAt, revision: tab.revision + 1 };
    this.tab = finalTab;

    const sessionRec: PracticeSession = {
      id: newId('ses'),
      tabId: tab.id,
      startedAt: this.session.startedAt,
      endedAt,
      effectiveSeconds: eff,
      counted,
      startBpm: this.session.startBpm,
      endBpm,
      rounds: this.session.rounds,
      passedRounds: this.session.passedRounds,
      progressiveUsed: this.session.progressiveUsed,
      coveredMeasures: this.session.newCovered,
    };

    void tabRepo.put(finalTab).catch(() => undefined);
    void tabRepo.putSession(sessionRec).catch(() => undefined);

    usePracticeStore.getState().setSession({
      active: false,
      startedAt: null,
      effectiveSeconds: 0,
      startBpm: 0,
      endBpm: 0,
      rounds: 0,
      passedRounds: 0,
      progressiveUsed: false,
    });
    this.session = {
      active: false,
      tabId: null,
      startedAt: '',
      startBpm: 0,
      endBpm: 0,
      rounds: 0,
      passedRounds: 0,
      progressiveUsed: false,
      newCovered: [],
      effectiveSeconds: 0,
      pauseTimer: null,
      playSince: null,
    };
    void forceEnd;
  }

  /** 离开页面/标签隐藏时调用（PracticePage 卸载钩子会调 endSession） */
  handleLeave(): void {
    if (this.session.active) this.finalizeSession(true);
    this.disposeSubscriptions();
  }

  handleVisibilityHidden(): void {
    if (!this.session.active) return;
    // 记录一个时间点；真正结束由卸载/回前台时按累计判定。
    // 简化：隐藏即结束（PRD：标签页隐藏 ≥5min 才结束 —— 由上层节流调用）。
  }

  private detachTransportSubscriptions(): void {
    // Transport 的 onBoundary 订阅在下次 loadTab 时重置 lastEmittedMeasure；
    // 这里保留 transport 供下一次 loadTab 复用，不销毁。
  }

  private disposeSubscriptions(): void {
    // 若页面永久卸载则释放边界回调（transport 仍可复用）
  }

  private startSecTicker(): void {
    this.stopSecTicker();
    this.session.playSince = this.session.playSince ?? performance.now();
    this.secTicker = setInterval(() => {
      if (!this.transport?.isPlaying || !this.session.active) return;
      this.session.effectiveSeconds += 1;
      // 关键：把 playSince 前移到"本整秒"时刻，使 pause/end 时 recordPlayTime
      // 只累加最后一次整秒后的亚秒残余，避免与 ticker 的整秒累加重复计时。
      this.session.playSince = performance.now();
      this.session.endBpm = this.transport.currentBpm;
      usePracticeStore.getState().setSession({
        effectiveSeconds: Math.round(this.session.effectiveSeconds),
        endBpm: this.transport.currentBpm,
      });
    }, 1000);
  }

  private stopSecTicker(): void {
    if (this.secTicker) clearInterval(this.secTicker);
    this.secTicker = null;
    this.session.playSince = null;
  }

  private recordPlayTime(): void {
    if (!this.session.active || this.session.playSince == null) return;
    const ms = performance.now() - this.session.playSince;
    this.session.effectiveSeconds += ms / 1000;
    this.session.playSince = null;
  }

  private clearPauseTimer(): void {
    if (this.session.pauseTimer) clearTimeout(this.session.pauseTimer);
    this.session.pauseTimer = null;
  }

  // ── 领域事件 ────────────────────────────────────────────────────
  private dispatch(e: PracticeEvent): void {
    const tab = this.tab;
    if (!tab) return;
    const next = reducePractice(tab.practice, tab, e);
    this.tab = { ...tab, practice: next };
    // 低频写入：Measured/Covered 与轮次事件按 2s 节流
    this.flushPractice(e.type);
  }

  private flushPractice(kind: string): void {
    const now = Date.now();
    if (kind === 'MeasureCovered' && now - this.lastFlushAt < 2000) {
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.lastFlushAt = Date.now();
        void this.writeStats();
      }, 2000);
      return;
    }
    this.lastFlushAt = now;
    void this.writeStats();
  }

  private async writeStats(): Promise<void> {
    if (!this.tab) return;
    try {
      await tabRepo.patchPractice(this.tab.id, this.tab.practice);
    } catch {
      /* 静默：写库失败由 UI toast 处理不打断播放 */
    }
  }

  // ── 边界事件 ────────────────────────────────────────────────────
  private handleBoundary(e: BoundaryEvent): void {
    const tab = this.tab;
    if (!tab) return;
    const store = usePracticeStore.getState();

    switch (e.kind) {
      case 'measure': {
        if (e.measureIndex > this.lastEmittedMeasure) {
          this.lastEmittedMeasure = e.measureIndex;
          store.setCurrentMeasure(e.measureIndex);
          if (this.session.active) {
            this.session.newCovered.push(e.measureIndex);
            this.dispatch({ type: 'MeasureCovered', tabId: tab.id, at: nowIso(), measureIndex: e.measureIndex });
          }
        }
        break;
      }
      case 'roundEnd':
      case 'end': {
        // roundEnd 在 anchor 回跳之前 emit（Transport.checkBoundaries 第 2 步），
        // 此刻 transport.currentTick 仍是 loop.end 附近；必须用回跳目标 loop.start
        // 派生小节号，否则 store.currentMeasure 滞留（QA 回归）。end 之后 stop() 搬回 0。
        this.syncMeasureState(e.kind === 'roundEnd' ? (this.currentLoop?.start ?? 0) : 0);
        if (this.session.active) {
          this.session.rounds += 1;
          this.session.endBpm = e.bpm;
          store.setSession({ rounds: this.session.rounds, endBpm: e.bpm });
          const measureRange: [number, number] = this.measureRangeOfTick(e.tick);
          this.dispatch({
            type: 'RoundCompleted',
            tabId: tab.id,
            at: nowIso(),
            bpm: e.bpm,
            measureRange,
          });
          if (this.prog && this.prog.active) {
            this.openPassWindow();
          }
        }
        break;
      }
      case 'tempoApplied': {
        store.setCurrentBpm(e.bpm);
        if (this.session.active) this.session.endBpm = e.bpm;
        break;
      }
      default:
        break;
    }
  }

  private measureRangeOfTick(tick: Tick): [number, number] {
    const tab = this.tab;
    if (!tab) return [0, 0];
    const idx = measureIndexOf(tick, tab.timeSignature);
    return [idx, idx + 1];
  }

  // ── 试听 ────────────────────────────────────────────────────────
  previewNote(string: 1 | 2 | 3 | 4 | 5 | 6, fret: number): void {
    const { synth } = this.ensure();
    const midi = fretToMidi(string, fret);
    synth.pluck({ midi, velocity: 0.75 });
  }

  previewPattern(notes: { midi: number; velocity: number; offsetSec: number; durationSec: number }[]): void {
    const { synth } = this.ensure();
    synth.rake(notes);
  }

  getLookaheadChordName(): string {
    const tab = this.tab;
    if (!tab) return '';
    const tick = this.transport?.currentTick ?? 0;
    const lookTick = tick + NEXT_CHORD_LOOKAHEAD_TICKS;
    const idx = measureIndexOf(lookTick, tab.timeSignature);
    const measure = tab.tracks[0]?.measures[idx];
    if (!measure) return '';
    const chord = measure.chords.find((c) => c.tick > (lookTick - measure.startTick)) ?? measure.chords[0];
    return chord?.name ?? '';
  }

  /** 把秒转成 tick 偏移辅助（编辑器/试听预览可复用） */
  tickAtSec(sec: number, bpm: number): number {
    return Math.max(0, Math.round(tickToSec(sec, bpm) * 0 + sec * 0) + Math.round((sec * bpm * 480) / 60));
  }

  dispose(): void {
    this.handleLeave();
    this.transport?.dispose();
    this.transport = null;
    this.synth?.dispose();
    this.synth = null;
    this.demoTrack?.dispose();
    this.demoTrack = null;
    this.metronome?.dispose();
    this.metronome = null;
    if (this.secTicker) clearInterval(this.secTicker);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.passWindowTimer) clearTimeout(this.passWindowTimer);
  }
}

export const practiceController = new PracticeController();

/** UI 观察 playback 进度（低频，供右栏和弦预告等非画布展示） */
export function currentPlayheadTick(): number {
  return practiceController.currentTick;
}

export function measureLineStartTick(index: number, tab: Tab): number {
  return measureStartTick(index, tab.timeSignature);
}

export { flattenNotes };
