/**
 * Budgets carry over: a month without its own budget uses the latest earlier
 * one, so budgets do not go blank on the 1st. A limit of 0 is "no budget" and
 * stops the carry from that month on (that is how a budget is removed). Pure.
 *
 * Stop rows (`carryStop: true`) are written once per device for budgets that
 * had lapsed before carry-over existed (see `staleCarryStops`). They have their
 * own ids, and a real row in the same month always wins over a stop row, so a
 * budget another device set that month is never wiped by the stop.
 */
import type { CategoryBudget, MonthlyBudget } from '../types';
import { shiftMonthKey } from './ledger';

type Row = { month: string; limit: number; carryStop?: boolean };

/** True when `row` should replace `best` as the row in force (later month; a real row beats a stop row). */
function wins(row: Row, best: Row | undefined): boolean {
  if (!best) return true;
  if (row.month !== best.month) return row.month > best.month;
  return Boolean(best.carryStop) && !row.carryStop;
}

/** The overall budget in force for `month`, or null when there is none. */
export function effectiveMonthlyBudget<T extends Row>(budgets: T[], month: string): T | null {
  let best: T | undefined;
  for (const budget of budgets) {
    if (budget.month > month) continue;
    if (wins(budget, best)) best = budget;
  }
  return best && best.limit > 0 ? best : null;
}

/** The overall limit in force for `month`, 0 when none. */
export function effectiveMonthlyLimit(budgets: Row[], month: string): number {
  return effectiveMonthlyBudget(budgets, month)?.limit ?? 0;
}

/** Each category's budget in force for `month` (latest month at or before it), without removed ones. */
export function effectiveCategoryBudgets(budgets: CategoryBudget[], month: string): CategoryBudget[] {
  const latest = new Map<string, CategoryBudget>();
  for (const budget of budgets) {
    if (budget.month > month) continue;
    if (wins(budget, latest.get(budget.category))) latest.set(budget.category, budget);
  }
  return [...latest.values()]
    .filter((budget) => budget.limit > 0)
    .sort((a, b) => a.category.localeCompare(b.category));
}

/** One category's limit in force for `month`, 0 when none. */
export function effectiveCategoryLimit(budgets: CategoryBudget[], category: string, month: string): number {
  return effectiveCategoryBudgets(budgets, month).find((budget) => budget.category === category)?.limit ?? 0;
}

/** True when the budget shown for `month` was set in an earlier month. */
export function isCarriedOver(budget: { month: string } | null | undefined, month: string): boolean {
  return Boolean(budget && budget.month !== month);
}

/**
 * Editing a past month must not change the months after it. When `month` is
 * before `currentMonth` and the next month has no row of its own, this is the
 * month and limit to pin there (the limit in force before the edit), or null.
 */
export function pinAfterPastEdit(
  rows: Row[],
  month: string,
  currentMonth: string,
  limitBefore: (month: string) => number
): { month: string; limit: number } | null {
  if (month >= currentMonth) return null;
  const next = shiftMonthKey(month, 1);
  if (rows.some((row) => row.month === next && !row.carryStop)) return null;
  return { month: next, limit: limitBefore(next) };
}

/**
 * Before carry-over, a budget went blank on the 1st. Budgets whose last row is
 * older than last month had lapsed, so they get a stop row in the month after
 * their last row (overall budget and each category). Last month's budgets carry.
 */
export function staleCarryStops(
  budgets: MonthlyBudget[],
  categoryBudgets: CategoryBudget[],
  currentMonth: string,
  now: string
): { budgets: MonthlyBudget[]; categoryBudgets: CategoryBudget[] } {
  const lastMonth = shiftMonthKey(currentMonth, -1);
  const out = { budgets: [] as MonthlyBudget[], categoryBudgets: [] as CategoryBudget[] };

  const latestOverall = effectiveMonthlyBudget(budgets, currentMonth);
  if (latestOverall && latestOverall.month < lastMonth) {
    const month = shiftMonthKey(latestOverall.month, 1);
    out.budgets.push({ id: `budget-stop-${month}`, month, limit: 0, carryStop: true, updatedAt: now });
  }
  for (const budget of effectiveCategoryBudgets(categoryBudgets, currentMonth)) {
    if (budget.month >= lastMonth) continue;
    const month = shiftMonthKey(budget.month, 1);
    out.categoryBudgets.push({
      id: `cbudget-stop-${month}-${budget.category}`,
      month,
      category: budget.category,
      limit: 0,
      carryStop: true,
      updatedAt: now,
    });
  }
  return out;
}

/**
 * Sets the overall budget for `month` (0 removes it from that month on). A past
 * month's edit pins the next month to the limit it had, so later months keep theirs.
 */
export function setMonthlyBudget(
  budgets: MonthlyBudget[],
  month: string,
  limit: number,
  currentMonth: string,
  now: string
): MonthlyBudget[] {
  const pin = pinAfterPastEdit(budgets, month, currentMonth, (m) => effectiveMonthlyLimit(budgets, m));
  let next = upsertMonthly(budgets, month, limit, now);
  if (pin) next = upsertMonthly(next, pin.month, pin.limit, now);
  return next;
}

function upsertMonthly(budgets: MonthlyBudget[], month: string, limit: number, now: string): MonthlyBudget[] {
  // Stop rows are left alone: a real row in the same month wins over them.
  const existing = budgets.find((b) => b.month === month && !b.carryStop);
  if (existing) return budgets.map((b) => (b === existing ? { ...b, limit, updatedAt: now } : b));
  return [...budgets, { id: `budget-${month}`, month, limit, updatedAt: now }];
}

/** Sets one category's budget for `month` (0 removes it), pinning the next month after a past edit. */
export function setCategoryBudget(
  budgets: CategoryBudget[],
  month: string,
  category: string,
  limit: number,
  currentMonth: string,
  now: string
): CategoryBudget[] {
  const own = budgets.filter((b) => b.category === category);
  const pin = pinAfterPastEdit(own, month, currentMonth, (m) => effectiveCategoryLimit(budgets, category, m));
  let next = upsertCategory(budgets, month, category, limit, now);
  if (pin) next = upsertCategory(next, pin.month, category, pin.limit, now);
  return next;
}

function upsertCategory(budgets: CategoryBudget[], month: string, category: string, limit: number, now: string): CategoryBudget[] {
  const existing = budgets.find((b) => b.month === month && b.category === category && !b.carryStop);
  if (existing) return budgets.map((b) => (b === existing ? { ...b, limit, updatedAt: now } : b));
  return [...budgets, { id: `cbudget-${month}-${category}`, month, category, limit, updatedAt: now }];
}
