import { describe, expect, it } from 'vitest';
import type { Account, BillPayment, BillTemplate, Debt, FinanceTransaction } from '../types';
import { checkSplit, evaluateAmount, isAmountExpression, parseQuickEntry, repeatableEntries, splitRemainder } from './quickEntry';
import { findSubscriptions, forecastMonth, unpaidBills } from './moneyForecast';
import { categoryTrends, netWorthSeries, yearReport } from './moneyReports';
import { debtOutstanding, emiAmount, emiSchedule, loanSummary, nextPayment, payoffPlan } from './debtPlanner';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../data/financeCategories';

const stamp = '2026-01-01T00:00:00.000Z';
let seq = 0;
function tx(date: string, amount: number, type: FinanceTransaction['type'] = 'expense', extra: Partial<FinanceTransaction> = {}): FinanceTransaction {
  return { id: `t${seq++}`, type, amount, category: 'Food & Dining', date, recurrence: { type: 'none' }, createdAt: stamp, updatedAt: stamp, ...extra };
}
function account(id: string, type: Account['type'], openingBalance: number, name = id): Account {
  return { id, name, type, openingBalance, isArchived: false, createdAt: stamp, updatedAt: stamp };
}
function debt(extra: Partial<Debt>): Debt {
  return { id: 'd1', direction: 'owed', personName: 'Loan', amount: 100000, date: '2026-01-01', paid: false, createdAt: stamp, updatedAt: stamp, ...extra };
}

const context = {
  expenseCategories: [...EXPENSE_CATEGORIES, 'Groceries'],
  incomeCategories: [...INCOME_CATEGORIES],
  accounts: [account('hdfc', 'savings', 0, 'HDFC Bank'), account('cash', 'cash', 0, 'Cash Wallet')],
};

describe('amount expressions', () => {
  it('adds, multiplies and rounds to paise without eval', () => {
    expect(evaluateAmount('120+45*2')).toBe(210);
    expect(evaluateAmount('₹1,200.50 + 99.5')).toBe(1300);
    expect(evaluateAmount('(100-20)/3')).toBe(26.67);
    expect(evaluateAmount('3x40')).toBe(120);
    for (const bad of ['', '10/0', '5-10', 'alert(1)', '2**3', '1+', '(2']) expect(evaluateAmount(bad)).toBeNull();
    expect(isAmountExpression('120+45')).toBe(true);
    expect(isAmountExpression('120')).toBe(false);
  });
});

describe('quick add', () => {
  it('reads amount, category, method and account in any order', () => {
    expect(parseQuickEntry('250 lunch upi', context)).toMatchObject({ type: 'expense', amount: 250, category: 'Food & Dining', note: 'lunch', paymentMethod: 'gpay' });
    expect(parseQuickEntry('petrol 1,200.50 hdfc', context)).toMatchObject({ amount: 1200.5, category: 'Fuel', accountId: 'hdfc' });
    expect(parseQuickEntry('+5000 salary', context)).toMatchObject({ type: 'income', amount: 5000, category: 'Salary', note: '' });
    expect(parseQuickEntry('received 800 from ravi', context)).toMatchObject({ type: 'income', category: 'Other', note: 'from ravi' });
    expect(parseQuickEntry('groceries 640 cash', context)).toMatchObject({ category: 'Groceries', paymentMethod: 'cash', note: '' });
    expect(parseQuickEntry('2*60 chai', context)).toMatchObject({ amount: 120, category: 'Food & Dining' });
    expect(parseQuickEntry('random thing 99', context)).toMatchObject({ category: 'Other', note: 'random thing' });
    expect(parseQuickEntry('lunch with team', context)).toBeNull();
  });

  it('ranks repeatable entries by how often they happen', () => {
    const list = [
      tx('2026-11-10', 30, 'expense', { note: 'tea' }), tx('2026-11-11', 30, 'expense', { note: 'Tea' }),
      tx('2026-11-12', 30, 'expense', { note: 'tea' }), tx('2026-11-12', 250, 'expense', { note: 'lunch' }),
      tx('2026-08-01', 999, 'expense', { note: 'old' }), tx('2026-11-12', 500, 'transfer'),
    ];
    const recent = repeatableEntries(list, '2026-11-18');
    expect(recent[0]).toMatchObject({ amount: 30, count: 3 });
    expect(recent.map((item) => item.amount)).toEqual([30, 250]);
  });

  it('checks that split parts add up to the total', () => {
    expect(checkSplit(1000, [{ category: 'Food & Dining', amount: 600 }, { category: 'Shopping', amount: 400 }])).toBeNull();
    expect(checkSplit(1000, [{ category: 'Food & Dining', amount: 600 }, { category: 'Shopping', amount: 300 }])).toContain('not assigned');
    expect(checkSplit(1000, [{ category: 'Food & Dining', amount: 1000 }])).toContain('two');
    expect(checkSplit(0.3, [{ category: 'A', amount: 0.1 }, { category: 'B', amount: 0.2 }])).toBeNull();
    expect(splitRemainder(1000, [{ category: 'A', amount: 333.33 }])).toBe(666.67);
  });
});

