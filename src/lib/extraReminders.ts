/**
 * Reminders that are not tasks or habits: document expiry, maintenance due dates
 * and money falling due (bills, EMIs, card dues, debts; built in moneyReminders.ts).
 *
 * Notification ids for these reminders are always NEGATIVE. Task and habit reminders
 * use ids >= 0 (see `hashNotificationId` in reminders.ts), so the task sync can leave
 * every id < 0 alone and the extra sync can leave every id >= 0 alone.
 *
 * Everything here works on local calendar dates (YYYY-MM-DD) and local wall-clock
 * time: a reminder for 2027-03-01 fires at 09:00 on that day in the phone's time
 * zone, never at a UTC-derived instant.
 */
import type { MaintenanceItem } from '../types';
import type { MoneyReminderEntry } from './moneyReminders';

/** Plaintext schedule entry for one document reminder (stored outside the encrypted vault). */
export interface DocumentReminderEntry {
  /** Random opaque key per document (not the document id), stable across renewals. */
  key: string;
  /** Day the reminder fires, YYYY-MM-DD local. */
  date: string;
  /** Expiry date of the document's current revision, YYYY-MM-DD local. */
  expiresOn: string;
  /** Document title, only when the user opted in to titles in notifications. */
  label?: string;
}

export interface ExtraReminderPlan {
  /** Always negative. Deterministic for the same (kind, key, date). */
  notificationId: number;
  fireAt: Date;
  title: string;
  body: string;
  /** Delivered as notification `extra.taskId`: 'documents' or `maintenance:<itemId>`. */
  route: string;
}

/** Local hour at which document and maintenance reminders fire. */
export const EXTRA_REMINDER_HOUR = 9;

/** Most extra reminders kept scheduled at once (the soonest win). */
export const MAX_EXTRA_REMINDERS = 64;

/** Route delivered for every document reminder: it opens the Documents screen. */
export const DOCUMENTS_ROUTE = 'documents';

/** Prefix of the route delivered for a maintenance reminder (`maintenance:<itemId>`). */
export const MAINTENANCE_ROUTE_PREFIX = 'maintenance:';

/**
 * While a maintenance item stays overdue, it is nudged again every
 * `OVERDUE_REPEAT_DAYS` days after its due date, for at most
 * `OVERDUE_MAX_REPEATS` nudges. Only items that have reminders turned on
 * (non-empty `reminderDays`) are nudged.
 */
export const OVERDUE_REPEAT_DAYS = 7;
export const OVERDUE_MAX_REPEATS = 8;

/** Extra notification ids live in [EXTRA_ID_MIN, -1]. */
export const EXTRA_ID_MIN = -2_000_000_000;
const EXTRA_ID_SPAN = 2_000_000_000;

const MAX_LABEL_LENGTH = 200;
const MAX_REMINDER_DAY = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Route for a maintenance reminder of one item. */
export function maintenanceRoute(itemId: string): string {
  return `${MAINTENANCE_ROUTE_PREFIX}${itemId}`;
}

/** Item id from a `maintenance:<id>` route, or null for any other route. */
export function maintenanceIdFromRoute(route: string): string | null {
  if (!route.startsWith(MAINTENANCE_ROUTE_PREFIX)) return null;
  const id = route.slice(MAINTENANCE_ROUTE_PREFIX.length);
  return id.length > 0 ? id : null;
}

/**
 * Deterministic negative notification id in [-2_000_000_000, -1] for a reminder key
 * (FNV-1a over the UTF-16 code units, like `hashNotificationId`).
 */
export function extraNotificationId(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return -1 - ((hash >>> 0) % EXTRA_ID_SPAN);
}

/** True for a negative id in the extra-reminder range. */
export function isExtraNotificationId(id: number): boolean {
  return Number.isInteger(id) && id < 0 && id >= EXTRA_ID_MIN;
}

/** Next id when `id` is taken: walks down and wraps from the bottom back to -1. */
function nextExtraId(id: number): number {
  return id <= EXTRA_ID_MIN ? -1 : id - 1;
}

interface LocalDay {
  year: number;
  month: number; // 1..12
  day: number;
}

