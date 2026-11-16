/**
 * Vehicle and home maintenance: a synced collection of recurring, date-based
 * tasks with a service history.
 *
 * Pure rules only (validation, legacy migration, due dates, spend, export and
 * merge). App.tsx owns the state and storage; every edit here sets `updatedAt`
 * to the `now` it is given so cloud sync keeps the newest copy.
 *
 * Costs never create Money transactions. A service record either carries its
 * own `cost` (rupees paid outside Money) or links one EXISTING expense via
 * `transactionId`, whose amount is then the cost. A transaction is linked to at
 * most one record, so spend is never counted twice.
 */
import type { FinanceTransaction, MaintenanceItem, MaintenanceKind, MaintenanceServiceRecord } from '../types';
import { todayString } from './ledger';
import { addRupees, toPaise } from './money';

/** Where builds before the synced collection kept maintenance (device-only, no timestamps). */
export const LEGACY_MAINTENANCE_KEY = 'dayflow_maintenance_v1';
export const DEFAULT_MAINTENANCE_REMINDER_DAYS: number[] = [3, 0];

export const MAINTENANCE_EXPORT_FORMAT = 'dayflow-maintenance';
export const MAINTENANCE_EXPORT_VERSION = 1;

export const MAINTENANCE_LIMITS = {
  maxId: 64,
  maxAsset: 200,
  maxTitle: 200,
  maxNotes: 4000,
  minIntervalMonths: 1,
  maxIntervalMonths: 120,
  maxReminderDay: 365,
  maxReminders: 5,
  maxCost: 1_000_000_000,
  maxItems: 1000,
  maxHistory: 500,
  /** Largest import file accepted, in characters. */
  maxImportChars: 5_000_000,
} as const;

const MAINTENANCE_KINDS: readonly MaintenanceKind[] = ['vehicle', 'home'];

// ---------------------------------------------------------------------------
// Local calendar dates
// ---------------------------------------------------------------------------

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day written as YYYY-MM-DD (rejects 2027-02-30 and friends). */
export function isMaintenanceDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(year, month, 0, 12).getDate();
}

function formatLocalDate(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

/** Calendar arithmetic at local noon, so DST shifts never move the day. */
function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return formatLocalDate(new Date(year, month - 1, day + days, 12));
}

/**
 * `date` plus `months` calendar months, clamped to the end of the target month
 * (Jan 31 + 1 -> Feb 28 or 29; Feb 29 2028 + 12 -> Feb 28 2029). Local dates.
 */
export function nextMaintenanceDate(date: string, months: number): string {
  if (!isMaintenanceDate(date)) throw new Error('Enter a valid date.');
  if (!Number.isInteger(months)) throw new Error('The interval must be a whole number of months.');
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(year, month - 1 + months, 1, 12);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0, 12).getDate();
  target.setDate(Math.min(day, lastDay));
  return formatLocalDate(target);
}

function localDayOf(nowIso: string): string {
  const time = Date.parse(nowIso);
  if (!Number.isFinite(time)) throw new Error('Invalid timestamp.');
  return todayString(new Date(time));
}

// ---------------------------------------------------------------------------
// Validation (strict, rebuilds objects so unknown fields never ride along)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAINTENANCE_LIMITS.maxId;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function hasAtMostTwoDecimals(value: number): boolean {
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}

function isValidCost(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAINTENANCE_LIMITS.maxCost &&
    hasAtMostTwoDecimals(value)
  );
}

function isValidReminderDays(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length > MAINTENANCE_LIMITS.maxReminders) return false;
  const seen = new Set<number>();
  for (const day of value) {
    if (!Number.isInteger(day) || day < 0 || day > MAINTENANCE_LIMITS.maxReminderDay || seen.has(day)) return false;
    seen.add(day);
  }
  return true;
}

function requiredText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= max ? trimmed : null;
}

function parseServiceRecord(value: unknown): MaintenanceServiceRecord | null {
  if (!isPlainObject(value)) return null;
  if (!isId(value.id) || !isMaintenanceDate(value.date)) return null;
  if (typeof value.notes !== 'string' || value.notes.length > MAINTENANCE_LIMITS.maxNotes) return null;
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) return null;
  const hasCost = value.cost !== undefined && value.cost !== null;
  const hasTransaction = value.transactionId !== undefined && value.transactionId !== null;
  if (hasCost && hasTransaction) return null;
  if (hasCost && !isValidCost(value.cost)) return null;
  if (hasTransaction && !isId(value.transactionId)) return null;
  const record: MaintenanceServiceRecord = {
    id: value.id,
    date: value.date,
    notes: value.notes.trim(),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  if (hasCost) record.cost = value.cost as number;
  if (hasTransaction) record.transactionId = value.transactionId as string;
  return record;
}

