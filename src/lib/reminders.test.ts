import { describe, expect, it } from 'vitest';
import type { Goal, Habit, HabitCheckIn, NotificationSettings } from '../types';
import { addDays, localDateString } from './habits';
import { buildReminderPlans } from './reminders';

const settings: NotificationSettings = {
  browserNotificationsEnabled: true,
  soundEnabled: true,
  speechEnabled: false,
  defaultSound: 'chime',
  quietHours: { enabled: false, start: '22:00', end: '07:00' },
};

function habit(): Habit {
  return {
    id: 'habit-1',
    title: 'Read',
    schedule: { type: 'daily' },
    archived: false,
    reminder: { enabled: true, time: '15:00', sound: 'chime' },
    createdAt: new Date(2026, 9, 1, 12, 0, 0).toISOString(),
    updatedAt: new Date(2026, 9, 1, 12, 0, 0).toISOString(),
  };
}

function check(date: string): HabitCheckIn {
  return {
    id: `checkin-habit-1-${date}`,
    habitId: 'habit-1',
    date,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

describe('habit reminders', () => {
  const now = new Date(2026, 9, 28, 8, 0, 0);
  const today = localDateString(now);
  const item = habit();

  it('schedules a due habit that has not been checked', () => {
    const plans = buildReminderPlans([], settings, now, [item], [], []);
    expect(plans[0]?.habitId).toBe('habit-1');
    expect(localDateString(plans[0].fireAt)).toBe(today);
    expect(plans[0].fireAt.getHours()).toBe(15);
  });

  it('skips a habit that is already checked and schedules the next day', () => {
    const plans = buildReminderPlans([], settings, now, [item], [check(today)], []);
    expect(plans.some((plan) => localDateString(plan.fireAt) === today)).toBe(false);
    expect(localDateString(plans[0].fireAt)).toBe(addDays(today, 1));
  });

  it('does not remind a habit on a paused goal', () => {
    const goal: Goal = {
      id: 'goal-1',
      title: 'Read more',
      startDate: '2026-10-01',
      targetDate: '2026-12-31',
      status: 'paused',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    const linked = { ...item, goalId: 'goal-1' };
    const plans = buildReminderPlans([], settings, now, [linked], [], [goal]);
    expect(plans.filter((plan) => plan.habitId)).toHaveLength(0);
  });
});

describe('weekly report reminder', () => {
  it('fires on the next Sunday at 19:00, or a week later once that has passed', async () => {
    const { nextWeeklyReportAt } = await import('./reminders');
    // Wed 11 Nov 2026 -> Sun 15 Nov 19:00.
    expect(nextWeeklyReportAt(new Date(2026, 10, 11, 9, 0)).toString()).toBe(new Date(2026, 10, 15, 19, 0).toString());
    // Sunday before 19:00 -> same day.
    expect(nextWeeklyReportAt(new Date(2026, 10, 15, 18, 30)).toString()).toBe(new Date(2026, 10, 15, 19, 0).toString());
    // Sunday after 19:00 -> next Sunday.
    expect(nextWeeklyReportAt(new Date(2026, 10, 15, 19, 30)).toString()).toBe(new Date(2026, 10, 22, 19, 0).toString());
  });

  it('is part of the plan list, so the native sync never cancels it', async () => {
    const { WEEKLY_REPORT_TASK_ID } = await import('./reminders');
    const plans = buildReminderPlans([], settings, new Date(2026, 10, 11, 9, 0));
    const weekly = plans.filter((plan) => plan.taskId === WEEKLY_REPORT_TASK_ID);
    expect(weekly).toHaveLength(1);
    expect(weekly[0].ring).toBe(false);
  });

  it('respects quiet hours', () => {
    const quiet = { ...settings, quietHours: { enabled: true, start: '18:00', end: '07:00' } };
    const plans = buildReminderPlans([], quiet, new Date(2026, 10, 11, 9, 0));
    expect(plans.some((plan) => plan.taskId === 'weekly-report')).toBe(false);
  });
});