/** Parses a real calendar date in YYYY-MM-DD form (rejects 2027-02-29, 2026-13-01, ...). */
function parseLocalDay(value: unknown): LocalDay | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const probe = new Date(year, month - 1, day, 12, 0, 0, 0);
  probe.setFullYear(year); // years 0..99 would otherwise map to 1900..1999
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
    return null;
  }
  return { year, month, day };
}

function formatLocalDay(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Local noon of a day: calendar arithmetic there never trips over DST shifts. */
function localNoon(day: LocalDay): Date {
  const date = new Date(day.year, day.month - 1, day.day, 12, 0, 0, 0);
  date.setFullYear(day.year);
  return date;
}

/** `date` shifted by `days` calendar days (local), or null when `date` is not a real day. */
export function shiftLocalDate(date: string, days: number): string | null {
  const parsed = parseLocalDay(date);
  if (!parsed || !Number.isInteger(days)) return null;
  const noon = localNoon(parsed);
  noon.setDate(noon.getDate() + days);
  return formatLocalDay(noon);
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
function daysBetween(from: LocalDay, to: LocalDay): number {
  return Math.round((localNoon(to).getTime() - localNoon(from).getTime()) / DAY_MS);
}

/** 09:00 local on `date`, or null when `date` is not a real day. */
export function extraReminderFireAt(date: string): Date | null {
  const parsed = parseLocalDay(date);
  if (!parsed) return null;
  const fireAt = new Date(parsed.year, parsed.month - 1, parsed.day, EXTRA_REMINDER_HOUR, 0, 0, 0);
  fireAt.setFullYear(parsed.year);
  return fireAt;
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}

function daysPhrase(days: number): string {
  return days === 1 ? '1 day' : `${days} days`;
}

/** "expires in 7 days" / "expires tomorrow" / "expires today" / "has expired". */
function documentExpiryPhrase(daysLeft: number): string {
  if (daysLeft < 0) return 'has expired';
  if (daysLeft === 0) return 'expires today';
  if (daysLeft === 1) return 'expires tomorrow';
  return `expires in ${daysPhrase(daysLeft)}`;
}

/** "is due in 3 days" / "is due tomorrow" / "is due today" / "is overdue by 5 days". */
function maintenanceDuePhrase(daysLeft: number): string {
  if (daysLeft < 0) return `is overdue by ${daysPhrase(-daysLeft)}`;
  if (daysLeft === 0) return 'is due today';
  if (daysLeft === 1) return 'is due tomorrow';
  return `is due in ${daysPhrase(daysLeft)}`;
}

/** Text of a document reminder. Generic unless the user opted in to titles (`label`). */
export function documentReminderText(daysLeft: number, label?: string): { title: string; body: string } {
  const phrase = documentExpiryPhrase(daysLeft);
  const name = cleanText(label, MAX_LABEL_LENGTH);
  if (name) {
    return { title: 'Document reminder', body: `${name} ${phrase}. Open Documents to see it.` };
  }
  return { title: 'Document reminder', body: `A document in your vault ${phrase}. Open Documents to see it.` };
}

/** Text of a maintenance reminder, e.g. "Honda City: Engine oil change is due in 3 days". */
export function maintenanceReminderText(
  asset: string,
  task: string,
  daysLeft: number
): { title: string; body: string } {
  const assetText = cleanText(asset, MAX_LABEL_LENGTH);
  const taskText = cleanText(task, MAX_LABEL_LENGTH) || 'Maintenance';
  const subject = assetText ? `${assetText}: ${taskText}` : taskText;
  return {
    title: daysLeft < 0 ? 'Maintenance overdue' : 'Maintenance due',
    body: `${subject} ${maintenanceDuePhrase(daysLeft)}`,
  };
}

/** Valid reminder offsets: unique integers in 0..365, largest first. Anything else is dropped. */
function cleanReminderDays(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  const unique = new Set<number>();
  for (const value of values) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_REMINDER_DAY) {
      unique.add(value);
    }
  }
  return [...unique].sort((a, b) => b - a);
}

interface Candidate {
  key: string;
  fireAt: Date;
  title: string;
  body: string;
  route: string;
}

