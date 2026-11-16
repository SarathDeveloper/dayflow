import { describe, expect, it } from 'vitest';
import type { BillPayment, DiaryEntry, Goal, Habit, HabitCheckIn, Task } from '../types';
import { HOME_MAX_GOALS, bestHabitStreak, homeSummary, taskStreak, type HomeSummaryInput } from './homeSummary';

const today = '2026-11-16';
const STAMP = '2026-10-01T06:30:00.000Z';

function task(over: Partial<Task>): Task {
  return {
    id: `task-${over.title ?? 'x'}-${over.date ?? today}`,
    title: 'Task',
    date: today,
    completed: false,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...over,
  } as Task;
}

function habit(over: Partial<Habit> = {}): Habit {
  return {
    id: 'habit-1',
    title: 'Read',
    schedule: { type: 'daily' },
    archived: false,
    createdAt: '2026-10-01T06:30:00.000Z',
    updatedAt: STAMP,
    ...over,
  };
}

function checkIns(habitId: string, dates: string[]): HabitCheckIn[] {
  return dates.map((date) => ({ id: `c-${habitId}-${date}`, habitId, date, createdAt: STAMP, updatedAt: STAMP }));
}

function bill(over: Partial<BillPayment>): BillPayment {
  return {
    id: `bill-${over.dueDate}`,
    billId: 'tpl',
    month: '2026-11',
    amount: 100,
    dueDate: '2026-11-20',
    paid: false,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...over,
  };
}

function goal(over: Partial<Goal>): Goal {
  return {
    id: 'goal',
    title: 'Goal',
    startDate: '2026-11-01',
    targetDate: '2026-12-31',
    status: 'active',
    createdAt: STAMP,
    updatedAt: STAMP,
    ...over,
  };
}

function input(over: Partial<HomeSummaryInput> = {}): HomeSummaryInput {
  return {
    today,
    tasks: [],
    habits: [],
    checkIns: [],
    goals: [],
    transactions: [],
    budgets: [],
    billPayments: [],
    diaryEntries: [],
    ...over,
  };
}

describe('taskStreak', () => {
  it('counts back from today when a task is done today', () => {
    const tasks = ['2026-11-16', '2026-11-15', '2026-11-14', '2026-11-12'].map((date) => ({ date, completed: true }));
    expect(taskStreak(tasks, today)).toBe(3);
  });

  it('keeps yesterday\'s streak while today is still open', () => {
    const tasks = [
      { date: '2026-11-15', completed: true },
      { date: '2026-11-14', completed: true },
      { date: today, completed: false },
    ];
    expect(taskStreak(tasks, today)).toBe(2);
  });

  it('is zero when neither today nor yesterday has a completed task', () => {
    expect(taskStreak([{ date: '2026-11-14', completed: true }], today)).toBe(0);
    expect(taskStreak([], today)).toBe(0);
  });

  it('crosses month boundaries', () => {
    const tasks = ['2026-11-02', '2026-11-01', '2026-10-31'].map((date) => ({ date, completed: true }));
    expect(taskStreak(tasks, '2026-11-02')).toBe(3);
  });
});

describe('bestHabitStreak', () => {
  const run = ['2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', today];

  it('still counts a habit whose goal was completed, like the Streak page', () => {
    const habits = [habit({ id: 'done-goal', goalId: 'g-done' }), habit({ id: 'short' })];
    const result = bestHabitStreak(
      habits,
      [goal({ id: 'g-done', status: 'completed' })],
      [...checkIns('done-goal', run), ...checkIns('short', [today])],
      today,
    );
    expect(result).toEqual({ streak: 5, unit: 'days' });
  });

  it('leaves out archived habits and habits of a paused goal', () => {
    const habits = [
      habit({ id: 'archived', archived: true }),
      habit({ id: 'paused', goalId: 'g-paused' }),
      habit({ id: 'live' }),
    ];
    const result = bestHabitStreak(
      habits,
      [goal({ id: 'g-paused', status: 'paused' })],
      [...checkIns('archived', run), ...checkIns('paused', run), ...checkIns('live', [today])],
      today,
    );
    expect(result.streak).toBe(1);
  });

  it('reports weeks for a times-per-week habit', () => {
    const weekly = habit({ id: 'w', schedule: { type: 'times_per_week', timesPerWeek: 1 } });
    const result = bestHabitStreak([weekly], [], checkIns('w', ['2026-11-04', '2026-11-11', today]), today);
    expect(result.unit).toBe('weeks');
    expect(result.streak).toBeGreaterThan(0);
  });
});

describe('homeSummary', () => {
  it('counts today\'s tasks and picks the first open one by time', () => {
    const summary = homeSummary(
      input({
        tasks: [
          task({ title: 'Done', time: '07:00', completed: true }),
          task({ title: 'Untimed' }),
          task({ title: 'Lunch', time: '13:00' }),
          task({ title: 'Tomorrow', time: '06:00', date: '2026-11-17' }),
        ],
      }),
    );
    expect(summary.tasks).toEqual({ total: 3, done: 1, next: { title: 'Lunch', time: '13:00' } });
  });

  it('has no next task when everything is done', () => {
    const summary = homeSummary(input({ tasks: [task({ title: 'A', completed: true })] }));
    expect(summary.tasks.next).toBeNull();
  });

  it('counts habits due and done today, ignoring archived ones', () => {
    const summary = homeSummary(
      input({
        habits: [habit({ id: 'h1' }), habit({ id: 'h2' }), habit({ id: 'h3', archived: true })],
        checkIns: [...checkIns('h1', ['2026-11-14', '2026-11-15', today]), ...checkIns('h3', [today])],
      }),
    );
    expect(summary.habits).toEqual({ due: 2, done: 1 });
    expect(summary.streak.bestHabit).toBe(3);
    expect(summary.streak.bestHabitUnit).toBe('days');
  });

  it('sums this month\'s unpaid bills in paise and flags overdue ones', () => {
    const summary = homeSummary(
      input({
        billPayments: [
          bill({ dueDate: '2026-11-25', amount: 0.1 }),
          bill({ dueDate: '2026-11-10', amount: 0.2 }),
          bill({ dueDate: '2026-11-05', amount: 500, paid: true }),
          bill({ dueDate: '2026-10-28', month: '2026-10', amount: 900 }),
        ],
      }),
    );
    expect(summary.money.unpaidBills).toBe(2);
    expect(summary.money.unpaidBillsAmount).toBe(0.3);
    expect(summary.money.overdueBills).toBe(1);
    expect(summary.money.nextBillDue).toBe('2026-11-10');
  });

  it('lists only active goals, newest first, capped', () => {
    const goals = [
      goal({ id: 'g1', title: 'Old', startDate: '2026-09-01' }),
      goal({ id: 'g2', title: 'Paused', status: 'paused' }),
      goal({ id: 'g3', title: 'New', startDate: '2026-11-10' }),
      goal({ id: 'g4', title: 'Mid', startDate: '2026-10-01' }),
      goal({ id: 'g5', title: 'Oldest', startDate: '2026-01-01' }),
    ];
    const summary = homeSummary(input({ goals }));
    expect(summary.goals.map((g) => g.title)).toEqual(['New', 'Mid', 'Old'].slice(0, HOME_MAX_GOALS));
  });

  it('counts today\'s diary notes', () => {
    const entries = [{ date: today }, { date: today }, { date: '2026-11-15' }] as DiaryEntry[];
    expect(homeSummary(input({ diaryEntries: entries })).diary.notesToday).toBe(2);
  });
});
