import { describe, expect, it } from 'vitest';
import { dailyProgress, focusGoalMinutes, weeklyConsistency, type ProgressInput } from './progressScore';
import type { FocusSession, Goal, Habit, HabitCheckIn, Task } from '../types';

const D = '2026-11-14';
const habit = (id: string, extra: Partial<Habit> = {}): Habit => ({
  id,
  title: id,
  schedule: { type: 'daily' },
  archived: false,
  createdAt: '2026-11-01T06:00:00.000Z',
  updatedAt: '2026-11-01T06:00:00.000Z',
  ...extra,
});
const check = (habitId: string, date: string, extra: Partial<HabitCheckIn> = {}): HabitCheckIn => ({
  id: `${habitId}-${date}`,
  habitId,
  date,
  createdAt: `${date}T08:00:00.000Z`,
  updatedAt: `${date}T08:00:00.000Z`,
  ...extra,
});
const task = (id: string, date: string, completed: boolean): Task => ({
  id,
  title: id,
  completed,
  date,
  priority: 'medium',
  category: 'cat-1',
  subtasks: [],
  recurrence: { type: 'none' },
  reminder: { enabled: false, remindBeforeMinutes: 0, sound: 'chime' },
  createdAt: `${date}T06:00:00.000Z`,
  updatedAt: `${date}T06:00:00.000Z`,
});
const focus = (date: string, minutes: number): FocusSession => ({
  id: `f-${date}-${minutes}`,
  date,
  minutes,
  startedAt: `${date}T09:00:00.000Z`,
  createdAt: `${date}T09:30:00.000Z`,
  updatedAt: `${date}T09:30:00.000Z`,
});
const input = (over: Partial<ProgressInput> = {}): ProgressInput => ({
  tasks: [],
  habits: [],
  checkIns: [],
  goals: [],
  focusSessions: [],
  settings: { dailyFocusGoalMinutes: 0 },
  ...over,
});

describe('dailyProgress', () => {
  it('averages only the areas that had something due', () => {
    const result = dailyProgress(
      input({
        habits: [habit('gym'), habit('read')],
        checkIns: [check('gym', D)],
        tasks: [task('t1', D, true), task('t2', D, true), task('other-day', '2026-11-13', false)],
      }),
      D,
    );
    // Habits 50%, tasks 100%, no focus goal, no goals -> 75%.
    expect(result.areas.map((a) => [a.key, a.percent])).toEqual([
      ['habits', 50],
      ['tasks', 100],
    ]);
    expect(result.percent).toBe(75);
    expect(result.best?.key).toBe('tasks');
    expect(result.missed).toEqual([{ kind: 'habit', id: 'read', title: 'read' }]);
  });

  it('leaves a rest day out instead of counting it as missed', () => {
    const result = dailyProgress(
      input({ habits: [habit('gym'), habit('read')], checkIns: [check('gym', D, { skipped: true }), check('read', D)] }),
      D,
    );
    expect(result.areas[0]).toMatchObject({ key: 'habits', done: 1, total: 1, percent: 100 });
    expect(result.missed).toEqual([]);
  });

  it('counts focus minutes against the goal, capped at 100%', () => {
    const half = dailyProgress(input({ focusSessions: [focus(D, 25)], settings: { dailyFocusGoalMinutes: 50 } }), D);
    expect(half.areas).toEqual([expect.objectContaining({ key: 'focus', percent: 50, detail: '25 min of 50 min' })]);
    const over = dailyProgress(input({ focusSessions: [focus(D, 90)], settings: { dailyFocusGoalMinutes: 50 } }), D);
    expect(over.percent).toBe(100);
  });

  it('counts a goal as moved forward when a linked habit due that day is done', () => {
    const goal: Goal = {
      id: 'g1',
      title: 'Fitness',
      startDate: '2026-11-01',
      targetDate: '2026-12-31',
      status: 'active',
      createdAt: '2026-11-01T06:00:00.000Z',
      updatedAt: '2026-11-01T06:00:00.000Z',
    };
    const result = dailyProgress(
      input({ goals: [goal], habits: [habit('gym', { goalId: 'g1' })], checkIns: [check('gym', D)] }),
      D,
    );
    expect(result.areas.find((a) => a.key === 'goals')).toMatchObject({ done: 1, total: 1, percent: 100 });
  });

  it('is null on a day with nothing due', () => {
    expect(dailyProgress(input(), D).percent).toBeNull();
  });

  it('uses 50 minutes as the default focus goal and allows 0 to turn it off', () => {
    expect(focusGoalMinutes({})).toBe(50);
    expect(focusGoalMinutes({ dailyFocusGoalMinutes: 0 })).toBe(0);
  });
});

describe('weeklyConsistency', () => {
  it('averages the 7 finished days before today, skipping days with nothing due', () => {
    const tasks = [
      task('a', '2026-11-13', true), // 100
      task('b', '2026-11-12', false), // 0
      task('c', '2026-11-14', false), // today: not counted
    ];
    const result = weeklyConsistency(input({ tasks }), D);
    expect(result.days).toHaveLength(7);
    expect(result.days[0].date).toBe('2026-11-07');
    expect(result.days[6].date).toBe('2026-11-13');
    expect(result.percent).toBe(50);
  });
});