describe('month forecast', () => {
  const templates: BillTemplate[] = [
    { id: 'rent', name: 'Rent', amount: 10000, category: 'Rent & Housing', dueDayOfMonth: 25, active: true, createdAt: stamp, updatedAt: stamp },
    { id: 'net', name: 'Internet', amount: 700, category: 'Bills & Utilities', dueDayOfMonth: 5, active: true, createdAt: stamp, updatedAt: stamp },
    { id: 'old', name: 'Paused', amount: 50, category: 'Other', dueDayOfMonth: 5, active: false, createdAt: stamp, updatedAt: stamp },
  ];
  const payments: BillPayment[] = [
    { id: 'p1', billId: 'net', month: '2026-11', amount: 700, dueDate: '2026-11-05', paid: true, transactionId: 'netpay', createdAt: stamp, updatedAt: stamp },
  ];

  it('lists unpaid bills only', () => {
    expect(unpaidBills('2026-11', '2026-11-18', templates, payments).map((bill) => bill.name)).toEqual(['Rent']);
  });

  it('projects the month and a safe daily amount from the budget', () => {
    const list = [
      tx('2026-11-01', 20000, 'income', { accountId: 'bank' }),
      ...Array.from({ length: 30 }, (_, index) => tx(`2026-${index < 12 ? '10' : '11'}-${String(index < 12 ? 20 + index : index - 11).padStart(2, '0')}`, 100, 'expense', { accountId: 'bank' })),
      tx('2026-11-05', 700, 'expense', { id: 'netpay', accountId: 'bank' }),
      tx('2026-11-30', 999, 'expense', { accountId: 'bank' }),
    ].filter((item) => item.date <= '2026-11-30');
    const result = forecastMonth({
      today: '2026-11-18', transactions: list, accounts: [account('bank', 'savings', 5000), account('gold', 'gold', 50000)],
      billTemplates: templates, billPayments: payments, budget: 15000,
    });
    expect(result.daysLeft).toBe(13);
    expect(result.dailyPace).toBe(100);
    expect(result.billsDueTotal).toBe(10000);
    expect(result.spentSoFar).toBe(2500);
    expect(result.projectedSpend).toBe(2500 + 100 * 12 + 10000);
    expect(result.balanceNow).toBe(5000 + 20000 - 3700);
    expect(result.safePerDay).toBe(Math.floor((15000 - 2500 - 10000) / 13 * 100) / 100);
    expect(result.basis).toBe('budget');
    const noBudget = forecastMonth({ today: '2026-11-18', transactions: list, accounts: [account('bank', 'savings', 5000)], billTemplates: templates, billPayments: payments });
    expect(noBudget.basis).toBe('balance');
    expect(noBudget.projectedEndBalance).toBe(21300 - 1200 - 10000);
  });

  it('finds monthly repeating payments, not daily habits', () => {
    const list = [
      ...['2026-08-03', '2026-09-03', '2026-10-03', '2026-11-03'].map((date) => tx(date, 649, 'expense', { note: 'Netflix' })),
      ...['2026-09-01', '2026-09-02', '2026-10-01', '2026-11-01', '2026-11-02'].map((date) => tx(date, 20, 'expense', { note: 'tea' })),
    ];
    const subs = findSubscriptions(list, [], '2026-11-18');
    expect(subs.map((item) => item.name)).toEqual(['Netflix']);
    expect(subs[0].yearly).toBe(7788);
  });
});