function parseItem(value: unknown): MaintenanceItem | null {
  if (!isPlainObject(value)) return null;
  if (!isId(value.id)) return null;
  const asset = requiredText(value.asset, MAINTENANCE_LIMITS.maxAsset);
  const title = requiredText(value.title, MAINTENANCE_LIMITS.maxTitle);
  if (asset === null || title === null) return null;
  if (!MAINTENANCE_KINDS.includes(value.kind as MaintenanceKind)) return null;
  if (!isMaintenanceDate(value.due)) return null;
  const interval = value.intervalMonths;
  if (
    typeof interval !== 'number' ||
    !Number.isInteger(interval) ||
    interval < MAINTENANCE_LIMITS.minIntervalMonths ||
    interval > MAINTENANCE_LIMITS.maxIntervalMonths
  ) {
    return null;
  }
  if (!isValidReminderDays(value.reminderDays)) return null;
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) return null;
  if (value.userId !== undefined && typeof value.userId !== 'string') return null;
  if (!Array.isArray(value.history) || value.history.length > MAINTENANCE_LIMITS.maxHistory) return null;

  const history: MaintenanceServiceRecord[] = [];
  const recordIds = new Set<string>();
  for (const raw of value.history) {
    const record = parseServiceRecord(raw);
    if (!record || recordIds.has(record.id) || record.id === value.id) return null;
    recordIds.add(record.id);
    history.push(record);
  }

  const item: MaintenanceItem = {
    id: value.id,
    asset,
    kind: value.kind as MaintenanceKind,
    title,
    due: value.due,
    intervalMonths: interval,
    reminderDays: [...value.reminderDays],
    history,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  if (typeof value.userId === 'string') item.userId = value.userId;
  return item;
}

/** Every id an item owns: its own and its service records'. */
function idsOf(item: MaintenanceItem): string[] {
  return [item.id, ...item.history.map((record) => record.id)];
}

/**
 * Strict, per item. A malformed item, or one whose id (or a service record id)
 * is already used earlier in the list, is left out and counted in `rejected`.
 */
export function parseMaintenanceItems(value: unknown): { items: MaintenanceItem[]; rejected: number } {
  if (!Array.isArray(value)) return { items: [], rejected: 0 };
  const items: MaintenanceItem[] = [];
  const usedIds = new Set<string>();
  let rejected = 0;
  for (const raw of value) {
    const item = parseItem(raw);
    if (!item || idsOf(item).some((id) => usedIds.has(id))) {
      rejected += 1;
      continue;
    }
    for (const id of idsOf(item)) usedIds.add(id);
    items.push(item);
  }
  return { items, rejected };
}

/**
 * Fill what the legacy shape (`dayflow_maintenance_v1`) lacks: timestamps,
 * reminder days and service record ids. Only ABSENT fields are filled, so a
 * present but invalid value still fails validation. Record ids are derived
 * from the item id, so migrating the same data twice gives the same ids.
 */
function upgradeLegacyItem(value: unknown, now: string): unknown {
  if (!isPlainObject(value)) return value;
  const item: Record<string, unknown> = { ...value };
  if (item.createdAt === undefined) item.createdAt = now;
  if (item.updatedAt === undefined) item.updatedAt = now;
  if (item.reminderDays === undefined) item.reminderDays = [...DEFAULT_MAINTENANCE_REMINDER_DAYS];
  if (item.history === undefined) item.history = [];
  if (Array.isArray(item.history)) {
    item.history = item.history.map((entry, index) => {
      if (!isPlainObject(entry)) return entry;
      const record: Record<string, unknown> = { ...entry };
      if (record.id === undefined) {
        const derived = typeof item.id === 'string' ? `${item.id}-service-${index + 1}` : '';
        record.id = derived && derived.length <= MAINTENANCE_LIMITS.maxId ? derived : newId();
      }
      if (record.notes === undefined) record.notes = '';
      if (record.createdAt === undefined) record.createdAt = now;
      if (record.updatedAt === undefined) record.updatedAt = now;
      return record;
    });
  }
  return item;
}

