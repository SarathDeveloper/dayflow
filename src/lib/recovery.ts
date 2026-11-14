/**
 * Consistency and recovery: missing one day is not failing. These helpers
 * track missed days separately from rest days, say when a habit is back on
 * track after a miss, and measure a rolling 7-day consistency, so a streak
 * is never the only measure of progress.
 *
 * A rest day is a habit check-in with `skipped: true`. It can be planned for
 * a future day and is never counted as missed.
 */
import type { Goal, Habit, HabitCheckIn } from '../types';
import {
  addDays,
  checkInMap,
  eachDate,
  habitBlockReason,
  habitCompletion,
  habitStartDate,
  isComplete,
  isSkipped,
  matchesSchedule,
  weeklyQuota,
} from './habits';

/** How far back missed days are listed. */
export const MISSED_LOOKBACK_DAYS = 14;

export type RecoveryStatus = 'steady' | 'recovered' | 'fresh-start';

export interface HabitRecovery {
  status: RecoveryStatus;
  /** Missed days in the lookback window, oldest first. */
  missed: string[];
  lastMissed?: string;
  /** First day done after the last miss. */
  recoveredOn?: string;
  /** Done ÷ (scheduled − rest) over the last 7 finished days; null with nothing countable. */
  consistency7: number | null;
}

/**
 * Scheduled days before today that were neither done nor a rest day.
 * Times-per-week habits have no fixed days, so they never have missed days.
 */
export function missedDays(
  habit: Habit,
  checkIns: HabitCheckIn[],
  today: string,
  lookback = MISSED_LOOKBACK_DAYS,
): string[] {
  if (habit.schedule.type === 'times_per_week') return [];
  const from = addDays(today, -lookback);
  const start = habitStartDate(habit);
  const windowFrom = from > start ? from : start;
  const yesterday = addDays(today, -1);
  if (windowFrom > yesterday) return [];
  const map = checkInMap(habit.id, checkIns);
  return eachDate(windowFrom, yesterday).filter((date) => {
    if (!matchesSchedule(habit.schedule, date)) return false;
    const entry = map.get(date);
    return !isComplete(habit, entry) && !isSkipped(entry);
  });
}

/**
 * Countable and done days over the last 7 finished days. A times-per-week
 * habit gets one weekly quota over the rolling window (clipped to the days it
 * existed), not two partial calendar weeks.
 */
function lastSevenDays(habit: Habit, checkIns: HabitCheckIn[], today: string): { countable: number; done: number; rest: number } {
  const from = addDays(today, -7);
  const to = addDays(today, -1);
  if (habit.schedule.type === 'times_per_week') {
    const start = habitStartDate(habit);
    const windowFrom = from > start ? from : start;
    if (windowFrom > to) return { countable: 0, done: 0, rest: 0 };
    const map = checkInMap(habit.id, checkIns);
    const days = eachDate(windowFrom, to);
    const countable = Math.min(weeklyQuota(habit), days.length);
    const completes = days.filter((date) => isComplete(habit, map.get(date))).length;
    const rest = days.filter((date) => isSkipped(map.get(date))).length;
    return { countable, done: Math.min(completes, countable), rest };
  }
  const stats = habitCompletion(habit, checkIns, from, to);
  const countable = stats.scheduled - stats.skipped;
  return { countable, done: Math.min(stats.done, countable), rest: stats.skipped };
}

function sevenDayConsistency(habit: Habit, checkIns: HabitCheckIn[], today: string): number | null {
  const { countable, done } = lastSevenDays(habit, checkIns, today);
  return countable > 0 ? Math.round((done / countable) * 100) : null;
}

/** A blocked habit (archived, or its goal paused or completed) has nothing to recover. */
export function habitRecovery(habit: Habit, checkIns: HabitCheckIn[], today: string, goals: Goal[] = []): HabitRecovery {
  if (habitBlockReason(habit, goals)) return { status: 'steady', missed: [], consistency7: null };
  const missed = missedDays(habit, checkIns, today);
  const consistency7 = sevenDayConsistency(habit, checkIns, today);
  if (missed.length === 0) return { status: 'steady', missed, consistency7 };

  const lastMissed = missed[missed.length - 1];
  const map = checkInMap(habit.id, checkIns);
  const recoveredOn = eachDate(addDays(lastMissed, 1), today).find((date) => isComplete(habit, map.get(date)));
  return recoveredOn
    ? { status: 'recovered', missed, lastMissed, recoveredOn, consistency7 }
    : { status: 'fresh-start', missed, lastMissed, consistency7 };
}

function shortDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { weekday: 'short' });
}

/** One kind sentence about where a habit stands. */
export function recoveryMessage(recovery: HabitRecovery, today: string): string {
  if (recovery.status === 'steady') return 'No missed days in the last 2 weeks';
  const missedOn = recovery.lastMissed ? shortDay(recovery.lastMissed) : '';
  if (recovery.status === 'recovered' && recovery.recoveredOn) {
    const since = recovery.recoveredOn === today ? 'today' : `since ${shortDay(recovery.recoveredOn)}`;
    return `Back on track ${since} after missing ${missedOn}`;
  }
  return `Missed ${missedOn}. Today is a fresh start.`;
}

export interface OverallConsistency {
  /** Across active habits over the last 7 finished days; null with nothing countable. */
  percent: number | null;
  missedDays: number;
  restDays: number;
}

/** All active habits together, over the last 7 finished days. */
export function overallConsistency(habits: Habit[], checkIns: HabitCheckIn[], goals: Goal[], today: string): OverallConsistency {
  let countable = 0;
  let done = 0;
  let restDays = 0;
  let missed = 0;
  for (const habit of habits) {
    if (habitBlockReason(habit, goals)) continue;
    const week = lastSevenDays(habit, checkIns, today);
    countable += week.countable;
    done += week.done;
    restDays += week.rest;
    missed += missedDays(habit, checkIns, today, 7).length;
  }
  return {
    percent: countable > 0 ? Math.round((done / countable) * 100) : null,
    missedDays: missed,
    restDays,
  };
}
