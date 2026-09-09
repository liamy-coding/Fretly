/**
 * 领域事件 + 纯 reducer + 渐进加速状态机（PRD §6.2，架构 §4.5 / T-07）。
 *
 * 铁律：
 *  1. 只有 state/practiceController 能派发 PracticeEvent（R5）。
 *  2. mastery 只在 SessionEnded 时由 recomputeMastery 重算一次（本文件的 reducePractice）。
 *  3. bestBpm 只在 TempoRaised 时更新，且取**提速前**的 bpm。
 */
import type { ISO, PracticeStats, Tab, TabId } from '@/types/tab';
import { COUNTED_MIN_SEC, MAX_BPM, MIN_BPM, clamp } from '@/core/constants';
import { recomputeMastery } from '@/core/mastery';

export type PracticeEvent =
  | { type: 'SessionStarted'; tabId: TabId; at: ISO; bpm: number }
  | { type: 'MeasureCovered'; tabId: TabId; at: ISO; measureIndex: number }
  | { type: 'RoundCompleted'; tabId: TabId; at: ISO; bpm: number; measureRange: [number, number] }
  | { type: 'RoundPassed'; tabId: TabId; at: ISO; bpm: number }
  | { type: 'RoundFailed'; tabId: TabId; at: ISO; bpm: number }
  | { type: 'TempoRaised'; tabId: TabId; at: ISO; fromBpm: number; toBpm: number }
  | { type: 'TargetReached'; tabId: TabId; at: ISO; bpm: number }
  | { type: 'MarkerAdded'; tabId: TabId; at: ISO; measure: number }
  | { type: 'MarkerRemoved'; tabId: TabId; at: ISO; measure: number }
  | {
      type: 'SessionEnded';
      tabId: TabId;
      at: ISO;
      startedAt: ISO;
      endedAt: ISO;
      effectiveSeconds: number;
      startBpm: number;
      endBpm: number;
      rounds: number;
      passedRounds: number;
      progressiveUsed: boolean;
      coveredMeasures: number[];
    };

function mergeCovered(current: readonly number[], add: readonly number[]): number[] {
  const set = new Set<number>(current);
  for (const m of add) set.add(m);
  return [...set].sort((a, b) => a - b);
}

/** 纯函数：事件 → 新的 PracticeStats（不落库、不碰 UI、不碰音频） */
export function reducePractice(
  stats: PracticeStats,
  tab: Tab,
  e: PracticeEvent,
): PracticeStats {
  switch (e.type) {
    case 'SessionStarted':
      return { ...stats, lastPracticedAt: e.at };

    case 'MeasureCovered':
      return { ...stats, coveredMeasures: mergeCovered(stats.coveredMeasures, [e.measureIndex]) };

    case 'RoundCompleted':
      return { ...stats, roundsTotal: stats.roundsTotal + 1 };

    case 'RoundPassed':
      return { ...stats, roundsPassed: Math.min(stats.roundsPassed + 1, stats.roundsTotal) };

    case 'RoundFailed':
      // 连续达标计数清零发生在状态机（ProgressiveState），stats 层面无变化
      return stats;

    case 'TempoRaised': {
      const bestBpm = Math.max(stats.bestBpm, e.fromBpm);
      const reached = e.toBpm >= stats.targetBpm && stats.targetReachedAt == null;
      return {
        ...stats,
        bestBpm,
        targetReachedAt: reached ? e.at : stats.targetReachedAt,
      };
    }

    case 'TargetReached':
      return stats.targetReachedAt == null
        ? { ...stats, targetReachedAt: e.at }
        : stats;

    case 'MarkerAdded':
    case 'MarkerRemoved':
      // 标记写在 tab.markers 上，统计侧只需保证引用稳定
      return stats;

    case 'SessionEnded': {
      const counted = e.effectiveSeconds >= COUNTED_MIN_SEC;
      const next: PracticeStats = {
        ...stats,
        coveredMeasures: mergeCovered(stats.coveredMeasures, e.coveredMeasures),
        lastPracticedAt: e.endedAt,
        ...(counted
          ? {
              totalSeconds: stats.totalSeconds + Math.round(e.effectiveSeconds),
              sessions: stats.sessions + 1,
            }
          : {}),
      };
      const totalMeasures = tab.tracks[0]?.measures.length ?? 0;
      return recomputeMastery(next, totalMeasures, e.endedAt);
    }

    default:
      return stats;
  }
}

