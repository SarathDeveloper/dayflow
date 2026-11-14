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
import { addDays, checkInOn, habitBlockedSince, isComplete, isDueToday, isScheduledOn, isSkipped, localDateString } from './habits';

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

/**
 * Did this habit count on `date`? As it was then: archiving it or finishing its
 * goal later does not rewrite earlier days. A rest day never counts.
 * A times-per-week habit has no fixed days: on past days it counts only when
 * it was done (the weekly report scores the quota); today it counts while the
 * week's quota is still open.
 */
function habitCountsOn(habit: ProgressInput['habits'][number], date: string, input: ProgressInput, today: string): boolean {
  const blockedSince = habitBlockedSince(habit, input.goals);
  if (blockedSince && date >= blockedSince) return false;
  if (!isScheduledOn(habit, date)) return false;
  const entry = checkInOn(habit.id, input.checkIns, date);
  if (isSkipped(entry)) return false;
  if (habit.schedule.type !== 'times_per_week') return true;
  if (isComplete(habit, entry)) return true;
  return date === today && isDueToday(habit, date, input.goals, input.checkIns);
}

function firstFocusDate(sessions: FocusSession[]): string | null {
  let first: string | null = null;
  for (const session of sessions) if (!first || session.date < first) first = session.date;
  return first;
}

/** `today` decides how times-per-week habits count; it defaults to `date`. */
export function dailyProgress(input: ProgressInput, date: string, today: string = date): DailyProgress {
  const areas: ProgressArea[] = [];
  const missed: MissedItem[] = [];

  // Habits that counted that day.
  const dueHabits = input.habits.filter((habit) => habitCountsOn(habit, date, input, today));
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

  // Focus time against the daily goal (a goal of 0 turns this area off). It
  // counts from the first Focus Room session on, and never scores a day on its
  // own: a day with nothing else due and no focus stays "nothing due".
  const goalMinutes = focusGoalMinutes(input.settings);
  const minutes = goalMinutes > 0 ? focusMinutesOn(input.focusSessions, date) : 0;
  const focusStarted = firstFocusDate(input.focusSessions);
  const otherAreasDue = areas.length > 0;
  if (goalMinutes > 0 && (minutes > 0 || (otherAreasDue && focusStarted !== null && date >= focusStarted))) {
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
  // A goal finished or paused after `date` was still active that day.
  const activeOn = (goal: Goal) => {
    if (goal.status === 'active') return true;
    const changed = new Date(goal.updatedAt);
    return !Number.isNaN(changed.getTime()) && localDateString(changed) > date;
  };
  const goalsDue = input.goals.filter(
    (goal) =>
      activeOn(goal) &&
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
    return { date, percent: dailyProgress(input, date, today).percent };
  });
  const scored = days.filter((day) => day.percent !== null) as { date: string; percent: number }[];
  const percent =
    scored.length === 0 ? null : Math.round(scored.reduce((sum, day) => sum + day.percent, 0) / scored.length);
  return { percent, days };
}
