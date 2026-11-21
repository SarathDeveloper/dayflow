/**
 * Bucket List: places, experiences and things to buy someday. Pure rules for
 * checking a draft, sorting, totals, ticking items off and the goals an item
 * can start. Dates are local YYYY-MM-DD; money is added in paise.
 */
import type { BucketCategory, BucketItem, BucketTarget, Goal, MoneyGoal } from '../types';
import { fromPaise, toPaise } from './money';

export const BUCKET_CATEGORIES: { id: BucketCategory; label: string }[] = [
  { id: 'travel', label: 'Travel' },
  { id: 'experience', label: 'Experience' },
  { id: 'buy', label: 'Buy' },
  { id: 'learn', label: 'Learn' },
  { id: 'food', label: 'Food' },
  { id: 'people', label: 'People' },
  { id: 'other', label: 'Other' },
];

/** Days before the target date that a reminder fires. */
export const BUCKET_REMINDER_DAYS = [30, 7];

/** Prefix of the notification route for one item (`bucket:<id>`). */
export const BUCKET_ROUTE_PREFIX = 'bucket:';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TITLE = 120;

export function isBucketCategory(value: unknown): value is BucketCategory {
  return BUCKET_CATEGORIES.some((c) => c.id === value);
}

export function bucketCategoryLabel(category: BucketCategory): string {
  return BUCKET_CATEGORIES.find((c) => c.id === category)?.label ?? 'Other';
}

export function isValidLocalDate(date: string): boolean {
  if (!DATE_PATTERN.test(date)) return false;
  const [y, m, d] = date.split('-').map(Number);
  const parsed = new Date(y, m - 1, d);
  return parsed.getFullYear() === y && parsed.getMonth() === m - 1 && parsed.getDate() === d;
}

/** The day an item is due by: Dec 31 for a year, the date itself for a date. */
export function bucketTargetDate(target: BucketTarget | undefined): string | null {
  if (!target) return null;
  if (target.kind === 'year') return Number.isInteger(target.year) ? `${target.year}-12-31` : null;
  return isValidLocalDate(target.date) ? target.date : null;
}

/**
 * Day reminders count back from: the date itself, or Dec 1 for a year
 * ("by 2028" is nudged during December's run-up, not on New Year's Eve).
 */
export function bucketReminderAnchor(target: BucketTarget | undefined): string | null {
  if (!target) return null;
  if (target.kind === 'year') return Number.isInteger(target.year) ? `${target.year}-12-01` : null;
  return bucketTargetDate(target);
}

export interface BucketDraft {
  title: string;
  category: string;
  target?: BucketTarget;
  cost?: number;
}

/** An error message, or null when the draft can be saved. `isNew` refuses targets already past. */
export function validateBucketDraft(draft: BucketDraft, today: string, isNew: boolean): string | null {
  const title = draft.title.trim();
  if (!title) return 'Give it a name.';
  if (title.length > MAX_TITLE) return `Keep the name under ${MAX_TITLE} characters.`;
  if (!isBucketCategory(draft.category)) return 'Choose a category.';
  if (draft.cost !== undefined && (!Number.isFinite(draft.cost) || draft.cost < 0)) return 'Cost must be zero or more.';
  if (draft.target) {
    const due = bucketTargetDate(draft.target);
    if (!due) return draft.target.kind === 'year' ? 'Choose a valid year.' : 'Choose a valid date.';
    if (isNew && due < today) return 'Pick a date that is still ahead.';
  }
  return null;
}

/** Open items: soonest target first, undated last, then newest first. */
export function sortOpenItems(items: BucketItem[]): BucketItem[] {
  return items
    .filter((i) => !i.doneOn)
    .slice()
    .sort((a, b) => {
      const da = bucketTargetDate(a.target);
      const db = bucketTargetDate(b.target);
      if (da && db && da !== db) return da < db ? -1 : 1;
      if (da && !db) return -1;
      if (!da && db) return 1;
      return b.createdAt.localeCompare(a.createdAt);
    });
}

/** Done items, most recently done first. */
export function sortDoneItems(items: BucketItem[]): BucketItem[] {
  return items
    .filter((i) => Boolean(i.doneOn))
    .slice()
    .sort((a, b) => (b.doneOn ?? '').localeCompare(a.doneOn ?? '') || b.updatedAt.localeCompare(a.updatedAt));
}

/** Groups in BUCKET_CATEGORIES order, keeping the order of `items` inside each group. Empty groups are left out. */
export function groupByCategory(items: BucketItem[]): { category: BucketCategory; items: BucketItem[] }[] {
  return BUCKET_CATEGORIES.map(({ id }) => ({
    category: id,
    items: items.filter((i) => (isBucketCategory(i.category) ? i.category : 'other') === id),
  })).filter((g) => g.items.length > 0);
}

