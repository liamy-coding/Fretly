/**
 * 练习器 Store（T-16）：UI 态 + 渐进加速显示态。
 *
 * 高频量（播放头 tick）不进 React 状态 —— 由 TabCanvas rAF 直读 Transport。
 * 低频量（isPlaying / 小节 / BPM / 轮次）由 practiceController 在事件发生时
 * 推送进这里；UI 组件只读订阅。
 */
import { create } from 'zustand';
import type { Marker, NoteId, Tab, TabId, Tick } from '@/types/tab';
import type { ProgressiveState, Step, PassRounds } from '@/core/progressive';
import { DEFAULT_PROGRESSIVE } from '@/core/progressive';

export type PracticeViewMode = 'tab' | 'lyrics' | 'chords' | 'listen';
export type Subdivision = '1/4' | '1/8' | '1/16';

export interface LoopRange {
  start: Tick;
  end: Tick;
}

export interface SessionDisplay {
  active: boolean;
  startedAt: string | null;
  /** 本会话累计有效（播放中）秒数 */
  effectiveSeconds: number;
  startBpm: number;
  endBpm: number;
  rounds: number;
  passedRounds: number;
  progressiveUsed: boolean;
}

interface PracticeUiState {
  tabId: TabId | null;
  tab: Tab | null;
  loading: boolean;
  error: string | null;

  ratio: number;
  currentBpm: number;
  isPlaying: boolean;
  loop: LoopRange | null;
  viewMode: PracticeViewMode;
  currentMeasure: number;

  metronomeOn: boolean;
  subdivision: Subdivision;
  demoOn: boolean;
  demoVolume: number;

  markers: Marker[];
  showMarkers: boolean;

  session: SessionDisplay;
  progressive: ProgressiveState | null;
  progressiveActive: boolean;
  /** 「本轮过了」窗口剩余毫秒；null = 无窗口 */
  passWindowMsLeft: number | null;

  // ── actions ────────────────────────────────────────────────────
  setTab(tab: Tab | null): void;
  setLoading(v: boolean): void;
  setError(msg: string | null): void;
  setRatio(r: number): void;
  setCurrentBpm(v: number): void;
  setPlaying(v: boolean): void;
  setLoop(r: LoopRange | null): void;
  setViewMode(v: PracticeViewMode): void;
  setMetronomeOn(v: boolean): void;
  setSubdivision(v: Subdivision): void;
  setDemo(on: boolean, volume: number): void;
  setMarkers(markers: Marker[]): void;
  setShowMarkers(v: boolean): void;
  setSession(patch: Partial<SessionDisplay>): void;
  setProgressive(p: ProgressiveState | null): void;
  setProgressiveActive(v: boolean): void;
  setPassWindowMsLeft(v: number | null): void;
  setCurrentMeasure(m: number): void;
  resetPractice(): void;
}

function defaultSession(): SessionDisplay {
  return {
    active: false,
    startedAt: null,
    effectiveSeconds: 0,
    startBpm: 0,
    endBpm: 0,
    rounds: 0,
    passedRounds: 0,
    progressiveUsed: false,
  };
}

export const usePracticeStore = create<PracticeUiState>((set) => ({
  tabId: null,
  tab: null,
  loading: false,
  error: null,
  ratio: 1,
  currentBpm: 90,
  isPlaying: false,
  loop: null,
  viewMode: 'tab',
  currentMeasure: 0,
  metronomeOn: false,
  subdivision: '1/4',
  demoOn: true,
  demoVolume: 0.8,
  markers: [],
  showMarkers: true,
  session: defaultSession(),
  progressive: null,
  progressiveActive: false,
  passWindowMsLeft: null,

  setTab(tab) {
    set({
      tab,
      tabId: tab?.id ?? null,
      markers: tab?.markers ?? [],
      currentBpm: tab?.bpm ?? 90,
      // 换曲重置小节，杜绝上一首的高亮/右栏残留（T-01 子问题 2）
      currentMeasure: 0,
    });
  },
  setLoading(loading) {
    set({ loading });
  },
  setError(error) {
    set({ error });
  },
  setRatio(ratio) {
    set({ ratio });
  },
  setCurrentBpm(currentBpm) {
    set({ currentBpm });
  },
  setPlaying(isPlaying) {
    set({ isPlaying });
  },
  setLoop(loop) {
    set({ loop });
  },
  setViewMode(viewMode) {
    set({ viewMode });
  },
  setMetronomeOn(metronomeOn) {
    set({ metronomeOn });
  },
  setSubdivision(subdivision) {
    set({ subdivision });
  },
  setDemo(demoOn, demoVolume) {
    set({ demoOn, demoVolume });
  },
  setMarkers(markers) {
    set({ markers });
  },
  setShowMarkers(showMarkers) {
    set({ showMarkers });
  },
  setSession(patch) {
    set((s) => ({ session: { ...s.session, ...patch } }));
  },
  setProgressive(progressive) {
    set({ progressive });
  },
  setProgressiveActive(progressiveActive) {
    set({ progressiveActive });
  },
  setPassWindowMsLeft(passWindowMsLeft) {
    set({ passWindowMsLeft });
  },
  setCurrentMeasure(currentMeasure) {
    set({ currentMeasure });
  },
  resetPractice() {
    set({
      tabId: null,
      tab: null,
      loading: false,
      error: null,
      isPlaying: false,
      loop: null,
      currentMeasure: 0,
      markers: [],
      session: defaultSession(),
      progressive: null,
      progressiveActive: false,
      passWindowMsLeft: null,
    });
  },
}));

/** 从 Settings 拿默认渐进加速参数（页面打开时调用一次） */
export function defaultProgressiveCfgFromSettings(settings: {
  defaultStartRatio: number;
  defaultStep: number;
  defaultPassRounds: number;
  defaultTargetRatio: number;
}): { startRatio: number; step: Step; passRounds: PassRounds; targetRatio: number } {
  const step = settings.defaultStep === 3 || settings.defaultStep === 10 ? settings.defaultStep : 5;
  const passRounds =
    settings.defaultPassRounds === 1 || settings.defaultPassRounds === 3 ? settings.defaultPassRounds : 2;
  return {
    startRatio: settings.defaultStartRatio,
    step: step as Step,
    passRounds: passRounds as PassRounds,
    targetRatio: settings.defaultTargetRatio,
  };
}

export { DEFAULT_PROGRESSIVE };
export type { NoteId };
