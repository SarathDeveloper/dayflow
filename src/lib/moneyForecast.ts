/**
 * Looking ahead in the month: what the month will likely cost, where the
 * balance lands, and how much can be spent per day from now on. Pure; rupees
 * in and out, sums in paise. Dates are local "YYYY-MM-DD" strings.
 */
import type { Account, BillPayment, BillTemplate, FinanceTransaction } from '../types';
import { clampDueDate } from './billMaterializer';
import { computeAccountBalances, monthKeyOf } from './ledger';
import { fromPaise, toPaise } from './money';

/** Accounts money is spent from. Gold and stocks are wealth, not spending money. */
const SPENDABLE = new Set<Account['type']>(['cash', 'savings', 'current', 'other']);
/** Days of history the daily spending pace is averaged over. */
export const PACE_DAYS = 30;

export interface UpcomingBill {
  billId: string;
  name: string;
  amount: number;
  dueDate: string;
  overdue: boolean;
}

export interface MonthForecast {
  monthKey: string;
  daysInMonth: number;
  /** Days left including today. */
  daysLeft: number;
  spentSoFar: number;
  incomeSoFar: number;
  /** Average day-to-day spending over the last 30 days (bill payments left out). */
  dailyPace: number;
  /** Bills of this month not paid yet. */
  billsDue: UpcomingBill[];
  billsDueTotal: number;
  /** Spent so far + the pace for the days after today + unpaid bills. */
  projectedSpend: number;
  /** Money in cash and bank accounts now. */
  balanceNow: number;
  /** Before any more income arrives. */
  projectedEndBalance: number;
  /** The month's spending limit, when one is set. */
  budget: number | null;
  /** Per day from today so that the budget (or the balance) and bills still fit. Never negative. */
  safePerDay: number;
  basis: 'budget' | 'balance';
  status: 'comfortable' | 'tight' | 'over';
}

