import type { Task } from '../types';
import { calculateNextDueDate } from '../services/notificationService';

export function isRecurring(task: Pick<Task, 'recurrence'>): boolean {
  return Boolean(task.recurrence?.type && task.recurrence.type !== 'none');
}

/** Date of the occurrence after `task.date`, honouring weekly days and custom intervals. */
export function nextOccurrenceOf(task: Pick<Task, 'date' | 'recurrence'>): string {
  return calculateNextDueDate(
    task.date,
    task.recurrence.type,
    task.recurrence.intervalDays,
    task.recurrence.daysOfWeek
  );
}

/** A fresh copy of a task for a new date: unchecked, steps reset, reminder re-armed. */
export function rescheduled(task: Task, date: string, now: string): Task {
  return {
    ...task,
    date,
    completed: false,
    completedAt: undefined,
    subtasks: task.subtasks.map((sub) => ({ ...sub, completed: false })),
    reminder: { ...task.reminder, lastNotifiedAt: undefined, snoozedUntil: undefined },
    updatedAt: now,
  };
}

/** The series a repeating task belongs to: its `seriesId`, or its own id for the first copy. */
export function seriesIdOf(task: Pick<Task, 'id' | 'seriesId'>): string {
  return task.seriesId || task.id;
}

/**
 * Id of the series' copy on `date`. The same on every device, so two devices
 * completing the same occurrence offline create one record that sync merges,
 * instead of two copies with different ids.
 */
export function nextOccurrenceId(task: Pick<Task, 'id' | 'seriesId'>, date: string): string {
  return `${seriesIdOf(task)}-on-${date}`;
}

/** The next copy of a completed repeating task: rescheduled to `date`, with its series id. */
export function nextOccurrence(task: Task, date: string, now: string): Task {
  return {
    ...rescheduled(task, date, now),
    id: nextOccurrenceId(task, date),
    seriesId: seriesIdOf(task),
    createdAt: now,
  };
}

/**
 * Skip just this occurrence: the same task moves to its next date without
 * being counted as done. Past the series end date there is nothing to move
 * to, so null tells the caller to finish the series instead.
 */
export function skipOccurrence(task: Task, now: string): Task | null {
  if (!isRecurring(task)) return null;
  const next = nextOccurrenceOf(task);
  if (task.recurrence.endDate && next > task.recurrence.endDate) return null;
  return rescheduled(task, next, now);
}
