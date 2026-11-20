/**
 * Named savings goals ("Emergency fund ₹1,00,000 by March"). A goal linked to
 * an account (usually a savings-only bank) counts that account's balance as
 * saved; an unlinked goal counts the amount typed in by hand. Pure; local dates.
 */
import type { Account, FinanceTransaction, MoneyGoal } from '../types';
import { computeAccountBalances } from './ledger';
import { fromPaise, toPaise } from './money';

export interface GoalProgress {
  saved: number;
  target: number;
  /** 0..100, whole percent. */
  percent: number;
  left: number;
  /** Rupees a month still needed to reach the target by its date, or null (no date, done, or past). */
  perMonth: number | null;
  /** Whole months from today to the target date (at least 1), or null without a date. */
  monthsLeft: number | null;
  done: boolean;
  /** Target date passed without reaching the target. */
  late: boolean;
}

/** Months from `today` to `date`, counting a part month as one (at least 1). */
export function monthsUntil(today: string, date: string): number {
  const [ty, tm, td] = today.split('-').map(Number);
  const [dy, dm, dd] = date.split('-').map(Number);
  let months = (dy - ty) * 12 + (dm - tm);
  if (dd > td) months += 1;
  return Math.max(1, months);
}

export function goalProgress(
  goal: MoneyGoal,
  accounts: Account[],
  transactions: FinanceTransaction[],
  today: string
): GoalProgress {
  const linked = goal.accountId ? accounts.find((a) => a.id === goal.accountId) : undefined;
  const savedPaise = linked
    ? Math.max(0, computeAccountBalances([linked], transactions.filter((tx) => tx.date <= today)).get(linked.id) ?? 0)
    : Math.max(0, toPaise(goal.savedAmount ?? 0));
  const targetPaise = Math.max(0, toPaise(goal.target));
  const leftPaise = Math.max(0, targetPaise - savedPaise);
  const done = targetPaise > 0 && leftPaise === 0;
  const late = Boolean(goal.targetDate && goal.targetDate < today && !done);
  const monthsLeft = goal.targetDate && goal.targetDate >= today ? monthsUntil(today, goal.targetDate) : null;
  return {
    saved: fromPaise(savedPaise),
    target: fromPaise(targetPaise),
    percent: targetPaise > 0 ? Math.min(100, Math.floor((savedPaise / targetPaise) * 100)) : 0,
    left: fromPaise(leftPaise),
    perMonth: monthsLeft && !done ? fromPaise(Math.ceil(leftPaise / monthsLeft)) : null,
    monthsLeft,
    done,
    late,
  };
}

/** Active goals first (soonest date first, undated last), then finished ones. */
export function sortGoals(goals: MoneyGoal[]): MoneyGoal[] {
  return [...goals].sort((a, b) => {
    if (Boolean(a.archived) !== Boolean(b.archived)) return a.archived ? 1 : -1;
    const ad = a.targetDate ?? '9999-12-31';
    const bd = b.targetDate ?? '9999-12-31';
    return ad.localeCompare(bd) || a.name.localeCompare(b.name);
  });
}