function documentCandidates(entries: readonly DocumentReminderEntry[], nowMs: number, out: Candidate[], seen: Set<string>): void {
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.key !== 'string' || entry.key.length === 0) continue;
    const day = parseLocalDay(entry.date);
    const expiry = parseLocalDay(entry.expiresOn);
    if (!day || !expiry) continue;
    const fireAt = extraReminderFireAt(entry.date);
    if (!fireAt || fireAt.getTime() <= nowMs) continue;
    const key = `doc:${entry.key}:${entry.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = documentReminderText(daysBetween(day, expiry), entry.label);
    out.push({ key, fireAt, ...text, route: DOCUMENTS_ROUTE });
  }
}

function maintenanceCandidates(items: readonly MaintenanceItem[], now: Date, out: Candidate[], seen: Set<string>): void {
  const nowMs = now.getTime();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.id !== 'string' || item.id.length === 0) continue;
    const due = parseLocalDay(item.due);
    if (!due) continue;
    const reminderDays = cleanReminderDays(item.reminderDays);
    if (reminderDays.length === 0) continue;
    const route = maintenanceRoute(item.id);

    const push = (date: string) => {
      const fireAt = extraReminderFireAt(date);
      const day = parseLocalDay(date);
      if (!fireAt || !day || fireAt.getTime() <= nowMs) return;
      const key = `mnt:${item.id}:${date}`;
      if (seen.has(key)) return;
      seen.add(key);
      const text = maintenanceReminderText(item.asset, item.title, daysBetween(day, due));
      out.push({ key, fireAt, ...text, route });
    };

    for (const offset of reminderDays) {
      const date = shiftLocalDate(item.due, -offset);
      if (date) push(date);
    }

    // Overdue follow-ups: the next weekly nudge after the due date that is still
    // ahead of `now`. Marking the item serviced moves `due`, which drops them.
    for (let repeat = 1; repeat <= OVERDUE_MAX_REPEATS; repeat++) {
      const date = shiftLocalDate(item.due, repeat * OVERDUE_REPEAT_DAYS);
      if (!date) break;
      const fireAt = extraReminderFireAt(date);
      if (!fireAt) break;
      if (fireAt.getTime() > nowMs) {
        push(date);
        break;
      }
    }
  }
}

function moneyCandidates(entries: readonly MoneyReminderEntry[], nowMs: number, out: Candidate[], seen: Set<string>): void {
  for (const entry of entries) {
    if (!entry || typeof entry.key !== 'string' || entry.key.length === 0) continue;
    const fireAt = extraReminderFireAt(entry.date);
    if (!fireAt || fireAt.getTime() <= nowMs) continue;
    const key = `money:${entry.key}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      fireAt,
      title: cleanText(entry.title, MAX_LABEL_LENGTH) || 'Money due',
      body: cleanText(entry.body, MAX_LABEL_LENGTH),
      route: entry.route,
    });
  }
}

/**
 * Every document, maintenance and money reminder that should be scheduled right now:
 * future fire times only (09:00 local on the reminder day), soonest first,
 * capped at `MAX_EXTRA_REMINDERS`, each with a unique negative notification id.
 *
 * Ids come from `extraNotificationId(key)`; a collision walks to the next free
 * negative id, assigned in (fireAt, key) order so the result is deterministic.
 */
export function buildExtraReminderPlans(input: {
  documents: DocumentReminderEntry[];
  maintenance: MaintenanceItem[];
  /** Bills, EMIs, card dues and debts falling due; empty when money reminders are off. */
  money?: MoneyReminderEntry[];
  now: Date;
}): ExtraReminderPlan[] {
  const nowMs = input.now.getTime();
  if (!Number.isFinite(nowMs)) return [];

  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  documentCandidates(Array.isArray(input.documents) ? input.documents : [], nowMs, candidates, seen);
  maintenanceCandidates(Array.isArray(input.maintenance) ? input.maintenance : [], input.now, candidates, seen);
  moneyCandidates(Array.isArray(input.money) ? input.money : [], nowMs, candidates, seen);

  candidates.sort((a, b) => {
    const byTime = a.fireAt.getTime() - b.fireAt.getTime();
    if (byTime !== 0) return byTime;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  const used = new Set<number>();
  return candidates.slice(0, MAX_EXTRA_REMINDERS).map((candidate) => {
    let id = extraNotificationId(candidate.key);
    while (used.has(id)) id = nextExtraId(id);
    used.add(id);
    return {
      notificationId: id,
      fireAt: candidate.fireAt,
      title: candidate.title,
      body: candidate.body,
      route: candidate.route,
    };
  });
}
