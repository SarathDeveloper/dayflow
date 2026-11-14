import { describe, expect, it } from 'vitest';
import { checkBudgetAlerts } from './budgetAlerts';
import type { FinanceTransaction } from '../types';

const expense = (id: string, amount: number, category = 'Food'): FinanceTransaction => ({
  id,
  type: 'expense',
  amount,
  category,
  date: '2026-11-10',
  recurrence: { type: 'none' },
  createdAt: '2026-11-10T10:00:00.000Z',
  updatedAt: '2026-11-10T10:00:00.000Z',
});

describe('checkBudgetAlerts', () => {
  it('fires the 100% alert when spends add up to the limit exactly', () => {
    // As floats these sum to 99.99999999999999, which used to stay at "warning".
    const transactions = [expense('a', 0.02), expense('b', 64.07), expense('c', 35.91)];
    const { alerts, stateUpdates } = checkBudgetAlerts({
      transactions,
      budgets: [{ id: 'budget-2026-11', month: '2026-11', limit: 100 }],
      categoryBudgets: [{ id: 'cb-1', month: '2026-11', category: 'Food', limit: 100 }],
      alertState: {},
      month: '2026-11',
    });
    expect(alerts.map((a) => a.level)).toEqual(['critical', 'critical']);
    expect(stateUpdates['2026-11'].hundredNotifiedAt).toBeTruthy();
  });

  it('does not count transfers or income as spending', () => {
    const transfer = { ...expense('t', 500), type: 'transfer' as const };
    const income = { ...expense('i', 500), type: 'income' as const };
    const { alerts } = checkBudgetAlerts({
      transactions: [transfer, income, expense('a', 10)],
      budgets: [{ id: 'budget-2026-11', month: '2026-11', limit: 100 }],
      categoryBudgets: [],
      alertState: {},
      month: '2026-11',
    });
    expect(alerts).toEqual([]);
  });
});
