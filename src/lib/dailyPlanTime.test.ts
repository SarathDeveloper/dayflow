import { describe, expect, it } from 'vitest';
import {
  availableMinutesByWeekday,
  availableMinutesOn,
  planCandidates,
  plannedMinutes,
  suggestTopPicks,
  taskMinutes,
} from './dailyPlan';
import type { Priority, Task } from '../types';

const T = '2026-11-14'; // Saturday
const task = (id: string, date: string, priority: Priority, estimatedMinutes?: number, completed = false): Task => ({
  id,
  title: id,
  completed,
  date,
  priority,
  category: 'cat-1',
  subtasks: [],
  recurrence: { type: 'none' },
  reminder: { enabled: false, remindBeforeMinutes: 0, sound: 'chime' },
  estimatedMinutes,
  createdAt: `${date}T06:00:00.000Z`,
  updatedAt: `${date}T06:00:00.000Z`,
});

describe('available time', () => {
  it('defaults to 4 hours a day and reads the weekday setting', () => {
    expect(availableMinutesByWeekday({})).toEqual([240, 240, 240, 240, 240, 240, 240]);
    const settings = { availableMinutesByWeekday: [60, 120, 120, 120, 120, 120, 300] };
    expect(availableMinutesOn(settings, T)).toBe(300); // Saturday
    expect(availableMinutesOn(settings, '2026-11-15')).toBe(60); // Sunday
    expect(availableMinutesByWeekday({ availableMinutesByWeekday: [-5, NaN as unknown as number] })[0]).toBe(240);
  });

  it('uses 30 minutes for a task without an estimate', () => {
    expect(taskMinutes(task('a', T, 'low'))).toBe(30);
    expect(taskMinutes(task('b', T, 'low', 90))).toBe(90);
  });

  it('counts open tasks for today plus picks moving to today', () => {
    const tasks = [task('today', T, 'low', 60), task('done', T, 'low', 60, true), task('late', '2026-11-10', 'high', 45)];
    expect(plannedMinutes(tasks, T)).toBe(60);
    expect(plannedMinutes(tasks, T, ['late'])).toBe(105);
  });
});

describe('suggestTopPicks', () => {
  it('puts priority first, then overdue before today, and keeps within the time available', () => {
    const tasks = [
      task('today-medium', T, 'medium', 30),
      task('overdue-high', '2026-11-12', 'high', 60),
      task('today-urgent', T, 'urgent', 120),
      task('upcoming-high', '2026-11-15', 'high', 30),
      task('today-low', T, 'low', 15),
    ];
    const picks = suggestTopPicks(planCandidates(tasks, T), 200);
    // urgent 120 -> high overdue 60 (180) -> high upcoming 30 would exceed 200, skip -> medium 30 exceeds, skip -> low 15 fits.
    expect(picks).toEqual(['today-urgent', 'overdue-high', 'today-low']);
  });

  it('still suggests one task when even the first is longer than the time available', () => {
    const tasks = [task('big', T, 'high', 300)];
    expect(suggestTopPicks(planCandidates(tasks, T), 60)).toEqual(['big']);
  });
});
