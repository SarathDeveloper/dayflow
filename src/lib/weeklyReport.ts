/**
 * Weekly Self-Improvement Report: one Monday–Sunday week compared with the
 * week before. Habits with an amount (English minutes, learning hours) are
 * summed; simple check habits (Gym) count sessions. Money comes from the
 * ledger: expenses spent, and saves into savings accounts (plus old savings
 * logs), never transfers between your own accounts.
 */
import type { Account, FinanceTransaction, Habit, SavingsEntry } from '../types';
import { focusMinutesBetween } from './focusSessions';
import { addDays, checkInMap, habitCompletion, habitStartDate, isComplete, weekStartMonday } from './habits';
import { addRupees } from './money';
import { dailyProgress, type ProgressInput } from './progressScore';
import { countedSavingsAmounts } from './savingsLedger';
import { readJson, writeJson } from './persistence';

export interface HabitWeekLine {
  habitId: string;
  title: string;
  /** "sessions" for a simple check habit, otherwise the habit's unit. */
  unit: string;
  total: number;
  previous: number;
}

export interface WeekNumbers {
  /** Done ÷ scheduled across habits, rest days left out. Null with nothing scheduled. */
  habitRate: number | null;
  focusMinutes: number;
  tasksDone: number;
  /** Average Daily Progress Score over days that had something due. */
  progressAverage: number | null;
  spent: number;
  saved: number;
}

export interface WeeklyReport {
  weekStart: string; // Monday
  weekEnd: string; // Sunday
  current: WeekNumbers;
  previous: WeekNumbers;
  habits: HabitWeekLine[];
}

export interface WeeklyReportInput extends ProgressInput {
  transactions: FinanceTransaction[];
  savingsEntries: SavingsEntry[];
  accounts: Account[];
}

/** The week a report is due for: this week on Sunday, otherwise the week that just ended. */
export function reportWeekStart(today: string): string {
  const monday = weekStartMonday(today);
  const isSunday = addDays(monday, 6) === today;
  return isSunday ? monday : addDays(monday, -7);
}

function habitAmount(habit: Habit, input: WeeklyReportInput, from: string, to: string): number {
  const map = checkInMap(habit.id, input.checkIns);
  const counted = (habit.targetCount ?? 1) > 1 || Boolean(habit.unit?.trim());
  let total = 0;
  for (const [date, entry] of map) {
    if (date < from || date > to || entry.skipped) continue;
    if (counted) total += Math.max(0, entry.value ?? (isComplete(habit, entry) ? 1 : 0));
    else if (isComplete(habit, entry)) total += 1;
  }
  return Math.round(total * 100) / 100;
}

function weekNumbers(input: WeeklyReportInput, from: string, to: string, today: string): WeekNumbers {
  const until = to < today ? to : today;
  let scheduled = 0;
  let done = 0;
  for (const habit of input.habits) {
    if (habit.archived || until < from) continue;
    const stats = habitCompletion(habit, input.checkIns, from, until);
    scheduled += stats.scheduled - (habit.schedule.type === 'times_per_week' ? 0 : stats.skipped);
    done += stats.done;
  }

  const scores: number[] = [];
  for (let date = from; date <= until; date = addDays(date, 1)) {
    const score = dailyProgress(input, date).percent;
    if (score !== null) scores.push(score);
  }

  const inWeek = (date: string) => date >= from && date <= to;
  const spent = input.transactions
    .filter((tx) => tx.type === 'expense' && inWeek(tx.date))
    .reduce(addRupees, 0);
  const saved = countedSavingsAmounts(input.savingsEntries, input.transactions, input.accounts)
    .filter((item) => inWeek(item.date))
    .reduce(addRupees, 0);

  return {
    habitRate: scheduled > 0 ? Math.round((Math.min(done, scheduled) / scheduled) * 100) : null,
    focusMinutes: focusMinutesBetween(input.focusSessions, from, to),
    tasksDone: input.tasks.filter((task) => task.completed && inWeek(task.date)).length,
    progressAverage: scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    spent,
    saved,
  };
}

export function buildWeeklyReport(input: WeeklyReportInput, weekStart: string, today: string): WeeklyReport {
  const weekEnd = addDays(weekStart, 6);
  const prevStart = addDays(weekStart, -7);
  const prevEnd = addDays(weekStart, -1);
  const habits = input.habits
    .filter((habit) => !habit.archived && habitStartDate(habit) <= weekEnd)
    .map((habit) => {
      const counted = (habit.targetCount ?? 1) > 1 || Boolean(habit.unit?.trim());
      return {
        habitId: habit.id,
        title: habit.title,
        unit: counted ? habit.unit?.trim() || 'times' : 'sessions',
        total: habitAmount(habit, input, weekStart, weekEnd),
        previous: habitAmount(habit, input, prevStart, prevEnd),
      };
    });
  return {
    weekStart,
    weekEnd,
    current: weekNumbers(input, weekStart, weekEnd, today),
    previous: weekNumbers(input, prevStart, prevEnd, today),
    habits,
  };
}

// The report card shows on Today until opened. Device-only, like the daily plan.
const SEEN_KEY = 'dayflow_weekly_report_seen_v1';

export function isWeeklyReportSeen(weekStart: string): boolean {
  return readJson<string | null>(SEEN_KEY, null) === weekStart;
}

export function markWeeklyReportSeen(weekStart: string): void {
  writeJson(SEEN_KEY, weekStart);
}