/**
 * Read the stored collection. `raw` is the text from storage (new key, or the
 * legacy key on first run). Accepts the current shape and the legacy one.
 * `damaged` is true when the text could not be read in full (bad JSON, not a
 * list, or some items rejected): the caller must keep the raw text aside
 * before saving over it.
 */
export function loadMaintenanceStore(
  raw: string | null,
  now: string
): { items: MaintenanceItem[]; rejected: number; damaged: boolean } {
  if (raw === null || raw.trim() === '') return { items: [], rejected: 0, damaged: false };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { items: [], rejected: 0, damaged: true };
  }
  if (!Array.isArray(value)) return { items: [], rejected: 0, damaged: true };
  const { items, rejected } = parseMaintenanceItems(value.map((item) => upgradeLegacyItem(item, now)));
  return { items, rejected, damaged: rejected > 0 };
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

function newId(): string {
  return crypto.randomUUID();
}

function cleanText(value: string, max: number, label: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) throw new Error(`Enter ${label}.`);
  if (trimmed.length > max) throw new Error(`Keep ${label} to ${max} characters or fewer.`);
  return trimmed;
}

function cleanKind(kind: MaintenanceKind): MaintenanceKind {
  if (!MAINTENANCE_KINDS.includes(kind)) throw new Error('Choose vehicle or home.');
  return kind;
}

function cleanDue(due: string): string {
  if (!isMaintenanceDate(due)) throw new Error('Enter a valid due date.');
  return due;
}

function cleanInterval(months: number): number {
  if (
    !Number.isInteger(months) ||
    months < MAINTENANCE_LIMITS.minIntervalMonths ||
    months > MAINTENANCE_LIMITS.maxIntervalMonths
  ) {
    throw new Error(
      `The interval must be a whole number of months from ${MAINTENANCE_LIMITS.minIntervalMonths} to ${MAINTENANCE_LIMITS.maxIntervalMonths}.`
    );
  }
  return months;
}

/** Unique whole days from 0 to 365, at most 5, largest first. */
export function cleanMaintenanceReminderDays(days: number[]): number[] {
  if (!Array.isArray(days)) throw new Error('Reminder days must be a list of numbers.');
  for (const day of days) {
    if (!Number.isInteger(day) || day < 0 || day > MAINTENANCE_LIMITS.maxReminderDay) {
      throw new Error(`Reminder days must be whole numbers from 0 to ${MAINTENANCE_LIMITS.maxReminderDay}.`);
    }
  }
  const unique = [...new Set(days)].sort((a, b) => b - a);
  if (unique.length > MAINTENANCE_LIMITS.maxReminders) {
    throw new Error(`Choose at most ${MAINTENANCE_LIMITS.maxReminders} reminder days.`);
  }
  return unique;
}

function cleanNotes(notes: string): string {
  const text = typeof notes === 'string' ? notes.trim() : '';
  if (text.length > MAINTENANCE_LIMITS.maxNotes) {
    throw new Error(`Keep notes to ${MAINTENANCE_LIMITS.maxNotes} characters or fewer.`);
  }
  return text;
}

function cleanCost(cost: number): number {
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) throw new Error('Enter a cost of 0 or more.');
  if (cost > MAINTENANCE_LIMITS.maxCost) throw new Error('That cost is too large.');
  if (!hasAtMostTwoDecimals(cost)) throw new Error('Use at most 2 decimal places for the cost.');
  return cost;
}

function assertTimestamp(now: string): void {
  if (!isTimestamp(now)) throw new Error('Invalid timestamp.');
}

