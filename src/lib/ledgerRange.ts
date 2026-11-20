/**
 * Stepping the Money ledger's history range with ‹ › arrows: one day, week
 * (Sunday start, like `weekRange`), month or year at a time. Pure, local dates.
 */
import { shiftMonthKey, weekRange } from './ledger';
import { financialYearLabel, financialYearOf, financialYearRange } from './statementCsv';

/** `fy` is the Indian financial year, 1 April to 31 March. */
export type StepUnit = 'day' | 'week' | 'month' | 'year' | 'fy';

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The anchor date moved by `step` units. Months and years land on the 1st so they never skip. */
export function shiftAnchor(date: string, unit: StepUnit, step: number): string {
  const [y, m, d] = date.split('-').map(Number);
  if (unit === 'day') return iso(new Date(y, m - 1, d + step));
  if (unit === 'week') return iso(new Date(y, m - 1, d + 7 * step));
  if (unit === 'month') return `${shiftMonthKey(date.slice(0, 7), step)}-01`;
  if (unit === 'fy') return `${financialYearOf(date) + step}-04-01`;
  return `${y + step}-01-01`;
}

const fmt = (date: string, options: Intl.DateTimeFormatOptions) =>
  new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', options);

/** Short label for the period around `date`: "Fri, 20 Nov", "15 – 21 Nov", "Nov 2026", "2026". */
export function periodLabel(date: string, unit: StepUnit): string {
  if (unit === 'day') return fmt(date, { weekday: 'short', day: 'numeric', month: 'short' });
  if (unit === 'week') {
    const { from, to } = weekRange(date);
    const sameMonth = from.slice(0, 7) === to.slice(0, 7);
    return `${fmt(from, sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' })} – ${fmt(to, { day: 'numeric', month: 'short' })}`;
  }
  if (unit === 'month') return fmt(date, { month: 'short', year: 'numeric' });
  if (unit === 'fy') return financialYearLabel(financialYearOf(date));
  return date.slice(0, 4);
}

/** True when the period around `date` already contains `today` (no point stepping forward). */
export function isCurrentPeriod(date: string, unit: StepUnit, today: string): boolean {
  if (unit === 'day') return date >= today;
  if (unit === 'week') return weekRange(date).to >= today;
  if (unit === 'month') return date.slice(0, 7) >= today.slice(0, 7);
  if (unit === 'fy') return financialYearRange(financialYearOf(date)).to >= today;
  return date.slice(0, 4) >= today.slice(0, 4);
}
