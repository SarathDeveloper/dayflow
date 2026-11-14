/**
 * Daily Progress Score: one number per day from habits, tasks, focus time and
 * goals, plus the best area, what was missed, and a 7-day consistency score.
 *
 * Every area counts equally, and only areas that had something due that day
 * count at all: a day with no tasks is not a 0% task day. A rest day (a
 * habit "skip") is left out instead of counting as missed.
 */
import type { FocusSession, Goal, Habit, HabitCheckIn, NotificationSettings, Task } from '../types';
import { focusMinutesOn, formatMinutes } from './focusSessions';
import { addDays, checkInOn, isComplete, isDueToday, isSkipped } from './habits';

export const DEFAULT_FOCUS_GOAL_MINUTES = 50;

export type ProgressAreaKey = 'habits' | 'tasks' | 'focus' | 'goals';

export interface ProgressArea {
  key: ProgressAreaKey;
  label: string;
  done: number;
  total: number;
  percent: number;
  /** "3 of 4 done", "35 of 50 min". */
  detail: string;
}

export interface MissedItem {
  kind: 'habit' | 'task';
  id: string;
  title: string;
}

export interface DailyProgress {
  date: string;
  /** Null when nothing was due that day. */
  percent: number | null;
  areas: ProgressArea[];
  best: ProgressArea | null;
  /** Due that day and not done (for today: still open). */
  missed: MissedItem[];
}

export interface ProgressInput {
  tasks: Task[];
  habits: Habit[];
  checkIns: HabitCheckIn[];
  goals: Goal[];
  focusSessions: FocusSession[];
  settings: Pick<NotificationSettings, 'dailyFocusGoalMinutes'>;
}

export function focusGoalMinutes(settings: Pick<NotificationSettings, 'dailyFocusGoalMinutes'>): number {
  const goal = settings.dailyFocusGoalMinutes;
  return typeof goal === 'number' && Number.isFinite(goal) && goal >= 0 ? Math.round(goal) : DEFAULT_FOCUS_GOAL_MINUTES;
}

function pct(done: number, total: number): number {
  return total <= 0 ? 0 : Math.round((Math.min(done, total) / total) * 100);
}

export function dailyProgress(input: ProgressInput, date: string): DailyProgress {
  const areas: ProgressArea[] = [];
  const missed: MissedItem[] = [];

  // Habits due that day; a rest day (skip) is left out.
  const dueHabits = input.habits.filter((habit) => {
    if (!isDueToday(habit, date, input.goals, input.checkIns)) return false;
    return !isSkipped(checkInOn(habit.id, input.checkIns, date));
  });
  const doneHabits = dueHabits.filter((habit) => isComplete(habit, checkInOn(habit.id, input.checkIns, date)));
  if (dueHabits.length > 0) {
    areas.push({
      key: 'habits',
      label: 'Habits',
      done: doneHabits.length,
      total: dueHabits.length,
      percent: pct(doneHabits.length, dueHabits.length),
      detail: `${doneHabits.length} of ${dueHabits.length} done`,
    });
    for (const habit of dueHabits) {
      if (!doneHabits.includes(habit)) missed.push({ kind: 'habit', id: habit.id, title: habit.title });
    }
  }

  // Tasks planned for that day.
  const dayTasks = input.tasks.filter((task) => task.date === date);
  const doneTasks = dayTasks.filter((task) => task.completed);
  if (dayTasks.length > 0) {
    areas.push({
      key: 'tasks',
      label: 'Tasks',
      done: doneTasks.length,
      total: dayTasks.length,
      percent: pct(doneTasks.length, dayTasks.length),
      detail: `${doneTasks.length} of ${dayTasks.length} done`,
    });
    for (const task of dayTasks) {
      if (!task.completed) missed.push({ kind: 'task', id: task.id, title: task.title });
    }
  }

  // Focus time against the daily goal (a goal of 0 turns this area off).
  const goalMinutes = focusGoalMinutes(input.settings);
  if (goalMinutes > 0) {
    const minutes = focusMinutesOn(input.focusSessions, date);
    areas.push({
      key: 'focus',
      label: 'Focus',
      done: Math.min(minutes, goalMinutes),
      total: goalMinutes,
      percent: pct(minutes, goalMinutes),
      detail: `${formatMinutes(minutes)} of ${formatMinutes(goalMinutes)}`,
    });
  }

  // Active goals with a linked habit due that day: moved forward if one was done.
  const goalsDue = input.goals.filter(
    (goal) =>
      goal.status === 'active' &&
      goal.startDate <= date &&
      date <= goal.targetDate &&
      dueHabits.some((habit) => habit.goalId === goal.id),
  );
  if (goalsDue.length > 0) {
    const advanced = goalsDue.filter((goal) => doneHabits.some((habit) => habit.goalId === goal.id));
    areas.push({
      key: 'goals',
      label: 'Goals',
      done: advanced.length,
      total: goalsDue.length,
      percent: pct(advanced.length, goalsDue.length),
      detail: `${advanced.length} of ${goalsDue.length} moved forward`,
    });
  }

  const counted = areas.filter((area) => area.total > 0);
  const percent =
    counted.length === 0 ? null : Math.round(counted.reduce((sum, area) => sum + area.percent, 0) / counted.length);
  const best = counted.reduce<ProgressArea | null>(
    (top, area) => (area.percent > 0 && (!top || area.percent > top.percent) ? area : top),
    null,
  );
  return { date, percent, areas, best, missed };
}

export interface WeeklyConsistency {
  /** Average daily score over the days that had something due; null if none did. */
  percent: number | null;
  /** The 7 finished days before `today`, oldest first. */
  days: { date: string; percent: number | null }[];
}

/** The last 7 finished days (today is still open, so it is not included). */
export function weeklyConsistency(input: ProgressInput, today: string): WeeklyConsistency {
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(today, index - 7);
    return { date, percent: dailyProgress(input, date).percent };
  });
  const scored = days.filter((day) => day.percent !== null) as { date: string; percent: number }[];
  const percent =
    scored.length === 0 ? null : Math.round(scored.reduce((sum, day) => sum + day.percent, 0) / scored.length);
  return { percent, days };
}
