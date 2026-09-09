/**
 * 熟练度（PRD §6.1）与练习档案聚合（PRD §6.3）。
 * 纯函数：不落库、不碰 UI、不碰音频。
 */
import type { ISO, PracticeStats, Tab } from '@/types/tab';
import type { PracticeSession } from '@/types/app';
import { COUNTED_MIN_SEC, addDays, clamp, daysBetween, localDateKey, weekStart } from '@/core/constants';

export type MasteryTier = 'gray' | 'blue' | 'green' | 'gold';

export interface MasteryFactors {
  /** 速度达成率 */
  S: number;
  /** 覆盖度 */
  C: number;
  /** 达标率 */
  A: number;
  /** 新鲜度 */
  F: number;
}

/** S = clamp(bestBpm / targetBpm, 0, 1) */
export function speedFactor(bestBpm: number, targetBpm: number): number {
  if (targetBpm <= 0) return 0;
  return clamp(bestBpm / targetBpm, 0, 1);
}

/** C = coveredMeasures.length / totalMeasures */
export function coverageFactor(coveredCount: number, totalMeasures: number): number {
  if (totalMeasures <= 0) return 0;
  return clamp(coveredCount / totalMeasures, 0, 1);
}

/** A = roundsTotal >= 1 ? roundsPassed / roundsTotal : 0 */
export function accuracyFactor(roundsTotal: number, roundsPassed: number): number {
  if (roundsTotal < 1) return 0;
  return clamp(roundsPassed / roundsTotal, 0, 1);
}

/**
 * 新鲜度 F（分段线性，下限 0.5，绝不归零）
 *  d ≤ 7      → 1.00
 *  7 < d ≤ 30 → 1.00 − 0.15 × (d − 7) / 23   （1.00 → 0.85）
 *  30 < d ≤ 90→ 0.85 − 0.35 × (d − 30) / 60  （0.85 → 0.50）
 *  d > 90     → 0.50（保底）
 */
export function freshnessFactor(lastPracticedAt: ISO | null, now: ISO): number {
  if (!lastPracticedAt) return 0;
  const d = daysBetween(lastPracticedAt, now);
  if (!Number.isFinite(d)) return 0;
  if (d <= 7) return 1;
  if (d <= 30) return 1 - (0.15 * (d - 7)) / 23;
  if (d <= 90) return 0.85 - (0.35 * (d - 30)) / 60;
  return 0.5;
}

export function computeMasteryFactors(
  stats: PracticeStats,
  totalMeasures: number,
  now: ISO,
): MasteryFactors {
  return {
    S: speedFactor(stats.bestBpm, stats.targetBpm),
    C: coverageFactor(stats.coveredMeasures.length, totalMeasures),
    A: accuracyFactor(stats.roundsTotal, stats.roundsPassed),
    F: freshnessFactor(stats.lastPracticedAt, now),
  };
}

/** computed = round(100 × (0.40S + 0.25C + 0.25A + 0.10F)) */
export function computeMasteryScore(f: MasteryFactors): number {
  return Math.round(100 * (0.4 * f.S + 0.25 * f.C + 0.25 * f.A + 0.1 * f.F));
}

/**
 * ★ 全项目唯一允许写 mastery 的地方（"重算"按钮除外，它走 recomputeMasteryHard）。
 * 首次（masteryComputedAt == null）不走 EMA；否则 mastery = round(0.7 × computed + 0.3 × prev)。
 */
export function recomputeMastery(
  stats: PracticeStats,
  totalMeasures: number,
  now: ISO,
): PracticeStats {
  const factors = computeMasteryFactors(stats, totalMeasures, now);
  const computed = computeMasteryScore(factors);
  const isFirst = stats.masteryComputedAt == null;
  const mastery = isFirst ? computed : Math.round(0.7 * computed + 0.3 * stats.mastery);
  return {
    ...stats,
    mastery: clamp(mastery, 0, 100),
    masteryComputedAt: now,
  };
}

/** 曲目详情「重算」按钮：跳过 EMA，直接取 computed */
export function recomputeMasteryHard(
  stats: PracticeStats,
  totalMeasures: number,
  now: ISO,
): PracticeStats {
  const factors = computeMasteryFactors(stats, totalMeasures, now);
  return {
    ...stats,
    mastery: clamp(computeMasteryScore(factors), 0, 100),
    masteryComputedAt: now,
  };
}

/** 显示分档：<40 灰 / 40–69 蓝 / 70–89 绿 / ≥90 金 */
export function masteryTier(mastery: number): MasteryTier {
  if (mastery >= 90) return 'gold';
  if (mastery >= 70) return 'green';
  if (mastery >= 40) return 'blue';
  return 'gray';
}

export function isCountedSession(effectiveSeconds: number): boolean {
  return effectiveSeconds >= COUNTED_MIN_SEC;
}

// ── 档案页聚合（E-01 / E-06）──────────────────────────────────────
export interface SessionAggregate {
  /** 自然日 → 当日有效分钟数 */
  minutesByDay: Record<string, number>;
  /** 本周（周一起）有效分钟数 */
  weekMinutes: number;
  /** 连续打卡天数 */
  streak: number;
  /** 近 7 天有练习的曲目数 */
  activeTabs: number;
}

/**
 * 连续打卡：从今天往前推；今日有练习就从今日数，否则若昨日有练习就从昨日数，
 * 否则 0；中途断一天归零（避免"隔天练"被算成连续）。
 */
export function computeStreak(practicedDays: readonly string[], todayKey: string): number {
  const set = new Set(practicedDays);
  let cursor = todayKey;
  if (!set.has(cursor)) {
    const yesterday = addDays(todayKey, -1);
    if (!set.has(yesterday)) return 0;
    cursor = yesterday;
  }
  let streak = 0;
  while (set.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

export function aggregateSessions(
  sessions: readonly PracticeSession[],
  now: Date = new Date(),
): SessionAggregate {
  const minutesByDay: Record<string, number> = {};
  const weekStartDate = weekStart(now);
  const weekStartKey = localDateKey(weekStartDate);
  const sevenDaysAgoKey = localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6));
  const activeTabSet = new Set<string>();

  for (const s of sessions) {
    if (!s.counted) continue;
    const t = Date.parse(s.startedAt);
    if (Number.isNaN(t)) continue;
    const dayKey = localDateKey(new Date(t));
    minutesByDay[dayKey] = (minutesByDay[dayKey] ?? 0) + s.effectiveSeconds / 60;
    if (dayKey >= sevenDaysAgoKey) activeTabSet.add(s.tabId);
  }

  let weekMinutes = 0;
  for (const [day, minutes] of Object.entries(minutesByDay)) {
    if (day >= weekStartKey) weekMinutes += minutes;
  }

  return {
    minutesByDay,
    weekMinutes: Math.round(weekMinutes),
    streak: computeStreak(Object.keys(minutesByDay), localDateKey(now)),
    activeTabs: activeTabSet.size,
  };
}

/** 平均速度 % = mean(bestBpm / targetBpm) × 100（未练过记 0） */
export function averageSpeedPct(
  items: readonly { bestBpm: number; targetBpm: number }[],
): number {
  if (items.length === 0) return 0;
  let sum = 0;
  for (const it of items) sum += it.targetBpm > 0 ? clamp(it.bestBpm / it.targetBpm, 0, 1) : 0;
  return Math.round((sum / items.length) * 100);
}

/** 便于单测与档案页直接吃 Tab */
export function masteryOfTab(tab: Tab, now: ISO): number {
  const total = tab.tracks[0]?.measures.length ?? 0;
  return recomputeMastery(tab.practice, total, now).mastery;
}