function daysIn(monthKey: string): number {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(year, month, 0).getDate();
}

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00`);
  value.setDate(value.getDate() + days);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

/** Spending that counts toward the month (transfers are moves between own accounts). */
function isSpend(tx: FinanceTransaction): boolean {
  return tx.type === 'expense';
}

export function unpaidBills(
  monthKey: string,
  today: string,
  templates: BillTemplate[],
  payments: BillPayment[],
): UpcomingBill[] {
  return templates
    .filter((bill) => bill.active)
    .map((bill) => {
      const payment = payments.find((item) => item.billId === bill.id && item.month === monthKey);
      if (payment?.paid) return null;
      const dueDate = payment?.dueDate ?? clampDueDate(monthKey, bill.dueDayOfMonth);
      return {
        billId: bill.id,
        name: bill.name,
        amount: payment?.amount ?? bill.amount,
        dueDate,
        overdue: dueDate < today,
      };
    })
    .filter((bill): bill is UpcomingBill => bill !== null && bill.amount > 0)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

export function forecastMonth(input: {
  today: string;
  transactions: FinanceTransaction[];
  accounts: Account[];
  billTemplates: BillTemplate[];
  billPayments: BillPayment[];
  /** The month's overall budget, if set. */
  budget?: number | null;
}): MonthForecast {
  const { today, transactions, accounts } = input;
  const monthKey = monthKeyOf(today);
  const daysInMonth = daysIn(monthKey);
  const day = Number(today.slice(8, 10));
  const daysLeft = daysInMonth - day + 1;
  const billTxIds = new Set(input.billPayments.map((payment) => payment.transactionId).filter(Boolean) as string[]);
  // Monthly repeating payments (rent, subscriptions) are not day-to-day spending:
  // spread over the month they would inflate the pace.
  const repeating = new Set(
    findSubscriptions(transactions, input.billPayments, today).map((item) => `${item.name.toLowerCase()}|${toPaise(item.amount)}`),
  );
  const isRepeating = (tx: FinanceTransaction) =>
    repeating.has(`${(tx.note?.trim() || tx.category).toLowerCase()}|${toPaise(tx.amount)}`);

  let spentPaise = 0;
  let incomePaise = 0;
  let pacePaise = 0;
  const paceFrom = shiftDate(today, -(PACE_DAYS - 1));
  let firstDate = today;
  for (const tx of transactions) {
    if (tx.date > today) continue;
    if (tx.date < firstDate) firstDate = tx.date;
    if (monthKeyOf(tx.date) === monthKey) {
      if (isSpend(tx)) spentPaise += toPaise(tx.amount);
      if (tx.type === 'income') incomePaise += toPaise(tx.amount);
    }
    if (isSpend(tx) && tx.date >= paceFrom && !billTxIds.has(tx.id) && !isRepeating(tx)) pacePaise += toPaise(tx.amount);
  }
  // A new user has less than 30 days of history: average over what there is.
  const historyDays = Math.min(PACE_DAYS, Math.max(1, Math.round((Date.parse(`${today}T00:00:00`) - Date.parse(`${firstDate > paceFrom ? firstDate : paceFrom}T00:00:00`)) / 86_400_000) + 1));
  const pacePerDay = Math.round(pacePaise / historyDays);

  const billsDue = unpaidBills(monthKey, today, input.billTemplates, input.billPayments);
  const billsPaise = billsDue.reduce((sum, bill) => sum + toPaise(bill.amount), 0);
  const daysAfterToday = daysLeft - 1;
  const projectedPaise = spentPaise + pacePerDay * daysAfterToday + billsPaise;

  const upToToday = transactions.filter((tx) => tx.date <= today);
  const balances = computeAccountBalances(accounts, upToToday);
  const balancePaise = accounts
    .filter((account) => !account.isArchived && SPENDABLE.has(account.type))
    .reduce((sum, account) => sum + (balances.get(account.id) ?? 0), 0);
  const endPaise = balancePaise - pacePerDay * daysAfterToday - billsPaise;

  const budget = input.budget && input.budget > 0 ? input.budget : null;
  const room = budget !== null
    ? toPaise(budget) - spentPaise - billsPaise
    : balancePaise - billsPaise;
  const safePaise = Math.max(0, Math.floor(room / Math.max(1, daysLeft)));
  const status: MonthForecast['status'] = room < 0 || (budget === null && endPaise < 0)
    ? 'over'
    : pacePerDay > safePaise ? 'tight' : 'comfortable';

  return {
    monthKey,
    daysInMonth,
    daysLeft,
    spentSoFar: fromPaise(spentPaise),
    incomeSoFar: fromPaise(incomePaise),
    dailyPace: fromPaise(pacePerDay),
    billsDue,
    billsDueTotal: fromPaise(billsPaise),
    projectedSpend: fromPaise(projectedPaise),
    balanceNow: fromPaise(balancePaise),
    projectedEndBalance: fromPaise(endPaise),
    budget,
    safePerDay: fromPaise(safePaise),
    basis: budget !== null ? 'budget' : 'balance',
    status,
  };
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export interface Subscription {
  /** Note or category it was recognised by. */
  name: string;
  category: string;
  amount: number;
  /** Months it was seen in (newest first). */
  months: string[];
  lastDate: string;
  /** Rough yearly cost. */
  yearly: number;
}

/**
 * Expenses that repeat with the same amount and note (or category, without a
 * note) in at least three of the last six months: likely subscriptions or
 * standing payments. Bill payments are left out (they are already bills).
 */
export function findSubscriptions(transactions: FinanceTransaction[], billPayments: BillPayment[], today: string): Subscription[] {
  const billTxIds = new Set(billPayments.map((payment) => payment.transactionId).filter(Boolean) as string[]);
  const from = shiftDate(today, -183);
  const groups = new Map<string, { name: string; category: string; amount: number; months: Set<string>; lastDate: string }>();
  for (const tx of transactions) {
    if (tx.type !== 'expense' || tx.date < from || tx.date > today || billTxIds.has(tx.id) || tx.linkedTransferId) continue;
    const name = tx.note?.trim() || tx.category;
    const key = `${name.toLowerCase()}|${toPaise(tx.amount)}`;
    const group = groups.get(key) ?? { name, category: tx.category, amount: tx.amount, months: new Set<string>(), lastDate: tx.date };
    group.months.add(monthKeyOf(tx.date));
    if (tx.date > group.lastDate) group.lastDate = tx.date;
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.months.size >= 3)
    // One payment a month: more than that is a habit (tea), not a subscription.
    .filter((group) => transactions.filter((tx) => tx.type === 'expense' && tx.date >= from && (tx.note?.trim() || tx.category) === group.name && toPaise(tx.amount) === toPaise(group.amount)).length <= group.months.size + 1)
    .map((group) => ({
      name: group.name,
      category: group.category,
      amount: group.amount,
      months: [...group.months].sort().reverse(),
      lastDate: group.lastDate,
      yearly: fromPaise(toPaise(group.amount) * 12),
    }))
    .sort((a, b) => b.yearly - a.yearly);
}
