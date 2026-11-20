import { describe, expect, it } from 'vitest';
import type { CategoryBudget, MonthlyBudget } from '../types';
import { effectiveCategoryBudgets, effectiveMonthlyBudget, isCarriedOver, setCategoryBudget, setMonthlyBudget, staleCarryStops } from './budgetCarry';

const mb = (month: string, limit: number): MonthlyBudget => ({ id: `budget-${month}`, month, limit });
const cb = (month: string, category: string, limit: number): CategoryBudget => ({ id: `cbudget-${month}-${category}`, month, category, limit });

describe('monthly budget carry-over', () => {
  const budgets = [mb('2026-09', 20000), mb('2026-10', 25000)];

  it('uses the month own budget when set', () => {
    expect(effectiveMonthlyBudget(budgets, '2026-10')?.limit).toBe(25000);
  });

  it('carries the latest earlier budget into later months', () => {
    const next = effectiveMonthlyBudget(budgets, '2026-12');
    expect(next?.limit).toBe(25000);
    expect(isCarriedOver(next, '2026-12')).toBe(true);
  });

  it('has none before the first budget, and a 0 limit stops the carry', () => {
    expect(effectiveMonthlyBudget(budgets, '2026-08')).toBeNull();
    expect(effectiveMonthlyBudget([...budgets, mb('2026-11', 0)], '2027-01')).toBeNull();
  });
});

describe('category budget carry-over', () => {
  const budgets = [cb('2026-09', 'Food', 5000), cb('2026-10', 'Food', 6000), cb('2026-09', 'Fuel', 2000)];

  it('takes each category from its latest month at or before', () => {
    expect(effectiveCategoryBudgets(budgets, '2026-11').map((b) => [b.category, b.limit])).toEqual([
      ['Food', 6000],
      ['Fuel', 2000],
    ]);
  });

  it('drops a category removed (0) in an earlier month', () => {
    const removed = [...budgets, cb('2026-10', 'Fuel', 0)];
    expect(effectiveCategoryBudgets(removed, '2026-11').map((b) => b.category)).toEqual(['Food']);
    expect(effectiveCategoryBudgets(removed, '2026-09').map((b) => b.category)).toEqual(['Food', 'Fuel']);
  });
});

describe('editing budgets with carry-over', () => {
  const now = '2026-11-20T00:00:00.000Z';

  it('pins the next month when a past month is edited', () => {
    const budgets = [mb('2026-09', 3000)];
    const next = setMonthlyBudget(budgets, '2026-10', 2000, '2026-11', now);
    expect(effectiveMonthlyBudget(next, '2026-10')?.limit).toBe(2000);
    expect(effectiveMonthlyBudget(next, '2026-11')?.limit).toBe(3000);
  });

  it('does not pin when editing the current month', () => {
    const next = setMonthlyBudget([mb('2026-09', 3000)], '2026-11', 0, '2026-11', now);
    expect(next).toHaveLength(2);
    expect(effectiveMonthlyBudget(next, '2027-01')).toBeNull();
  });

  it('pins a category the same way', () => {
    const next = setCategoryBudget([cb('2026-09', 'Food', 3000)], '2026-10', 'Food', 0, '2026-11', now);
    expect(effectiveCategoryBudgets(next, '2026-10')).toEqual([]);
    expect(effectiveCategoryBudgets(next, '2026-11').map((b) => b.limit)).toEqual([3000]);
  });
});

describe('stop rows for budgets that lapsed before carry-over', () => {
  const now = '2026-11-20T00:00:00.000Z';

  it('stops budgets older than last month and keeps last month carrying', () => {
    const stops = staleCarryStops(
      [mb('2026-03', 9000)],
      [cb('2026-03', 'Food', 2000), cb('2026-10', 'Fuel', 1500)],
      '2026-11',
      now
    );
    expect(stops.budgets.map((b) => [b.month, b.carryStop])).toEqual([['2026-04', true]]);
    expect(stops.categoryBudgets.map((b) => b.category)).toEqual(['Food']);
    const budgets = [mb('2026-03', 9000), ...stops.budgets];
    expect(effectiveMonthlyBudget(budgets, '2026-11')).toBeNull();
  });

  it('never beats a real row in the same month (set on another device)', () => {
    const stop: MonthlyBudget = { id: 'budget-stop-2026-04', month: '2026-04', limit: 0, carryStop: true };
    expect(effectiveMonthlyBudget([mb('2026-03', 9000), mb('2026-04', 5000), stop], '2026-11')?.limit).toBe(5000);
    expect(effectiveMonthlyBudget([stop, mb('2026-04', 5000)], '2026-11')?.limit).toBe(5000);
  });
});