// ── 渐进加速状态机（PRD §6.2）─────────────────────────────────────
export type Step = 3 | 5 | 10;
export type PassRounds = 1 | 2 | 3;

export interface ProgressiveConfig {
  startRatio: number;
  step: Step;
  passRounds: PassRounds;
  targetRatio: number;
}

export interface RoundRecord {
  index: number;
  bpm: number;
  passed: boolean;
  at: ISO;
}

export interface ProgressiveState {
  active: boolean;
  targetBpm: number;
  startBpm: number;
  step: Step;
  passRounds: PassRounds;
  currentBpm: number;
  /** 连续达标次数（达到 passRounds 即提速并清零） */
  consecutive: number;
  rounds: RoundRecord[];
  targetReachedAt: ISO | null;
}

export const DEFAULT_PROGRESSIVE: ProgressiveConfig = {
  startRatio: 0.6,
  step: 5,
  passRounds: 2,
  targetRatio: 1,
};

/**
 * startBpm = clamp(round(targetBpm × startRatio), 40, targetBpm)
 *  边界：targetBpm < 40 → startBpm = targetBpm
 *        round(targetBpm × startRatio) < 40 → startBpm = 40
 */
export function computeStartBpm(targetBpm: number, startRatio: number): number {
  if (targetBpm < MIN_BPM) return targetBpm;
  return clamp(Math.round(targetBpm * startRatio), MIN_BPM, targetBpm);
}

export function computeTargetBpm(baseBpm: number, targetRatio: number): number {
  return clamp(Math.round(baseBpm * targetRatio), MIN_BPM, MAX_BPM);
}

export function createProgressive(cfg: ProgressiveConfig, baseBpm: number): ProgressiveState {
  const targetBpm = computeTargetBpm(baseBpm, cfg.targetRatio);
  const startBpm = computeStartBpm(targetBpm, cfg.startRatio);
  return {
    active: false,
    targetBpm,
    startBpm,
    step: cfg.step,
    passRounds: cfg.passRounds,
    currentBpm: startBpm,
    consecutive: 0,
    rounds: [],
    targetReachedAt: startBpm >= targetBpm ? new Date().toISOString() : null,
  };
}

/** 用户点「本轮过了」：连续达标 +1（是否提速由 shouldRaise 判定） */
export function registerPass(state: ProgressiveState, bpm: number, at: ISO): ProgressiveState {
  const index = state.rounds.length + 1;
  return {
    ...state,
    consecutive: state.consecutive + 1,
    rounds: [...state.rounds, { index, bpm, passed: true, at }],
  };
}

/** 5 秒窗口内未点击 / 用户点「没过」：连续达标清零 */
export function registerFail(state: ProgressiveState, bpm: number, at: ISO): ProgressiveState {
  const index = state.rounds.length + 1;
  return {
    ...state,
    consecutive: 0,
    rounds: [...state.rounds, { index, bpm, passed: false, at }],
  };
}

export function shouldRaise(state: ProgressiveState): boolean {
  return state.active && state.consecutive >= state.passRounds && state.currentBpm < state.targetBpm;
}

export interface TempoRaiseResult {
  state: ProgressiveState;
  raised: boolean;
  fromBpm: number;
  toBpm: number;
  targetReached: boolean;
}

/**
 * 提速：currentBpm = min(currentBpm + step, targetBpm)，consecutive 清零。
 * 已等于 targetBpm 时不再提速（继续循环直到用户停）。
 */
export function applyRaise(state: ProgressiveState, at: ISO): TempoRaiseResult {
  const fromBpm = state.currentBpm;
  if (!shouldRaise(state)) {
    return { state, raised: false, fromBpm, toBpm: fromBpm, targetReached: false };
  }
  const toBpm = Math.min(fromBpm + state.step, state.targetBpm);
  const targetReached = toBpm >= state.targetBpm;
  return {
    state: {
      ...state,
      currentBpm: toBpm,
      consecutive: 0,
      targetReachedAt: targetReached && state.targetReachedAt == null ? at : state.targetReachedAt,
    },
    raised: true,
    fromBpm,
    toBpm,
    targetReached,
  };
}

export { recomputeMastery };
