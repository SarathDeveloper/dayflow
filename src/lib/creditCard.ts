/**
 * Credit card accounts. A card's balance is what the ledger already computes:
 * spending on the card takes it below zero (what you owe), and paying the card
 * bill is a transfer from a bank into the card. So the amount owed is
 * `-balance`. Each month the card makes a statement on `statementDay`, and that
 * statement is due on the next `dueDay` after it. Pure; dates are local.
 */
import type { Account, FinanceTransaction } from '../types';
import { computeAccountBalances } from './ledger';
import { fromPaise, toPaise } from './money';

export function isCreditCard(account: Pick<Account, 'type'> | undefined): boolean {
  return account?.type === 'credit_card';
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `day` in month `y-m` (1-based), clamped to that month's last day. */
function clampedDate(y: number, m: number, day: number): string {
  const date = new Date(y, m - 1, 1);
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(Math.min(Math.max(1, day), last))}`;
}

/** The latest statement date on or before `today`. */
export function lastStatementDate(statementDay: number, today: string): string {
  const [y, m] = today.split('-').map(Number);
  const thisMonth = clampedDate(y, m, statementDay);
  return thisMonth <= today ? thisMonth : clampedDate(y, m - 1, statementDay);
}

/** The due date of the statement made on `statementDate`: the first `dueDay` after it. */
export function dueDateFor(statementDate: string, dueDay: number): string {
  const [y, m] = statementDate.split('-').map(Number);
  const sameMonth = clampedDate(y, m, dueDay);
  return sameMonth > statementDate ? sameMonth : clampedDate(y, m + 1, dueDay);
}

export interface CardStatus {
  /** What you owe on the card now (0 or more), in rupees. */
  owed: number;
  /** Credit left under the limit, or null when no limit is set. */
  available: number | null;
  /** Last statement: date, amount it asked for, what is still due on it, and its due date. */
  statement: { date: string; amount: number; due: number; dueDate: string } | null;
}

/** Money paid into the card (transfers in, refunds as income) after `date`, in paise. */
function paidInAfterPaise(card: Account, transactions: FinanceTransaction[], date: string, today: string): number {
  let paise = 0;
  for (const tx of transactions) {
    if (tx.date <= date || tx.date > today) continue;
    if (tx.type === 'transfer' && tx.destinationAccountId === card.id && tx.accountId !== card.id) paise += toPaise(tx.amount);
    if (tx.type === 'income' && tx.accountId === card.id) paise += toPaise(tx.amount);
  }
  return paise;
}

export function cardStatus(card: Account, transactions: FinanceTransaction[], today: string): CardStatus {
  const upToToday = transactions.filter((tx) => tx.date <= today);
  const balancePaise = computeAccountBalances([card], upToToday).get(card.id) ?? 0;
  const owedPaise = Math.max(0, -balancePaise);
  const available = card.creditLimit && card.creditLimit > 0 ? fromPaise(toPaise(card.creditLimit) + balancePaise) : null;

  let statement: CardStatus['statement'] = null;
  if (card.statementDay && card.dueDay) {
    const date = lastStatementDate(card.statementDay, today);
    const atStatement = computeAccountBalances([card], transactions.filter((tx) => tx.date <= date)).get(card.id) ?? 0;
    const amountPaise = Math.max(0, -atStatement);
    const duePaise = Math.max(0, amountPaise - paidInAfterPaise(card, transactions, date, today));
    statement = { date, amount: fromPaise(amountPaise), due: fromPaise(duePaise), dueDate: dueDateFor(date, card.dueDay) };
  }
  return { owed: fromPaise(owedPaise), available, statement };
}

/** Cards with a statement still to pay and a due date today or later (for reminders). */
export function cardDues(
  accounts: Account[],
  transactions: FinanceTransaction[],
  today: string
): { account: Account; dueDate: string; amount: number }[] {
  const out: { account: Account; dueDate: string; amount: number }[] = [];
  for (const account of accounts) {
    if (account.isArchived || !isCreditCard(account)) continue;
    const { statement } = cardStatus(account, transactions, today);
    if (!statement || statement.due <= 0 || statement.dueDate < today) continue;
    out.push({ account, dueDate: statement.dueDate, amount: statement.due });
  }
  return out;
}
