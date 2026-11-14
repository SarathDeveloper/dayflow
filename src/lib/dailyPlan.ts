import type { NotificationSettings, Task } from '../types';
import { readJson, writeJson } from './persistence';

/**
 * Morning plan and evening review. The plan lives on this device only: it is
 * a daily ritual, not a record worth syncing or backing up.
 */
export const DAILY_PLAN_KEY = 'dayflow_daily_plan_v1';
export const TOP_PICKS = 3;
/** Evening review is offered from this hour onwards. */
export const EVENING_HOUR = 18;
const UPCOMING_DAYS = 3;

export interface DailyPlanState {
  /** Day the picks and flags below belong to. */
  date: string;
  topTaskIds: string[];
  /** The morning prompt was answered or dismissed. */
  planned: boolean;
  /** The evening review was finished or dismissed. */
  reviewed: boolean;
}

export function emptyPlan(date: string): DailyPlanState {
  return { date, topTaskIds: [], planned: false, reviewed: false };
}

export function loadDailyPlan(today: string): DailyPlanState {
  const stored = readJson<DailyPlanState | null>(DAILY_PLAN_KEY, null);
  return stored && stored.date === today ? { ...emptyPlan(today), ...stored } : emptyPlan(today);
}

export function saveDailyPlan(plan: DailyPlanState): void {
  writeJson(DAILY_PLAN_KEY, plan);
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(y, m - 1, d + days);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
}

export function tomorrowOf(date: string): string {
  return addDays(date, 1);
}

const PRIORITY_RANK: Record<Task['priority'], number> = { urgent: 0, high: 1, medium: 2, low: 3 };

export interface PlanCandidates {
  overdue: Task[];
  today: Task[];
  upcoming: Task[];
}

/** Open tasks worth considering for today's top picks, most pressing first. */
export function planCandidates(tasks: Task[], today: string): PlanCandidates {
  const horizon = addDays(today, UPCOMING_DAYS);
  const byPressure = (a: Task, b: Task) =>
    a.date.localeCompare(b.date) ||
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
    (a.time || '99:99').localeCompare(b.time || '99:99');
  const open = tasks.filter((task) => !task.completed);
  return {
    overdue: open.filter((task) => task.date < today).sort(byPressure),
    today: open.filter((task) => task.date === today).sort(byPressure),
    upcoming: open.filter((task) => task.date > today && task.date <= horizon).sort(byPressure),
  };
}

/** Tasks still open at the end of `today`, for the evening review. */
export function unfinishedToday(tasks: Task[], today: string): Task[] {
  return tasks
    .filter((task) => task.date === today && !task.completed)
    .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
}

/** Top picks that still exist, in the order they were chosen. */
export function resolveTopTasks(plan: DailyPlanState, tasks: Task[]): Task[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return plan.topTaskIds.map((id) => byId.get(id)).filter((task): task is Task => Boolean(task));
}

// ---------------------------------------------------------------------------
// Time-aware planning
// ---------------------------------------------------------------------------

/** Planning time per weekday when none is set: 4 hours. */
export const DEFAULT_AVAILABLE_MINUTES = 240;
/** Estimate for a task that has none. */
export const DEFAULT_TASK_MINUTES = 30;

type AvailabilitySettings = Pick<NotificationSettings, 'availableMinutesByWeekday'>;

/** Minutes available per weekday, Sunday first; missing or invalid days fall back to 4 h. */
export function availableMinutesByWeekday(settings: AvailabilitySettings): number[] {
  const stored = settings.availableMinutesByWeekday;
  return Array.from({ length: 7 }, (_, day) => {
    const value = Array.isArray(stored) ? stored[day] : undefined;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : DEFAULT_AVAILABLE_MINUTES;
  });
}

export function availableMinutesOn(settings: AvailabilitySettings, date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return availableMinutesByWeekday(settings)[new Date(y, m - 1, d).getDay()];
}

export function taskMinutes(task: Task): number {
  const estimate = task.estimatedMinutes;
  return typeof estimate === 'number' && estimate > 0 ? Math.round(estimate) : DEFAULT_TASK_MINUTES;
}

/**
 * Minutes already on today's plate: open tasks dated today plus extra picks
 * (overdue or upcoming tasks that would move to today).
 */
export function plannedMinutes(tasks: Task[], today: string, extraIds: string[] = []): number {
  const ids = new Set(extraIds);
  return tasks
    .filter((task) => !task.completed && (task.date === today || ids.has(task.id)))
    .reduce((sum, task) => sum + taskMinutes(task), 0);
}

const BUCKET_RANK = { overdue: 0, today: 1, upcoming: 2 } as const;

/**
 * Suggested top picks: highest priority first, then overdue before today
 * before upcoming, keeping the picks within the time available. Always
 * suggests at least one task when there is any, even if it alone is too long.
 */
export function suggestTopPicks(candidates: PlanCandidates, availableMinutes: number, max = TOP_PICKS): string[] {
  const pool = (Object.keys(BUCKET_RANK) as (keyof typeof BUCKET_RANK)[]).flatMap((bucket) =>
    candidates[bucket].map((task) => ({ task, bucket })),
  );
  pool.sort(
    (a, b) =>
      PRIORITY_RANK[a.task.priority] - PRIORITY_RANK[b.task.priority] ||
      BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket] ||
      a.task.date.localeCompare(b.task.date) ||
      (a.task.time || '99:99').localeCompare(b.task.time || '99:99'),
  );
  const picks: string[] = [];
  let used = 0;
  for (const { task } of pool) {
    if (picks.length >= max) break;
    const minutes = taskMinutes(task);
    if (picks.length > 0 && used + minutes > availableMinutes) continue;
    picks.push(task.id);
    used += minutes;
  }
  return picks;
}

export type PlanPhase = 'morning' | 'planned' | 'evening' | 'done';

/** Which card the Today screen shows right now. */
export function planPhase(plan: DailyPlanState, hour: number): PlanPhase {
  if (hour >= EVENING_HOUR) return plan.reviewed ? 'done' : 'evening';
  return plan.planned ? 'planned' : 'morning';
}