export function newMaintenanceItem(
  input: {
    asset: string;
    kind: MaintenanceKind;
    title: string;
    due: string;
    intervalMonths: number;
    reminderDays?: number[];
  },
  now: string
): MaintenanceItem {
  assertTimestamp(now);
  return {
    id: newId(),
    asset: cleanText(input.asset, MAINTENANCE_LIMITS.maxAsset, 'the vehicle or place'),
    kind: cleanKind(input.kind),
    title: cleanText(input.title, MAINTENANCE_LIMITS.maxTitle, 'the maintenance task'),
    due: cleanDue(input.due),
    intervalMonths: cleanInterval(input.intervalMonths),
    reminderDays: cleanMaintenanceReminderDays(input.reminderDays ?? DEFAULT_MAINTENANCE_REMINDER_DAYS),
    history: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Edit the item's own fields. The due date only moves when `due` is patched. */
export function updateMaintenanceItem(
  item: MaintenanceItem,
  patch: Partial<Pick<MaintenanceItem, 'asset' | 'kind' | 'title' | 'due' | 'intervalMonths' | 'reminderDays'>>,
  now: string
): MaintenanceItem {
  assertTimestamp(now);
  return {
    ...item,
    asset:
      patch.asset !== undefined ? cleanText(patch.asset, MAINTENANCE_LIMITS.maxAsset, 'the vehicle or place') : item.asset,
    kind: patch.kind !== undefined ? cleanKind(patch.kind) : item.kind,
    title:
      patch.title !== undefined ? cleanText(patch.title, MAINTENANCE_LIMITS.maxTitle, 'the maintenance task') : item.title,
    due: patch.due !== undefined ? cleanDue(patch.due) : item.due,
    intervalMonths: patch.intervalMonths !== undefined ? cleanInterval(patch.intervalMonths) : item.intervalMonths,
    reminderDays:
      patch.reminderDays !== undefined ? cleanMaintenanceReminderDays(patch.reminderDays) : item.reminderDays,
    updatedAt: now,
  };
}

/** Optional context that lets the rules check a transaction link fully. */
export interface ServiceLinkContext {
  /** Every maintenance item, to refuse a transaction already linked elsewhere. */
  items?: MaintenanceItem[];
  /** Money transactions, to refuse a link to a missing or non-expense entry. */
  transactions?: FinanceTransaction[];
}

function checkTransactionLink(
  transactionId: string,
  item: MaintenanceItem,
  recordId: string | undefined,
  context: ServiceLinkContext | undefined
): void {
  if (!isId(transactionId)) throw new Error('Choose an expense from Money to link.');
  const linkedInItem = item.history.some(
    (record) => record.id !== recordId && record.transactionId === transactionId
  );
  const linkedElsewhere = (context?.items ?? []).some(
    (other) =>
      other.id !== item.id &&
      other.history.some((record) => record.id !== recordId && record.transactionId === transactionId)
  );
  if (linkedInItem || linkedElsewhere) {
    throw new Error('That expense is already linked to another service record.');
  }
  if (context?.transactions) {
    const tx = context.transactions.find((candidate) => candidate.id === transactionId);
    if (!tx) throw new Error('That expense no longer exists in Money.');
    if (tx.type !== 'expense') throw new Error('Only an expense can be linked as a service cost.');
  }
}

function latestServiceDate(history: MaintenanceServiceRecord[]): string | undefined {
  let latest: string | undefined;
  for (const record of history) if (!latest || record.date > latest) latest = record.date;
  return latest;
}

/**
 * Record a completed service. The next due date becomes the latest completion
 * date plus the interval, so logging an older service never pulls it back.
 * Reminders follow the due date automatically.
 */
export function recordService(
  item: MaintenanceItem,
  service: { date: string; notes: string; cost?: number; transactionId?: string },
  now: string,
  context?: ServiceLinkContext
): MaintenanceItem {
  assertTimestamp(now);
  if (!isMaintenanceDate(service.date)) throw new Error('Enter the date the service was done.');
  if (service.date > localDayOf(now)) throw new Error('The service date cannot be in the future.');
  if (item.history.length >= MAINTENANCE_LIMITS.maxHistory) {
    throw new Error(`This item already has ${MAINTENANCE_LIMITS.maxHistory} service records.`);
  }
  const hasCost = service.cost !== undefined && service.cost !== null;
  const hasTransaction = Boolean(service.transactionId);
  if (hasCost && hasTransaction) {
    throw new Error('Enter a cost or link an expense from Money, not both.');
  }
  const record: MaintenanceServiceRecord = {
    id: newId(),
    date: service.date,
    notes: cleanNotes(service.notes),
    createdAt: now,
    updatedAt: now,
  };
  if (hasCost) record.cost = cleanCost(service.cost as number);
  if (hasTransaction) {
    checkTransactionLink(service.transactionId as string, item, undefined, context);
    record.transactionId = service.transactionId;
  }
  const history = [...item.history, record];
  return {
    ...item,
    history,
    due: nextMaintenanceDate(latestServiceDate(history) ?? service.date, item.intervalMonths),
    updatedAt: now,
  };
}

/**
 * Edit a service record. Passing `cost` or `transactionId` (null clears it)
 * replaces how the service was paid, since a record holds only one of them.
 * When the edited record is the one the due date was computed from, the due
 * date follows its new date.
 */
export function updateServiceRecord(
  item: MaintenanceItem,
  recordId: string,
  patch: { date?: string; notes?: string; cost?: number | null; transactionId?: string | null },
  now: string,
  context?: ServiceLinkContext
): MaintenanceItem {
  assertTimestamp(now);
  const existing = item.history.find((record) => record.id === recordId);
  if (!existing) throw new Error('That service record no longer exists.');

  const next: MaintenanceServiceRecord = { ...existing, updatedAt: now };
  if (patch.date !== undefined) {
    if (!isMaintenanceDate(patch.date)) throw new Error('Enter the date the service was done.');
    if (patch.date > localDayOf(now)) throw new Error('The service date cannot be in the future.');
    next.date = patch.date;
  }
  if (patch.notes !== undefined) next.notes = cleanNotes(patch.notes);
  if ('cost' in patch || 'transactionId' in patch) {
    const hasCost = patch.cost !== undefined && patch.cost !== null;
    const hasTransaction = Boolean(patch.transactionId);
    if (hasCost && hasTransaction) throw new Error('Enter a cost or link an expense from Money, not both.');
    delete next.cost;
    delete next.transactionId;
    if (hasCost) next.cost = cleanCost(patch.cost as number);
    if (hasTransaction) {
      checkTransactionLink(patch.transactionId as string, item, recordId, context);
      next.transactionId = patch.transactionId as string;
    }
  }

  const history = item.history.map((record) => (record.id === recordId ? next : record));
  let due = item.due;
  if (next.date !== existing.date) {
    const wasLatest = latestServiceDate(item.history) === existing.date;
    const derivedFromIt = item.due === nextMaintenanceDate(existing.date, item.intervalMonths);
    const latestNow = latestServiceDate(history);
    if (wasLatest && derivedFromIt && latestNow) due = nextMaintenanceDate(latestNow, item.intervalMonths);
  }
  return { ...item, history, due, updatedAt: now };
}

/** Remove a service record. The due date stays where it is. */
export function deleteServiceRecord(item: MaintenanceItem, recordId: string, now: string): MaintenanceItem {
  assertTimestamp(now);
  if (!item.history.some((record) => record.id === recordId)) {
    throw new Error('That service record no longer exists.');
  }
  return { ...item, history: item.history.filter((record) => record.id !== recordId), updatedAt: now };
}

// ---------------------------------------------------------------------------
// Spend
// ---------------------------------------------------------------------------

/** What one service cost: the linked expense's amount if it still exists, else its own cost (or 0). */
export function serviceCost(record: MaintenanceServiceRecord, transactions: FinanceTransaction[]): number {
  if (record.transactionId) {
    const tx = transactions.find((candidate) => candidate.id === record.transactionId);
    if (tx && tx.type === 'expense' && Number.isFinite(tx.amount)) return tx.amount;
  }
  return record.cost ?? 0;
}

/** Total spent on an item, added in paise. A transaction linked twice counts once. */
export function maintenanceSpend(item: MaintenanceItem, transactions: FinanceTransaction[]): number {
  const counted = new Set<string>();
  let total = 0;
  for (const record of item.history) {
    if (record.transactionId) {
      if (counted.has(record.transactionId)) continue;
      counted.add(record.transactionId);
    }
    total = addRupees(total, { amount: serviceCost(record, transactions) });
  }
  return total;
}

/** Transaction id -> the first service record that links it. */
export function linkedTransactionIds(items: MaintenanceItem[]): Map<string, { itemId: string; recordId: string }> {
  const links = new Map<string, { itemId: string; recordId: string }>();
  for (const item of items) {
    for (const record of item.history) {
      if (record.transactionId && !links.has(record.transactionId)) {
        links.set(record.transactionId, { itemId: item.id, recordId: record.id });
      }
    }
  }
  return links;
}

/**
 * Expenses a service record may link: not linked by any OTHER record
 * (`exceptRecordId` is the record being edited). Newest first.
 */
export function linkableTransactions(
  items: MaintenanceItem[],
  transactions: FinanceTransaction[],
  exceptRecordId?: string
): FinanceTransaction[] {
  const taken = new Set<string>();
  for (const item of items) {
    for (const record of item.history) {
      if (record.transactionId && record.id !== exceptRecordId) taken.add(record.transactionId);
    }
  }
  return transactions
    .filter((tx) => tx.type === 'expense' && !taken.has(tx.id) && toPaise(tx.amount) > 0)
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        (b.time || '00:00').localeCompare(a.time || '00:00') ||
        (b.createdAt || '').localeCompare(a.createdAt || '')
    );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type MaintenanceStatus = 'overdue' | 'due-soon' | 'upcoming';

/** Overdue before today; due soon from today up to `soonDays` days ahead. */
export function maintenanceStatus(item: MaintenanceItem, today: string, soonDays = 7): MaintenanceStatus {
  if (item.due < today) return 'overdue';
  if (item.due <= addDays(today, soonDays)) return 'due-soon';
  return 'upcoming';
}

/** Overdue items and those due within `withinDays`: overdue first, then by due date. */
export function dueMaintenance(items: MaintenanceItem[], today: string, withinDays = 7): MaintenanceItem[] {
  return items
    .filter((item) => maintenanceStatus(item, today, withinDays) !== 'upcoming')
    .sort(
      (a, b) =>
        Number(b.due < today) - Number(a.due < today) ||
        a.due.localeCompare(b.due) ||
        a.asset.localeCompare(b.asset) ||
        a.title.localeCompare(b.title)
    );
}

// ---------------------------------------------------------------------------
// Export / import / merge
// ---------------------------------------------------------------------------

export function serializeMaintenanceExport(items: MaintenanceItem[], exportedAt: string): string {
  return JSON.stringify(
    { format: MAINTENANCE_EXPORT_FORMAT, version: MAINTENANCE_EXPORT_VERSION, exportedAt, items },
    null,
    2
  );
}

export function maintenanceExportFilename(date = new Date()): string {
  return `dayflow-maintenance-${todayString(date)}.json`;
}

/** Validate an export file. Throws a user-facing Error; nothing partial is returned. */
export function parseMaintenanceExport(text: string): MaintenanceItem[] {
  if (typeof text !== 'string' || text.trim() === '') throw new Error('This file is empty.');
  if (text.length > MAINTENANCE_LIMITS.maxImportChars) throw new Error('This file is too large to be a maintenance export.');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('This file is not valid JSON.');
  }
  if (!isPlainObject(value) || value.format !== MAINTENANCE_EXPORT_FORMAT) {
    throw new Error('This file is not a Dayflow maintenance export.');
  }
  if (typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version < 1) {
    throw new Error('This file is not a Dayflow maintenance export.');
  }
  if (value.version > MAINTENANCE_EXPORT_VERSION) {
    throw new Error('This file was made by a newer version of Dayflow. Update the app and try again.');
  }
  if (!Array.isArray(value.items)) throw new Error('This file is not a Dayflow maintenance export.');
  if (value.items.length > MAINTENANCE_LIMITS.maxItems) {
    throw new Error(`This file has more than ${MAINTENANCE_LIMITS.maxItems} items.`);
  }
  const { items, rejected } = parseMaintenanceItems(value.items);
  if (rejected > 0) {
    throw new Error(
      `${rejected} ${rejected === 1 ? 'item in this file is' : 'items in this file are'} damaged or invalid, so nothing was imported.`
    );
  }
  return items;
}

/**
 * Merge by id: an incoming item replaces the current one only when its
 * `updatedAt` is newer. New items are added. An incoming item whose service
 * record ids clash with another item is skipped, since ids are unique.
 */
export function mergeMaintenanceItems(current: MaintenanceItem[], incoming: MaintenanceItem[]): MaintenanceItem[] {
  const result = [...current];
  const indexById = new Map(current.map((item, index) => [item.id, index]));
  // Every id in use -> the item that owns it.
  const owner = new Map<string, string>();
  for (const item of current) for (const id of idsOf(item)) owner.set(id, item.id);

  for (const item of incoming) {
    if (idsOf(item).some((id) => owner.has(id) && owner.get(id) !== item.id)) continue;
    const index = indexById.get(item.id);
    if (index === undefined) {
      result.push(item);
      indexById.set(item.id, result.length - 1);
    } else if (Date.parse(item.updatedAt) > Date.parse(result[index].updatedAt)) {
      result[index] = item;
    } else {
      continue;
    }
    for (const id of idsOf(item)) owner.set(id, item.id);
  }
  return result;
}
