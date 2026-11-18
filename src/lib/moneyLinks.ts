/**
 * Links between the ledger and debts / bills. Pure.
 *
 * - Borrowing, lending, repaying and getting money back move real money in an
 *   account, so they are ledger entries (with `debtId` + `debtRole`). They are
 *   not income or spending: totals, budgets and reports leave them out. A loan
 *   EMI (role `emi`) does count as spending, like any bill.
 * - A bill payment and its ledger entry point at each other
 *   (`BillPayment.transactionId`, `FinanceTransaction.billPaymentId`).
 * - When a linked ledger entry is edited or deleted, the debt / bill follows.
 */
import type {
  BillPayment, BillTemplate, Debt, DebtFlowRole, DebtPayment, FinanceTransaction, PaymentMethod,
} from '../types';
import type { EntryDraft } from './ledger';
import { addMonths, debtOutstanding, emiAmount } from './debtPlanner';
import { fromPaise, toPaise } from './money';

// ---------------------------------------------------------------------------
// What counts as income and spending
// ---------------------------------------------------------------------------

const NOT_INCOME_OR_SPENDING = new Set<DebtFlowRole>(['borrowed', 'lent', 'repaid', 'received']);

/** Money moved for a debt's principal: real for balances, not income or spending. */
export function isDebtPrincipal(tx: Pick<FinanceTransaction, 'debtRole'>): boolean {
  return Boolean(tx.debtRole && NOT_INCOME_OR_SPENDING.has(tx.debtRole));
}

export function countsAsIncome(tx: Pick<FinanceTransaction, 'type' | 'debtRole'>): boolean {
  return tx.type === 'income' && !isDebtPrincipal(tx);
}

export function countsAsSpending(tx: Pick<FinanceTransaction, 'type' | 'debtRole'>): boolean {
  return tx.type === 'expense' && !isDebtPrincipal(tx);
}

export const DEBT_FLOW_CATEGORY: Record<DebtFlowRole, string> = {
  borrowed: 'Borrowed',
  lent: 'Lent',
  repaid: 'Debt repayment',
  received: 'Debt received',
  emi: 'Loan EMI',
};

export const DEBT_FLOW_LABEL: Record<DebtFlowRole, string> = {
  borrowed: 'Borrowed',
  lent: 'Lent',
  repaid: 'Repaid',
  received: 'Got back',
  emi: 'EMI',
};

// ---------------------------------------------------------------------------
// Debt ledger entries
// ---------------------------------------------------------------------------

interface DraftOptions {
  accountId: string;
  paymentMethod?: PaymentMethod;
  time?: string;
}

/** The ledger entry for taking a debt: money in when you borrow, out when you lend. */
export function debtOpeningDraft(debt: Pick<Debt, 'direction' | 'personName' | 'amount' | 'date'>, options: DraftOptions): EntryDraft & { debtRole: DebtFlowRole } {
  const borrowed = debt.direction === 'owed';
  const role: DebtFlowRole = borrowed ? 'borrowed' : 'lent';
  return {
    type: borrowed ? 'income' : 'expense',
    amount: debt.amount,
    accountId: options.accountId,
    category: DEBT_FLOW_CATEGORY[role],
    note: borrowed ? `Borrowed from ${debt.personName}` : `Lent to ${debt.personName}`,
    paymentMethod: options.paymentMethod,
    date: debt.date,
    time: options.time,
    debtRole: role,
  };
}

/** The ledger entry for a repayment: money out when you repay, in when you get it back. */
export function debtPaymentDraft(
  debt: Pick<Debt, 'direction' | 'personName'>,
  amount: number,
  date: string,
  options: DraftOptions,
): EntryDraft & { debtRole: DebtFlowRole } {
  const repaying = debt.direction === 'owed';
  const role: DebtFlowRole = repaying ? 'repaid' : 'received';
  return {
    type: repaying ? 'expense' : 'income',
    amount,
    accountId: options.accountId,
    category: DEBT_FLOW_CATEGORY[role],
    note: repaying ? `Repaid ${debt.personName}` : `Got back from ${debt.personName}`,
    paymentMethod: options.paymentMethod,
    date,
    time: options.time,
    debtRole: role,
  };
}

/** Adds a payment and marks the debt paid when nothing is left. */
export function addDebtPayment(debt: Debt, payment: DebtPayment, now: string): Debt {
  const next: Debt = { ...debt, payments: [...(debt.payments ?? []), payment], updatedAt: now };
  return !next.loan && debtOutstanding(next, payment.date) <= 0 ? { ...next, paid: true, paidAt: now } : next;
}