export interface BucketSummary {
  total: number;
  done: number;
  open: number;
  /** Rupees: sum of the cost of open items. */
  openCost: number;
}

export function bucketSummary(items: BucketItem[]): BucketSummary {
  let done = 0;
  let costPaise = 0;
  for (const item of items) {
    if (item.doneOn) done += 1;
    else if (item.cost && item.cost > 0) costPaise += toPaise(item.cost);
  }
  return { total: items.length, done, open: items.length - done, openCost: fromPaise(costPaise) };
}

/** Whole days from `today` to `date` (negative once past). */
export function daysUntil(today: string, date: string): number {
  const [ty, tm, td] = today.split('-').map(Number);
  const [dy, dm, dd] = date.split('-').map(Number);
  return Math.round((Date.UTC(dy, dm - 1, dd) - Date.UTC(ty, tm - 1, td)) / 86_400_000);
}

/** Short line for a card: "by 2028", "in 12 days", "today", "3 days late". */
export function bucketTargetLabel(target: BucketTarget | undefined, today: string): string | null {
  if (!target) return null;
  if (target.kind === 'year') {
    const thisYear = Number(today.slice(0, 4));
    if (target.year < thisYear) return `was for ${target.year}`;
    return target.year === thisYear ? 'this year' : `by ${target.year}`;
  }
  const due = bucketTargetDate(target);
  if (!due) return null;
  const days = daysUntil(today, due);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days > 1 && days <= 60) return `in ${days} days`;
  if (days < 0) return `${-days} day${days === -1 ? '' : 's'} late`;
  const [y, m, d] = due.split('-').map(Number);
  return `by ${new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

/** Ticks an item off. */
export function markBucketDone(
  item: BucketItem,
  done: { doneOn: string; memory?: string; photo?: BucketItem['photo'] },
  now: string
): BucketItem {
  return {
    ...item,
    doneOn: done.doneOn,
    memory: done.memory?.trim() || undefined,
    photo: done.photo,
    updatedAt: now,
  };
}

/** Puts a done item back on the open list. The memory and photo are kept for when it is done again. */
export function reopenBucketItem(item: BucketItem, now: string): BucketItem {
  return { ...item, doneOn: undefined, updatedAt: now };
}

/** The savings goal "Start saving" creates: the item's name, cost and due day. */
export function moneyGoalDraftFor(item: BucketItem): Partial<MoneyGoal> {
  return {
    name: item.title.trim(),
    target: item.cost && item.cost > 0 ? item.cost : 0,
    targetDate: bucketTargetDate(item.target) ?? undefined,
  };
}

/** The Goal "Make it a goal" creates. Without a target it is due a year from today. */
export function goalDraftFor(item: BucketItem, today: string): Partial<Goal> {
  const due = bucketTargetDate(item.target);
  const [y, m, d] = today.split('-');
  const inAYear = `${Number(y) + 1}-${m}-${m === '02' && d === '29' ? '28' : d}`;
  return {
    title: item.title.trim(),
    note: item.note?.trim() || undefined,
    startDate: today,
    targetDate: due && due >= today ? due : inAYear,
    status: 'active',
  };
}

/** Clears links to goals that no longer exist; touched items get a new `updatedAt`. */
export function unlinkMissingGoals(
  items: BucketItem[],
  moneyGoalIds: ReadonlySet<string>,
  goalIds: ReadonlySet<string>,
  now: string
): BucketItem[] {
  let changed = false;
  const next = items.map((item) => {
    const dropMoney = item.moneyGoalId !== undefined && !moneyGoalIds.has(item.moneyGoalId);
    const dropGoal = item.goalId !== undefined && !goalIds.has(item.goalId);
    if (!dropMoney && !dropGoal) return item;
    changed = true;
    return {
      ...item,
      moneyGoalId: dropMoney ? undefined : item.moneyGoalId,
      goalId: dropGoal ? undefined : item.goalId,
      updatedAt: now,
    };
  });
  return changed ? next : items;
}

/** Route delivered by an item's reminder. */
export function bucketRoute(itemId: string): string {
  return `${BUCKET_ROUTE_PREFIX}${itemId}`;
}

export function bucketIdFromRoute(route: string): string | null {
  if (!route.startsWith(BUCKET_ROUTE_PREFIX)) return null;
  const id = route.slice(BUCKET_ROUTE_PREFIX.length);
  return id.length > 0 ? id : null;
}

/** Items that should have phone reminders: open, switched on and with a valid target. */
export function bucketItemsToRemind(items: BucketItem[]): BucketItem[] {
  return items.filter((i) => !i.doneOn && i.remind && bucketReminderAnchor(i.target) !== null);
}
