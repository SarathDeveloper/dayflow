import { describe, expect, it } from 'vitest';
import { habitRecovery, missedDays, overallConsistency, recoveryMessage } from './recovery';
import type { Habit, HabitCheckIn } from '../types';

const TODAY = '2026-11-14'; // Saturday
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
const doneOn = (habitId: string, ...days: number[]) => days.map((d) => check(habitId, `2026-11-${String(d).padStart(2, '0')}`));

describe('missedDays', () => {
  it('lists scheduled days that were neither done nor rest, never today', () => {
    const checkIns = [...doneOn('read', 7, 8, 9, 11, 12), check('read', '2026-11-13', { skipped: true })];
    // 1-6 before the window? Window is 14 days back from today: 31 Oct.. but the habit started 1 Nov.
    expect(missedDays(habit('read'), checkIns, TODAY)).toEqual([
      '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-10',
    ]);
  });

  it('has no missed days for a times-per-week habit', () => {
    expect(missedDays(habit('gym', { schedule: { type: 'times_per_week', timesPerWeek: 3 } }), [], TODAY)).toEqual([]);
  });
});

describe('habitRecovery', () => {
  const allDone = (except: number[]) =>
    doneOn('read', ...Array.from({ length: 13 }, (_, i) => i + 1).filter((d) => !except.includes(d)));

  it('is steady with no missed days', () => {
    const r = habitRecovery(habit('read'), allDone([]), TODAY);
    expect(r.status).toBe('steady');
    expect(r.consistency7).toBe(100);
    expect(recoveryMessage(r, TODAY)).toBe('No missed days in the last 2 weeks');
  });

  it('is back on track once a day after the miss is done', () => {
    const r = habitRecovery(habit('read'), allDone([11]), TODAY);
    expect(r.status).toBe('recovered');
    expect(r.lastMissed).toBe('2026-11-11');
    expect(r.recoveredOn).toBe('2026-11-12');
    expect(recoveryMessage(r, TODAY)).toBe('Back on track since Thu after missing Wed');
  });

  it('offers a fresh start when the last miss has not been followed by a done day', () => {
    const r = habitRecovery(habit('read'), allDone([13]), TODAY);
    expect(r.status).toBe('fresh-start');
    expect(recoveryMessage(r, TODAY)).toBe('Missed Fri. Today is a fresh start.');
  });

  it('leaves rest days out of 7-day consistency', () => {
    const checkIns = [...doneOn('read', 7, 8, 9, 10, 11), check('read', '2026-11-12', { skipped: true }), check('read', '2026-11-13', { skipped: true })];
    expect(habitRecovery(habit('read'), checkIns, TODAY).consistency7).toBe(100);
  });
});

describe('overallConsistency', () => {
  it('combines active habits over the last 7 finished days', () => {
    const checkIns = [
      ...doneOn('a', 7, 8, 9, 10, 11, 12, 13), // 7/7
      ...doneOn('b', 7, 8, 9), // 3 of 6 countable (one rest)
      check('b', '2026-11-13', { skipped: true }),
    ];
    const result = overallConsistency([habit('a'), habit('b'), habit('old', { archived: true })], checkIns, [], TODAY);
    expect(result).toEqual({ percent: 77, missedDays: 3, restDays: 1 });
  });
});