/** Unticking "paid": drops the settling payment (if the tick made one) and reopens the debt. */
export function reopenDebt(debt: Debt, now: string): { debt: Debt; removedTransactionIds: string[] } {
  const settling = (debt.payments ?? []).filter((payment) => payment.settles);
  return {
    debt: {
      ...debt,
      paid: false,
      paidAt: undefined,
      payments: (debt.payments ?? []).filter((payment) => !payment.settles),
      updatedAt: now,
    },
    removedTransactionIds: settling.map((payment) => payment.transactionId).filter((id): id is string => Boolean(id)),
  };
}

/** Every ledger entry that belongs to a debt (its opening entry, payments, EMIs). */
export function debtTransactionIds(debt: Debt, transactions: FinanceTransaction[]): string[] {
  const ids = new Set<string>();
  if (debt.transactionId) ids.add(debt.transactionId);
  for (const payment of debt.payments ?? []) if (payment.transactionId) ids.add(payment.transactionId);
  for (const tx of transactions) if (tx.debtId === debt.id) ids.add(tx.id);
  return [...ids].filter((id) => transactions.some((tx) => tx.id === id));
}

// ---------------------------------------------------------------------------
// Loan EMIs as bills
// ---------------------------------------------------------------------------

export function emiBillId(debtId: string): string {
  return `bill-emi-${debtId}`;
}

