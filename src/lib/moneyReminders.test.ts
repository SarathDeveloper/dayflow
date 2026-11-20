import { describe, expect, it } from 'vitest';
import type { Account, BillPayment, BillTemplate, Debt, FinanceTransaction } from '../types';
import { buildMoneyReminders, moneySectionFromRoute, MONEY_BILLS_ROUTE, MONEY_DEBTS_ROUTE } from './moneyReminders';
import { buildExtraReminderPlans, isExtraNotificationId } from './extraReminders';
import { cardDues, cardStatus, dueDateFor, lastStatementDate } from './creditCard';
import { availableBalancePaise } from './ledger';

const STAMP = '2026-11-01T00:00:00.000Z';

const template = (over: Partial<BillTemplate> = {}): BillTemplate => ({
  id: 'bill-power',
  name: 'Electricity',
  amount: 1200,
  category: 'Bills & Utilities',
  dueDayOfMonth: 25,
  active: true,
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
});

const payment = (over: Partial<BillPayment> = {}): BillPayment => ({
  id: 'bp-power-2026-11',
  billId: 'bill-power',
  month: '2026-11',
  amount: 1200,
  dueDate: '2026-11-25',
  paid: false,
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
});

const debt = (over: Partial<Debt> = {}): Debt => ({
  id: 'debt-1',
  direction: 'owed',
  personName: 'Ravi',
  amount: 5000,
  date: '2026-11-01',
  dueDate: '2026-11-30',
  paid: false,
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
});

describe('money reminders', () => {
  const today = '2026-11-20';

  it('reminds 2 days before and on the due day of an unpaid bill', () => {
    const reminders = buildMoneyReminders({ billTemplates: [template()], billPayments: [payment()], debts: [], today });
    const thisMonth = reminders.filter((r) => r.key.startsWith('bp-power-2026-11'));
    expect(thisMonth.map((r) => r.date)).toEqual(['2026-11-23', '2026-11-25']);
    expect(thisMonth[0].body).toContain('in 2 days');
    expect(thisMonth[1].body).toContain('today');
    expect(thisMonth[0].route).toBe(MONEY_BILLS_ROUTE);
  });

  it('skips paid bills and paused templates, and covers next month before it is created', () => {
    const paid = buildMoneyReminders({ billTemplates: [template()], billPayments: [payment({ paid: true })], debts: [], today });
    expect(paid.some((r) => r.key.startsWith('bp-power-2026-11'))).toBe(false);
    expect(paid.some((r) => r.date === '2026-12-25')).toBe(true);
    const paused = buildMoneyReminders({ billTemplates: [template({ active: false })], billPayments: [payment()], debts: [], today });
    expect(paused).toEqual([]);
  });

  it('labels a loan EMI bill as an EMI', () => {
    const reminders = buildMoneyReminders({ billTemplates: [template({ debtId: 'debt-loan', name: 'Car EMI' })], billPayments: [payment()], debts: [], today });
    expect(reminders[0].title).toBe('EMI due');
  });

  it('reminds about debts with a due date, with what is left', () => {
    const reminders = buildMoneyReminders({
      billTemplates: [],
      billPayments: [],
      debts: [debt({ payments: [{ id: 'p1', date: '2026-11-10', amount: 2000 }] }), debt({ id: 'd2', direction: 'lent', personName: 'Anu', dueDate: undefined })],
      today,
    });
    expect(reminders.map((r) => r.date)).toEqual(['2026-11-28', '2026-11-30']);
    expect(reminders[0].body).toContain('₹3,000');
    expect(reminders[0].route).toBe(MONEY_DEBTS_ROUTE);
  });

  it('never schedules a day already gone', () => {
    const reminders = buildMoneyReminders({ billTemplates: [template()], billPayments: [payment({ dueDate: '2026-11-21' })], debts: [], today });
    expect(reminders.filter((r) => r.key.startsWith('bp-power-2026-11')).map((r) => r.date)).toEqual(['2026-11-21']);
  });

  it('feeds the extra-reminder sync with negative ids and its route', () => {
    const money = buildMoneyReminders({ billTemplates: [template()], billPayments: [payment()], debts: [], today });
    const plans = buildExtraReminderPlans({ documents: [], maintenance: [], money, now: new Date(2026, 10, 20, 10) });
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.every((p) => isExtraNotificationId(p.notificationId))).toBe(true);
    expect(moneySectionFromRoute(plans[0].route)).toBe('bills');
  });
});

const card = (over: Partial<Account> = {}): Account => ({
  id: 'card',
  name: 'HDFC Card',
  type: 'credit_card',
  openingBalance: 0,
  isArchived: false,
  creditLimit: 50000,
  statementDay: 15,
  dueDay: 5,
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
});

const tx = (over: Partial<FinanceTransaction>): FinanceTransaction => ({
  id: 'tx',
  type: 'expense',
  amount: 100,
  category: 'Shopping',
  date: '2026-11-10',
  recurrence: { type: 'none' },
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
});

describe('credit cards', () => {
  it('finds the last statement and its due date', () => {
    expect(lastStatementDate(15, '2026-11-20')).toBe('2026-11-15');
    expect(lastStatementDate(15, '2026-11-10')).toBe('2026-10-15');
    expect(dueDateFor('2026-11-15', 5)).toBe('2026-12-05');
    expect(dueDateFor('2026-11-01', 20)).toBe('2026-11-20');
    expect(lastStatementDate(31, '2026-02-28')).toBe('2026-02-28');
  });

  it('works out what is owed, credit left and the statement due', () => {
    const spend = [
      tx({ id: 'a', accountId: 'card', amount: 3000, date: '2026-11-10' }),
      tx({ id: 'b', accountId: 'card', amount: 500, date: '2026-11-18' }),
      tx({ id: 'pay', type: 'transfer', accountId: 'bank', destinationAccountId: 'card', amount: 1000, date: '2026-11-19' }),
    ];
    const status = cardStatus(card(), spend, '2026-11-20');
    expect(status.owed).toBe(2500);
    expect(status.available).toBe(47500);
    expect(status.statement).toEqual({ date: '2026-11-15', amount: 3000, due: 2000, dueDate: '2026-12-05' });
    expect(cardDues([card()], spend, '2026-11-20')).toEqual([{ account: card(), dueDate: '2026-12-05', amount: 2000 }]);
  });

  it('lets a card spend down to its limit', () => {
    expect(availableBalancePaise(card(), [])).toBe(5_000_000);
    expect(availableBalancePaise(card({ creditLimit: undefined }), [])).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('feeds card dues into money reminders', () => {
    const reminders = buildMoneyReminders({
      billTemplates: [],
      billPayments: [],
      debts: [],
      cards: [{ account: card(), dueDate: '2026-12-05', amount: 2000 }],
      today: '2026-11-20',
    });
    expect(reminders.map((r) => r.date)).toEqual(['2026-12-03', '2026-12-05']);
    expect(reminders[0].title).toBe('Card bill due');
  });
});
