import { describe, expect, it } from 'vitest';
import { buildWeeklyReport, reportWeekStart, type WeeklyReportInput } from './weeklyReport';
import type { Account, FinanceTransaction, Habit, HabitCheckIn } from '../types';

const habit = (id: string, extra: Partial<Habit> = {}): Habit => ({
  id,
  title: id,
  schedule: { type: 'daily' },
  archived: false,
  createdAt: '2026-10-01T06:00:00.000Z',
  updatedAt: '2026-10-01T06:00:00.000Z',
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
const tx = (id: string, type: FinanceTransaction['type'], amount: number, date: string, extra: Partial<FinanceTransaction> = {}): FinanceTransaction => ({
  id,
  type,
  amount,
  category: 'Food',
  date,
  recurrence: { type: 'none' },
  createdAt: `${date}T10:00:00.000Z`,
  updatedAt: `${date}T10:00:00.000Z`,
  ...extra,
});
const account = (id: string, type: Account['type']): Account => ({
  id,
  name: id,
  type,
  openingBalance: 0,
  isArchived: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
});
const input = (over: Partial<WeeklyReportInput> = {}): WeeklyReportInput => ({
  tasks: [],
  habits: [],
  checkIns: [],
  goals: [],
  focusSessions: [],
  settings: { dailyFocusGoalMinutes: 0 },
  transactions: [],
  savingsEntries: [],
  accounts: [],
  ...over,
});

describe('reportWeekStart', () => {
  it('reports this week on Sunday, the week just ended on other days', () => {
    expect(reportWeekStart('2026-11-15')).toBe('2026-11-09'); // Sunday
    expect(reportWeekStart('2026-11-16')).toBe('2026-11-09'); // Monday after
    expect(reportWeekStart('2026-11-14')).toBe('2026-11-02'); // Saturday
  });
});

describe('buildWeeklyReport', () => {
  const week = '2026-11-09'; // Mon 9 … Sun 15 Nov
  const today = '2026-11-15';

  it('counts gym sessions, sums English minutes and learning hours, and compares weeks', () => {
    const gym = habit('Gym', { schedule: { type: 'times_per_week', timesPerWeek: 4 } });
    const english = habit('English', { unit: 'min', targetCount: 30 });
    const learning = habit('Learning', { unit: 'h', targetCount: 1 });
    const checkIns = [
      check('Gym', '2026-11-09'),
      check('Gym', '2026-11-11'),
      check('Gym', '2026-11-13'),
      check('Gym', '2026-11-04'), // last week
      check('English', '2026-11-10', { value: 30 }),
      check('English', '2026-11-12', { value: 45 }),
      check('English', '2026-11-03', { value: 20 }),
      check('Learning', '2026-11-10', { value: 1.5 }),
      check('Learning', '2026-11-14', { value: 2 }),
      check('Learning', '2026-11-11', { skipped: true }), // rest day, not an amount
    ];
    const report = buildWeeklyReport(input({ habits: [gym, english, learning], checkIns }), week, today);
    expect(report.weekEnd).toBe('2026-11-15');
    expect(report.habits).toEqual([
      { habitId: 'Gym', title: 'Gym', unit: 'sessions', total: 3, previous: 1 },
      { habitId: 'English', title: 'English', unit: 'min', total: 75, previous: 20 },
      { habitId: 'Learning', title: 'Learning', unit: 'h', total: 3.5, previous: 0 },
    ]);
  });

  it('leaves rest days out of the habit rate', () => {
    const read = habit('Read');
    const checkIns = ['09', '10', '11', '12', '13'].map((d) => check('Read', `2026-11-${d}`));
    checkIns.push(check('Read', '2026-11-14', { skipped: true }));
    // 7 scheduled, 1 rest -> 6 countable, 5 done -> 83%.
    const report = buildWeeklyReport(input({ habits: [read], checkIns }), week, today);
    expect(report.current.habitRate).toBe(83);
  });

  it('adds up spending and real savings, never transfers between own accounts', () => {
    const accounts = [account('wallet', 'cash'), account('bank', 'savings'), account('gold', 'gold')];
    const transactions = [
      tx('e1', 'expense', 120.5, '2026-11-10'),
      tx('e2', 'expense', 79.5, '2026-11-12'),
      tx('e-old', 'expense', 500, '2026-11-05'),
      tx('i1', 'income', 9000, '2026-11-10'),
      tx('save', 'transfer', 1000, '2026-11-11', { accountId: 'wallet', destinationAccountId: 'bank' }),
      tx('move', 'transfer', 400, '2026-11-12', { accountId: 'bank', destinationAccountId: 'gold' }),
    ];
    const report = buildWeeklyReport(input({ accounts, transactions }), week, today);
    expect(report.current.spent).toBe(200);
    expect(report.previous.spent).toBe(500);
    expect(report.current.saved).toBe(1000);
  });
});
