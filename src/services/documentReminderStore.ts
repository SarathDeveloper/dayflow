/**
 * Plaintext reminder schedule for the Document Vault.
 *
 * Reminders must fire and the Today tab must show counts while the vault is
 * locked, so this small schedule lives outside the encryption, in localStorage.
 * It holds ONLY: an opaque random key per document, reminder dates, expiry dates,
 * and document titles when the user turned on "Show document titles in
 * reminders". It is rewritten from the decrypted index after every successful
 * commit, unlock and restore.
 *
 * Device-only: never synced and not part of the app backup.
 */
import type { DocumentReminderEntry } from '../lib/extraReminders';
import { DOCUMENT_LIMITS, isValidLocalDate } from '../lib/documentVault';

export const DOCUMENT_REMINDERS_KEY = 'dayflow_document_reminders_v1';
export const DOCUMENT_REMINDERS_EVENT = 'dayflow:document-reminders';

export interface DocumentReminderState {
  version: 1;
  showTitles: boolean;
  entries: DocumentReminderEntry[];
}

/** 5 reminder offsets per document at most. */
const MAX_ENTRIES = DOCUMENT_LIMITS.maxDocuments * 5;
const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function emptyState(): DocumentReminderState {
  return { version: 1, showTitles: false, entries: [] };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readEntry(value: unknown, showTitles: boolean): DocumentReminderEntry | null {
  if (!isObject(value)) return null;
  if (typeof value.key !== 'string' || !KEY_PATTERN.test(value.key)) return null;
  if (!isValidLocalDate(value.date) || !isValidLocalDate(value.expiresOn)) return null;
  if (value.date > value.expiresOn) return null;
  const entry: DocumentReminderEntry = { key: value.key, date: value.date, expiresOn: value.expiresOn };
  if (value.label !== undefined) {
    if (typeof value.label !== 'string' || value.label.length > DOCUMENT_LIMITS.maxTitle) return null;
    // Titles are stored only when the user opted in.
    if (showTitles && value.label.trim()) entry.label = value.label.trim();
  }
  return entry;
}

/** Strict: throws when any part is invalid. Labels are dropped unless `showTitles`. */
function parseState(value: unknown): DocumentReminderState {
  if (!isObject(value) || value.version !== 1 || typeof value.showTitles !== 'boolean' || !Array.isArray(value.entries)) {
    throw new Error('The document reminder schedule is not valid.');
  }
  if (value.entries.length > MAX_ENTRIES) throw new Error('The document reminder schedule has too many entries.');
  const showTitles = value.showTitles;
  const entries = value.entries.map((item) => {
    const entry = readEntry(item, showTitles);
    if (!entry) throw new Error('The document reminder schedule is not valid.');
    return entry;
  });
  entries.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
  return { version: 1, showTitles, entries };
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The saved schedule; an empty one when nothing is saved or the saved copy is invalid. */
export function readDocumentReminders(): DocumentReminderState {
  try {
    const raw = storage()?.getItem(DOCUMENT_REMINDERS_KEY);
    if (!raw) return emptyState();
    return parseState(JSON.parse(raw));
  } catch {
    return emptyState();
  }
}

/** Saves the schedule and notifies listeners in this window. Throws a user-facing Error. */
export function writeDocumentReminders(state: DocumentReminderState): void {
  const checked = parseState(state);
  const store = storage();
  if (!store) throw new Error('Reminders could not be saved: this browser blocks local storage.');
  try {
    store.setItem(DOCUMENT_REMINDERS_KEY, JSON.stringify(checked));
  } catch (error) {
    const quota = typeof error === 'object' && error !== null &&
      ['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'].includes(String((error as { name?: unknown }).name));
    throw new Error(quota
      ? 'Document reminders could not be saved because this device\'s storage is full.'
      : 'Document reminders could not be saved on this device.');
  }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new Event(DOCUMENT_REMINDERS_EVENT));
  }
}

/** Calls `listener` when the schedule changes in this window or another tab. Returns the unsubscribe. */
export function subscribeDocumentReminders(listener: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => undefined;
  const onLocal = () => listener();
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === DOCUMENT_REMINDERS_KEY) listener();
  };
  window.addEventListener(DOCUMENT_REMINDERS_EVENT, onLocal);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(DOCUMENT_REMINDERS_EVENT, onLocal);
    window.removeEventListener('storage', onStorage);
  };
}
