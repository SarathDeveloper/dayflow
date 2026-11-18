import { countsAsIncome, countsAsSpending } from './moneyLinks';
/**
 * Long-term money views: a year month by month, category trends over several
 * months, and net worth (accounts + money lent − money owed) at each month end.
 * Pure; rupees out, sums in paise.
 */
import type { Account, Debt, FinanceTransaction } from '../types';
import { computeAccountBalances, monthKeyOf, monthRange, shiftMonthKey } from './ledger';
import { fromPaise, toPaise } from './money';
import { debtOutstanding } from './debtPlanner';

export interface MonthTotals {
  monthKey: string;
  income: number;
  expense: number;
  net: number;
}

export interface YearReport {
  year: number;
  months: MonthTotals[];
  income: number;
  expense: number;
  net: number;
  /** Share of income kept, 0-100 (0 when there was no income). */
  savingsRate: number;
  topCategories: { category: string; amount: number; share: number }[];
  biggestMonth: MonthTotals | null;
}

export function yearReport(transactions: FinanceTransaction[], year: number): YearReport {
  const income = new Array(12).fill(0);
  const expense = new Array(12).fill(0);
  const byCategory = new Map<string, number>();
  for (const tx of transactions) {
    if (Number(tx.date.slice(0, 4)) !== year) continue;
    const month = Number(tx.date.slice(5, 7)) - 1;
    if (countsAsIncome(tx)) income[month] += toPaise(tx.amount);
    if (countsAsSpending(tx)) {
      expense[month] += toPaise(tx.amount);
      byCategory.set(tx.category, (byCategory.get(tx.category) ?? 0) + toPaise(tx.amount));
    }
  }
  const months = income.map((value, index) => ({
    monthKey: `${year}-${String(index + 1).padStart(2, '0')}`,
    income: fromPaise(value),
    expense: fromPaise(expense[index]),
    net: fromPaise(value - expense[index]),
  }));
  const incomeTotal = income.reduce((a, b) => a + b, 0);
  const expenseTotal = expense.reduce((a, b) => a + b, 0);
  const topCategories = [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([category, paise]) => ({
      category,
      amount: fromPaise(paise),
      share: expenseTotal ? Math.round((paise / expenseTotal) * 100) : 0,
    }));
  const withSpending = months.filter((month) => month.expense > 0);
  return {
    year,
    months,
    income: fromPaise(incomeTotal),
    expense: fromPaise(expenseTotal),
    net: fromPaise(incomeTotal - expenseTotal),
    savingsRate: incomeTotal > 0 ? Math.max(0, Math.round(((incomeTotal - expenseTotal) / incomeTotal) * 100)) : 0,
    topCategories,
    biggestMonth: withSpending.length ? withSpending.reduce((a, b) => (b.expense > a.expense ? b : a)) : null,
  };
}

export interface CategoryTrend {
  category: string;
  /** Oldest month first, aligned with `months`. */
  amounts: number[];
  total: number;
  average: number;
  /** Latest full month vs the average of the months before it, in percent (null without history). */
  change: number | null;
}

/** Spending per category over the `count` months ending with `lastMonth`. */
export function categoryTrends(
  transactions: FinanceTransaction[],
  lastMonth: string,
  count = 6,
): { months: string[]; trends: CategoryTrend[] } {
  const months = Array.from({ length: count }, (_, index) => shiftMonthKey(lastMonth, index - count + 1));
  const position = new Map(months.map((month, index) => [month, index]));
  const table = new Map<string, number[]>();
  for (const tx of transactions) {
    if (!countsAsSpending(tx)) continue;
    const index = position.get(monthKeyOf(tx.date));
    if (index === undefined) continue;
    const row = table.get(tx.category) ?? new Array(count).fill(0);
    row[index] += toPaise(tx.amount);
    table.set(tx.category, row);
  }
  const trends = [...table.entries()].map(([category, row]) => {
    const total = row.reduce((a, b) => a + b, 0);
    const before = row.slice(0, -1);
    const beforeAverage = before.length ? before.reduce((a, b) => a + b, 0) / before.length : 0;
    const latest = row[row.length - 1];
    return {
      category,
      amounts: row.map(fromPaise),
      total: fromPaise(total),
      average: fromPaise(Math.round(total / count)),
      change: beforeAverage > 0 ? Math.round(((latest - beforeAverage) / beforeAverage) * 100) : null,
    };
  }).sort((a, b) => b.total - a.total);
  return { months, trends };
}

export interface NetWorthPoint {
  monthKey: string;
  /** Account balances at the month end (cash, bank, gold, stocks, …). */
  accounts: number;
  /** Money others owe you, still unpaid then. */
  lent: number;
  /** Money you owe, still unpaid then. */
  owed: number;
  netWorth: number;
}

function unpaidAt(debt: Debt, date: string): number {
  if (debt.date > date) return 0;
  if (debt.paid && debt.paidAt && debt.paidAt.slice(0, 10) <= date) return 0;
  return debtOutstanding(debt, date);
}

/** Net worth at the end of each of the `count` months ending with `lastMonth` (or today for the current month). */
export function netWorthSeries(
  accounts: Account[],
  transactions: FinanceTransaction[],
  debts: Debt[],
  lastMonth: string,
  today: string,
  count = 12,
): NetWorthPoint[] {
  const active = accounts.filter((account) => !account.isArchived);
  return Array.from({ length: count }, (_, index) => shiftMonthKey(lastMonth, index - count + 1)).map((monthKey) => {
    const end = monthRange(monthKey).to;
    const at = end > today ? today : end;
    const balances = computeAccountBalances(active, transactions.filter((tx) => tx.date <= at));
    const accountsPaise = active.reduce((sum, account) => sum + (balances.get(account.id) ?? 0), 0);
    let lentPaise = 0;
    let owedPaise = 0;
    for (const debt of debts) {
      const amount = toPaise(unpaidAt(debt, at));
      if (debt.direction === 'lent') lentPaise += amount;
      else owedPaise += amount;
    }
    return {
      monthKey,
      accounts: fromPaise(accountsPaise),
      lent: fromPaise(lentPaise),
      owed: fromPaise(owedPaise),
      netWorth: fromPaise(accountsPaise + lentPaise - owedPaise),
    };
  });
}
