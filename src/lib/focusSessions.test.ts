import { afterAll, describe, expect, it } from 'vitest';
import { buildFocusSession, focusMinutesBetween, focusMinutesOn, formatMinutes } from './focusSessions';

const originalTz = process.env.TZ;
process.env.TZ = 'Asia/Kolkata';
afterAll(() => {
  process.env.TZ = originalTz;
});

describe('focus sessions', () => {
  it('records the local day the session ended, rounded minutes', () => {
    // 00:20 on 15 Nov in India is still 14 Nov in UTC.
    const session = buildFocusSession({ minutes: 24.6, startedAt: new Date(2026, 10, 14, 23, 55), taskId: 't1' }, new Date(2026, 10, 15, 0, 20));
    expect(session.date).toBe('2026-11-15');
    expect(session.minutes).toBe(25);
    expect(session.taskId).toBe('t1');
  });

  it('adds up minutes per day and per range', () => {
    const s = (date: string, minutes: number) => ({ ...buildFocusSession({ minutes, startedAt: new Date() }), date });
    const sessions = [s('2026-11-10', 25), s('2026-11-10', 25), s('2026-11-12', 50), s('2026-11-17', 15)];
    expect(focusMinutesOn(sessions, '2026-11-10')).toBe(50);
    expect(focusMinutesBetween(sessions, '2026-11-09', '2026-11-15')).toBe(100);
  });

  it('formats minutes', () => {
    expect(formatMinutes(40)).toBe('40 min');
    expect(formatMinutes(120)).toBe('2 h');
    expect(formatMinutes(85)).toBe('1 h 25 min');
  });
});
