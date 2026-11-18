/**
 * Debts and loans: EMI and amortisation for loans, what is still outstanding,
 * the next due payment, and a payoff plan (smallest first or highest interest
 * first) with an optional extra amount each month. Pure; rupees in and out.
 */
import type { Debt } from '../types';
import { fromPaise, toPaise } from './money';

export interface EmiRow {
  number: number;
  dueDate: string;
  emi: number;
  interest: number;
  principal: number;
  /** Principal left after this EMI. */
  balance: number;
}

/** Monthly EMI for `principal` at `annualRate` % over `months`. */
export function emiAmount(principal: number, annualRate: number, months: number): number {
  if (!(principal > 0) || !(months > 0)) return 0;
  const rate = annualRate / 12 / 100;
  if (rate <= 0) return fromPaise(Math.ceil(toPaise(principal) / months));
  const factor = (1 + rate) ** months;
  return fromPaise(Math.round(toPaise(principal) * rate * factor / (factor - 1)));
}

/** The date `offset` months after `date`, keeping the day (clamped to the month's last day). */
export function addMonths(date: string, offset: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(year, month - 1 + offset, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

/** Full repayment schedule of a loan. The last EMI absorbs rounding. */
export function emiSchedule(principal: number, annualRate: number, months: number, firstEmiDate: string): EmiRow[] {
  const emi = toPaise(emiAmount(principal, annualRate, months));
  const rate = annualRate / 12 / 100;
  let balance = toPaise(principal);
  const rows: EmiRow[] = [];
  for (let number = 1; number <= months && balance > 0; number++) {
    const interest = Math.round(balance * rate);
    let principalPart = emi - interest;
    if (number === months || principalPart > balance) principalPart = balance;
    balance -= principalPart;
    rows.push({
      number,
      dueDate: addMonths(firstEmiDate, number - 1),
      emi: fromPaise(principalPart + interest),
      interest: fromPaise(interest),
      principal: fromPaise(principalPart),
      balance: fromPaise(balance),
    });
  }
  return rows;
}

function paidBy(debt: Debt, date: string): number {
  return (debt.payments ?? []).filter((payment) => payment.date <= date).reduce((sum, payment) => sum + toPaise(payment.amount), 0);
}

/**
 * Still unpaid on `date`. A loan assumes the EMIs due by then were paid and
 * subtracts prepayments; any other debt subtracts its part payments.
 */
export function debtOutstanding(debt: Debt, date: string): number {
  if (debt.paid) return 0;
  if (debt.loan) {
    const rows = emiSchedule(debt.amount, debt.loan.annualRate, debt.loan.tenureMonths, debt.loan.firstEmiDate);
    const due = rows.filter((row) => row.dueDate <= date);
    const scheduled = due.length ? toPaise(due[due.length - 1].balance) : toPaise(debt.amount);
    return fromPaise(Math.max(0, scheduled - paidBy(debt, date)));
  }
  return fromPaise(Math.max(0, toPaise(debt.amount) - paidBy(debt, date)));
}

export interface NextPayment {
  date: string;
  amount: number;
  /** EMI number for loans. */
  number?: number;
  overdue: boolean;
}

export function nextPayment(debt: Debt, today: string): NextPayment | null {
  if (debt.paid) return null;
  if (debt.loan) {
    const row = emiSchedule(debt.amount, debt.loan.annualRate, debt.loan.tenureMonths, debt.loan.firstEmiDate)
      .find((item) => item.dueDate >= today);
    return row ? { date: row.dueDate, amount: row.emi, number: row.number, overdue: false } : null;
  }
  if (!debt.dueDate) return null;
  const left = debtOutstanding(debt, today);
  return left > 0 ? { date: debt.dueDate, amount: left, overdue: debt.dueDate < today } : null;
}

export interface LoanSummary {
  emi: number;
  totalInterest: number;
  totalPaid: number;
  emisPaid: number;
  emisLeft: number;
  endDate: string;
}

export function loanSummary(debt: Debt, today: string): LoanSummary | null {
  if (!debt.loan) return null;
  const rows = emiSchedule(debt.amount, debt.loan.annualRate, debt.loan.tenureMonths, debt.loan.firstEmiDate);
  const paid = rows.filter((row) => row.dueDate < today).length;
  return {
    emi: emiAmount(debt.amount, debt.loan.annualRate, debt.loan.tenureMonths),
    totalInterest: fromPaise(rows.reduce((sum, row) => sum + toPaise(row.interest), 0)),
    totalPaid: fromPaise(rows.reduce((sum, row) => sum + toPaise(row.emi), 0)),
    emisPaid: paid,
    emisLeft: rows.length - paid,
    endDate: rows.length ? rows[rows.length - 1].dueDate : debt.loan.firstEmiDate,
  };
}

// ---------------------------------------------------------------------------
// Payoff planner
// ---------------------------------------------------------------------------

export type PayoffStrategy = 'avalanche' | 'snowball';

export interface PayoffResult {
  /** Months until everything you owe is paid (capped at 600). */
  months: number;
  debtFreeDate: string;
  totalInterest: number;
  /** In the order they get cleared. */
  order: { id: string; name: string; month: number }[];
}

interface Balance {
  id: string;
  name: string;
  paise: number;
  rate: number;
  /** Minimum each month (the EMI for a loan, 0 for an informal debt). */
  minimum: number;
}

/**
 * Simulates paying off what you owe, month by month from `today`: every debt
 * gets its minimum (loans their EMI), and `extra` plus any freed-up EMIs go to
 * one target: the highest rate (avalanche) or the smallest balance (snowball).
 */
export function payoffPlan(debts: Debt[], today: string, extra: number, strategy: PayoffStrategy): PayoffResult {
  const balances: Balance[] = debts
    .filter((debt) => debt.direction === 'owed' && !debt.paid)
    .map((debt) => ({
      id: debt.id,
      name: debt.personName,
      paise: toPaise(debtOutstanding(debt, today)),
      rate: (debt.loan?.annualRate ?? 0) / 12 / 100,
      minimum: debt.loan ? toPaise(emiAmount(debt.amount, debt.loan.annualRate, debt.loan.tenureMonths)) : 0,
    }))
    .filter((balance) => balance.paise > 0);
  const extraPaise = Math.max(0, toPaise(extra));
  const order: PayoffResult['order'] = [];
  let interestPaise = 0;
  let month = 0;
  const budget = extraPaise + balances.reduce((sum, balance) => sum + balance.minimum, 0);
  if (budget === 0) {
    return { months: 0, debtFreeDate: today, totalInterest: 0, order: balances.map((balance) => ({ id: balance.id, name: balance.name, month: 0 })) };
  }
  while (balances.some((balance) => balance.paise > 0) && month < 600) {
    month++;
    for (const balance of balances) {
      if (balance.paise <= 0) continue;
      const interest = Math.round(balance.paise * balance.rate);
      balance.paise += interest;
      interestPaise += interest;
    }
    // With an extra amount, EMIs freed by a cleared debt roll into the next one
    // (the snowball). Without one, every debt simply follows its own schedule.
    let available = extraPaise > 0
      ? budget
      : balances.reduce((sum, balance) => sum + (balance.paise > 0 ? balance.minimum : 0), 0);
    for (const balance of balances) {
      if (balance.paise <= 0) continue;
      let pay = Math.min(balance.minimum, balance.paise, available);
      // EMIs are rounded to the paisa; the last one absorbs the leftover dust (as in emiSchedule).
      if (balance.paise - pay > 0 && balance.paise - pay < 100) pay = balance.paise;
      balance.paise -= pay;
      available -= pay;
    }
    const open = () => balances.filter((balance) => balance.paise > 0).sort((a, b) =>
      strategy === 'avalanche' ? b.rate - a.rate || a.paise - b.paise : a.paise - b.paise || b.rate - a.rate);
    let targets = open();
    while (available > 0 && targets.length) {
      const target = targets[0];
      const pay = Math.min(available, target.paise);
      target.paise -= pay;
      available -= pay;
      targets = open();
    }
    for (const balance of balances) {
      if (balance.paise <= 0 && !order.some((item) => item.id === balance.id)) {
        order.push({ id: balance.id, name: balance.name, month });
      }
    }
  }
  return { months: month, debtFreeDate: addMonths(today, month), totalInterest: fromPaise(interestPaise), order };
}