/** The monthly bill for a loan's EMI, or null when the debt is not an open loan you owe. */
export function emiBillTemplate(debt: Debt, existing: BillTemplate | undefined, now: string): BillTemplate | null {
  if (!debt.loan || debt.direction !== 'owed') return null;
  const first = debt.loan.firstEmiDate;
  const last = addMonths(first, debt.loan.tenureMonths - 1);
  return {
    id: emiBillId(debt.id),
    userId: debt.userId,
    name: `${debt.personName} EMI`,
    amount: emiAmount(debt.amount, debt.loan.annualRate, debt.loan.tenureMonths),
    category: DEBT_FLOW_CATEGORY.emi,
    dueDayOfMonth: Number(first.slice(8, 10)),
    accountId: debt.accountId ?? existing?.accountId,
    paymentMethod: existing?.paymentMethod,
    active: !debt.paid,
    note: existing?.note,
    debtId: debt.id,
    startMonth: first.slice(0, 7),
    endMonth: last.slice(0, 7),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

/** True when the generated EMI bill differs from what is stored (so it needs saving). */
export function emiBillChanged(next: BillTemplate, existing: BillTemplate | undefined): boolean {
  if (!existing) return true;
  const keys: (keyof BillTemplate)[] = ['name', 'amount', 'category', 'dueDayOfMonth', 'accountId', 'active', 'debtId', 'startMonth', 'endMonth'];
  return keys.some((key) => existing[key] !== next[key]);
}

// ---------------------------------------------------------------------------
// Bills paid from the ledger
// ---------------------------------------------------------------------------

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00`) - Date.parse(`${b}T00:00:00`)) / 86_400_000);
}

export interface BillMatch {
  payment: BillPayment;
  template: BillTemplate;
}

/**
 * An unpaid bill this expense probably paid: within 20 days before / 10 days
 * after the due date, and either the bill's name in the note, or the same
 * category with an amount within 15%. The closest amount wins.
 */
export function matchBillForExpense(
  tx: Pick<FinanceTransaction, 'type' | 'amount' | 'category' | 'note' | 'date' | 'billPaymentId' | 'debtRole'>,
  templates: BillTemplate[],
  payments: BillPayment[],
): BillMatch | null {
  if (tx.type !== 'expense' || tx.billPaymentId || tx.debtRole) return null;
  const note = (tx.note ?? '').toLowerCase();
  let best: (BillMatch & { gap: number }) | null = null;
  for (const payment of payments) {
    if (payment.paid) continue;
    const template = templates.find((item) => item.id === payment.billId && item.active);
    if (!template) continue;
    const offset = daysBetween(tx.date, payment.dueDate);
    if (offset < -20 || offset > 10) continue;
    const named = template.name.trim().length >= 3 && note.includes(template.name.trim().toLowerCase());
    const gap = Math.abs(toPaise(tx.amount) - toPaise(payment.amount));
    const sameCategory = tx.category.toLowerCase() === template.category.toLowerCase();
    const closeAmount = gap <= toPaise(payment.amount) * 0.15;
    if (!named && !(sameCategory && closeAmount)) continue;
    if (!best || gap < best.gap) best = { payment, template, gap };
  }
  return best ? { payment: best.payment, template: best.template } : null;
}

/** Marks a bill payment paid by `tx` (and the entry as paying it). */
export function linkBillPayment(
  payment: BillPayment,
  tx: FinanceTransaction,
  now: string,
): { payment: BillPayment; transaction: FinanceTransaction } {
  return {
    payment: { ...payment, paid: true, paidAt: now, amount: tx.amount, transactionId: tx.id, updatedAt: now },
    transaction: { ...tx, billPaymentId: payment.id, updatedAt: now },
  };
}

// ---------------------------------------------------------------------------
// Keeping both sides in step after ledger edits and deletes
// ---------------------------------------------------------------------------

export interface LinkedChanges {
  billPayments: BillPayment[];
  debts: Debt[];
  /** True when anything changed (so the caller saves). */
  changed: boolean;
}

/**
 * After ledger entries were deleted: their bill payments become unpaid again,
 * and debt payments made through them are removed (reopening a settled debt).
 * A debt whose opening entry was deleted keeps its record but loses the link.
 */
export function unlinkDeletedTransactions(
  removedIds: string[],
  billPayments: BillPayment[],
  debts: Debt[],
  now: string,
): LinkedChanges {
  const removed = new Set(removedIds);
  let changed = false;
  const nextPayments = billPayments.map((payment) => {
    if (!payment.transactionId || !removed.has(payment.transactionId)) return payment;
    changed = true;
    return { ...payment, paid: false, paidAt: undefined, transactionId: undefined, updatedAt: now };
  });
  const nextDebts = debts.map((debt) => {
    const payments = debt.payments ?? [];
    const kept = payments.filter((payment) => !payment.transactionId || !removed.has(payment.transactionId));
    const openingGone = Boolean(debt.transactionId && removed.has(debt.transactionId));
    if (kept.length === payments.length && !openingGone) return debt;
    changed = true;
    const next: Debt = {
      ...debt,
      payments: kept.length ? kept : undefined,
      transactionId: openingGone ? undefined : debt.transactionId,
      updatedAt: now,
    };
    const removedSettle = payments.some((payment) => payment.settles && !kept.includes(payment));
    return next.paid && (removedSettle || debtOutstanding({ ...next, paid: false }, now.slice(0, 10)) > 0)
      ? { ...next, paid: false, paidAt: undefined }
      : next;
  });
  return { billPayments: nextPayments, debts: nextDebts, changed };
}

/**
 * Undo of a delete: the restored entries pay their bills again and count on
 * their debts again (the opposite of `unlinkDeletedTransactions`).
 */
export function relinkRestoredTransactions(
  restored: FinanceTransaction[],
  billPayments: BillPayment[],
  debts: Debt[],
  now: string,
): LinkedChanges {
  let changed = false;
  const nextPayments = billPayments.map((payment) => {
    const tx = restored.find((item) => item.billPaymentId === payment.id);
    if (!tx || payment.transactionId === tx.id) return payment;
    changed = true;
    return linkBillPayment(payment, tx, now).payment;
  });
  const nextDebts = debts.map((debt) => {
    const mine = restored.filter((tx) => tx.debtId === debt.id);
    if (!mine.length) return debt;
    let next = debt;
    for (const tx of mine) {
      if (tx.debtRole === 'borrowed' || tx.debtRole === 'lent') {
        if (next.transactionId !== tx.id) next = { ...next, transactionId: tx.id, accountId: tx.accountId, updatedAt: now };
      } else if ((tx.debtRole === 'repaid' || tx.debtRole === 'received') && !(next.payments ?? []).some((p) => p.transactionId === tx.id)) {
        next = addDebtPayment(next, { id: `dpay-${tx.id}`, date: tx.date, amount: tx.amount, transactionId: tx.id }, now);
      }
    }
    if (next !== debt) changed = true;
    return next;
  });
  return { billPayments: nextPayments, debts: nextDebts, changed };
}

/** After a linked ledger entry was edited: its bill payment / debt payment take the new amount and date. */
export function syncEditedTransaction(
  tx: FinanceTransaction,
  billPayments: BillPayment[],
  debts: Debt[],
  now: string,
): LinkedChanges {
  let changed = false;
  const nextPayments = billPayments.map((payment) => {
    if (payment.transactionId !== tx.id || toPaise(payment.amount) === toPaise(tx.amount)) return payment;
    changed = true;
    return { ...payment, amount: fromPaise(toPaise(tx.amount)), updatedAt: now };
  });
  const nextDebts = debts.map((debt) => {
    if (debt.transactionId === tx.id && (toPaise(debt.amount) !== toPaise(tx.amount) || debt.date !== tx.date || debt.accountId !== tx.accountId)) {
      changed = true;
      return { ...debt, amount: fromPaise(toPaise(tx.amount)), date: tx.date, accountId: tx.accountId, updatedAt: now };
    }
    const payments = debt.payments ?? [];
    const index = payments.findIndex((payment) => payment.transactionId === tx.id);
    if (index < 0) return debt;
    const payment = payments[index];
    if (toPaise(payment.amount) === toPaise(tx.amount) && payment.date === tx.date) return debt;
    changed = true;
    const updated = payments.map((item, at) => (at === index ? { ...item, amount: fromPaise(toPaise(tx.amount)), date: tx.date } : item));
    return { ...debt, payments: updated, updatedAt: now };
  });
  return { billPayments: nextPayments, debts: nextDebts, changed };
}