describe('reports', () => {
  const list = [
    tx('2026-01-05', 50000, 'income'), tx('2026-01-10', 20000, 'expense', { category: 'Rent & Housing' }),
    tx('2026-02-10', 5000, 'expense'), tx('2026-02-15', 1000, 'transfer'), tx('2025-12-31', 999, 'expense'),
  ];

  it('totals a year by month', () => {
    const report = yearReport(list, 2026);
    expect(report.income).toBe(50000);
    expect(report.expense).toBe(25000);
    expect(report.savingsRate).toBe(50);
    expect(report.months[0]).toMatchObject({ income: 50000, expense: 20000, net: 30000 });
    expect(report.biggestMonth?.monthKey).toBe('2026-01');
    expect(report.topCategories[0]).toMatchObject({ category: 'Rent & Housing', share: 80 });
  });

  it('builds category trends with the change vs earlier months', () => {
    const trend = categoryTrends([tx('2026-01-10', 100), tx('2026-02-10', 100), tx('2026-03-10', 300)], '2026-03', 3);
    expect(trend.months).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(trend.trends[0]).toMatchObject({ category: 'Food & Dining', amounts: [100, 100, 300], change: 200 });
  });

  it('tracks net worth with accounts, money lent and money owed', () => {
    const accounts = [account('bank', 'savings', 1000)];
    const series = netWorthSeries(accounts, [tx('2026-02-10', 400, 'expense', { accountId: 'bank' })],
      [debt({ direction: 'lent', amount: 300, date: '2026-01-15' }), debt({ id: 'd2', amount: 200, date: '2026-02-01', paid: true, paidAt: '2026-02-20' })],
      '2026-02', '2026-03-01', 2);
    expect(series[0]).toMatchObject({ monthKey: '2026-01', accounts: 1000, lent: 300, owed: 0, netWorth: 1300 });
    expect(series[1]).toMatchObject({ accounts: 600, lent: 300, owed: 0, netWorth: 900 });
  });
});

describe('debts and loans', () => {
  it('computes the standard EMI and a schedule that ends at zero', () => {
    expect(emiAmount(100000, 12, 12)).toBe(8884.88);
    expect(emiAmount(12000, 0, 12)).toBe(1000);
    const rows = emiSchedule(100000, 12, 12, '2026-01-31');
    expect(rows).toHaveLength(12);
    expect(rows[1].dueDate).toBe('2026-02-28');
    expect(rows[0].interest).toBe(1000);
    expect(rows[11].balance).toBe(0);
  });

  it('knows what is outstanding and what is next', () => {
    const loan = debt({ loan: { annualRate: 12, tenureMonths: 12, firstEmiDate: '2026-01-10' } });
    const rows = emiSchedule(100000, 12, 12, '2026-01-10');
    expect(debtOutstanding(loan, '2026-03-15')).toBe(rows[2].balance);
    expect(nextPayment(loan, '2026-03-15')).toMatchObject({ date: '2026-04-10', number: 4 });
    expect(loanSummary(loan, '2026-03-15')).toMatchObject({ emisPaid: 3, emisLeft: 9, endDate: '2026-12-10' });
    const friend = debt({ id: 'f', amount: 5000, dueDate: '2026-03-01', payments: [{ id: 'p', date: '2026-02-01', amount: 2000 }] });
    expect(debtOutstanding(friend, '2026-03-15')).toBe(3000);
    expect(nextPayment(friend, '2026-03-15')).toMatchObject({ amount: 3000, overdue: true });
  });

  it('plans payoff: avalanche saves interest, extra money shortens it', () => {
    const debts = [
      debt({ id: 'a', personName: 'Card', amount: 50000, loan: { annualRate: 36, tenureMonths: 24, firstEmiDate: '2026-12-01' } }),
      debt({ id: 'b', personName: 'Bike', amount: 80000, loan: { annualRate: 9, tenureMonths: 24, firstEmiDate: '2026-12-01' } }),
    ];
    const base = payoffPlan(debts, '2026-11-18', 0, 'avalanche');
    const avalanche = payoffPlan(debts, '2026-11-18', 3000, 'avalanche');
    const snowball = payoffPlan(debts, '2026-11-18', 3000, 'snowball');
    expect(base.months).toBe(24);
    expect(avalanche.months).toBeLessThan(base.months);
    expect(avalanche.totalInterest).toBeLessThanOrEqual(snowball.totalInterest);
    expect(avalanche.order[0].name).toBe('Card');
    expect(payoffPlan([], '2026-11-18', 1000, 'snowball').months).toBe(0);
    // Without extra money, a short loan ending does not speed up the long one.
    const mixed = [
      debt({ id: 's', personName: 'Short', amount: 12000, loan: { annualRate: 0, tenureMonths: 6, firstEmiDate: '2026-12-01' } }),
      debt({ id: 'l', personName: 'Long', amount: 36000, loan: { annualRate: 0, tenureMonths: 36, firstEmiDate: '2026-12-01' } }),
    ];
    expect(payoffPlan(mixed, '2026-11-18', 0, 'avalanche').months).toBe(36);
    expect(payoffPlan(mixed, '2026-11-18', 1, 'avalanche').months).toBeLessThan(36);
  });

  it('leaves monthly repeating payments out of the daily pace', () => {
    const list = ['2026-08-05', '2026-09-05', '2026-10-05', '2026-11-05'].map((date) => tx(date, 12000, 'expense', { note: 'Rent', category: 'Rent & Housing' }));
    list.push(tx('2026-11-10', 300, 'expense'));
    const result = forecastMonth({ today: '2026-11-18', transactions: list, accounts: [], billTemplates: [], billPayments: [] });
    expect(result.dailyPace).toBe(10);
  });
});
