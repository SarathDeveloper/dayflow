import { describe, expect, it } from 'vitest';
import type { Account, FinanceTransaction, MoneyGoal } from '../types';
import { goalProgress, monthsUntil, sortGoals } from './moneyGoals';

const STAMP = '2026-11-01T00:00:00.000Z';
const goal = (over: Partial<MoneyGoal> = {}): MoneyGoal => ({
  id: 'g1',
  name: 'Emergency fund',
  target: 100000,
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
});
const bank: Account = { id: 'cub', name: 'CUB', type: 'savings', savingsOnly: true, openingBalance: 20000, isArchived: false, createdAt: STAMP, updatedAt: STAMP };
const move = (amount: number, date: string): FinanceTransaction => ({
  id: `t-${date}`,
  type: 'transfer',
  amount,
  category: 'Transfer',
  accountId: 'yes',
  destinationAccountId: 'cub',
  date,
  recurrence: { type: 'none' },
  createdAt: STAMP,
  updatedAt: STAMP,
});

describe('savings goals', () => {
  it('counts the linked account balance and works out the monthly amount', () => {
    const p = goalProgress(goal({ accountId: 'cub', targetDate: '2027-03-31' }), [bank], [move(10000, '2026-11-10')], '2026-11-20');
    expect(p.saved).toBe(30000);
    expect(p.percent).toBe(30);
    expect(p.monthsLeft).toBe(5);
    expect(p.perMonth).toBe(14000);
    expect(p.done).toBe(false);
  });

  it('ignores future-dated entries and uses the typed amount without an account', () => {
    expect(goalProgress(goal({ accountId: 'cub' }), [bank], [move(10000, '2026-12-01')], '2026-11-20').saved).toBe(20000);
    const manual = goalProgress(goal({ savedAmount: 25000 }), [], [], '2026-11-20');
    expect(manual.saved).toBe(25000);
    expect(manual.perMonth).toBeNull();
  });

  it('marks reached and late goals', () => {
    expect(goalProgress(goal({ savedAmount: 100000 }), [], [], '2026-11-20').done).toBe(true);
    const late = goalProgress(goal({ savedAmount: 1000, targetDate: '2026-10-01' }), [], [], '2026-11-20');
    expect(late.late).toBe(true);
    expect(late.perMonth).toBeNull();
  });

  it('counts a part month as a month', () => {
    expect(monthsUntil('2026-11-20', '2026-11-25')).toBe(1);
    expect(monthsUntil('2026-11-20', '2027-01-10')).toBe(2);
  });

  it('lists active goals by date first, then archived ones', () => {
    const sorted = sortGoals([
      goal({ id: 'a', name: 'Bike', archived: true }),
      goal({ id: 'b', name: 'Trip' }),
      goal({ id: 'c', name: 'Fund', targetDate: '2027-01-01' }),
    ]);
    expect(sorted.map((g) => g.id)).toEqual(['c', 'b', 'a']);
  });
});
