import { describe, expect, it } from 'vitest';
import { isCurrentPeriod, periodLabel, shiftAnchor } from './ledgerRange';

describe('ledger range stepping', () => {
  it('steps days and weeks across month ends', () => {
    expect(shiftAnchor('2026-11-30', 'day', 1)).toBe('2026-12-01');
    expect(shiftAnchor('2026-11-03', 'week', -1)).toBe('2026-10-27');
  });

  it('steps months from the 31st without skipping', () => {
    expect(shiftAnchor('2026-01-31', 'month', 1)).toBe('2026-02-01');
    expect(shiftAnchor('2026-01-15', 'month', -1)).toBe('2025-12-01');
  });

  it('steps years', () => {
    expect(shiftAnchor('2026-11-20', 'year', -1)).toBe('2025-01-01');
  });

  it('labels each period', () => {
    expect(periodLabel('2026-11-20', 'month')).toMatch(/Nov.*2026/);
    expect(periodLabel('2026-11-20', 'year')).toBe('2026');
    expect(periodLabel('2026-11-20', 'week')).toMatch(/15.*21 Nov/);
  });

  it('knows when the period is already the current one', () => {
    expect(isCurrentPeriod('2026-11-01', 'month', '2026-11-20')).toBe(true);
    expect(isCurrentPeriod('2026-10-31', 'month', '2026-11-20')).toBe(false);
    expect(isCurrentPeriod('2026-11-16', 'week', '2026-11-20')).toBe(true);
  });
});
