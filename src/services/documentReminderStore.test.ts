import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DOCUMENT_REMINDERS_KEY,
  readDocumentReminders,
  subscribeDocumentReminders,
  writeDocumentReminders,
} from './documentReminderStore';

class MemoryStorage {
  data = new Map<string, string>();
  failWith: string | null = null;
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) {
    if (this.failWith) throw new DOMException('full', this.failWith);
    this.data.set(key, value);
  }
  removeItem(key: string) { this.data.delete(key); }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', new EventTarget());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const entry = { key: 'abcdef0123456789abcdef', date: '2027-01-01', expiresOn: '2027-01-31' };

describe('document reminder store', () => {
  it('round-trips and notifies subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDocumentReminders(listener);
    writeDocumentReminders({ version: 1, showTitles: true, entries: [{ ...entry, label: 'Passport' }] });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(readDocumentReminders()).toEqual({ version: 1, showTitles: true, entries: [{ ...entry, label: 'Passport' }] });
    unsubscribe();
    writeDocumentReminders({ version: 1, showTitles: false, entries: [] });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('never stores titles unless the user opted in', () => {
    writeDocumentReminders({ version: 1, showTitles: false, entries: [{ ...entry, label: 'Passport' }] });
    expect(storage.getItem(DOCUMENT_REMINDERS_KEY)).not.toContain('Passport');
    expect(readDocumentReminders().entries).toEqual([entry]);
  });

  it('reads invalid or missing data as an empty schedule', () => {
    expect(readDocumentReminders()).toEqual({ version: 1, showTitles: false, entries: [] });
    storage.data.set(DOCUMENT_REMINDERS_KEY, '{broken');
    expect(readDocumentReminders().entries).toEqual([]);
    storage.data.set(DOCUMENT_REMINDERS_KEY, JSON.stringify({ version: 1, showTitles: false, entries: [{ ...entry, date: '2027-02-29' }] }));
    expect(readDocumentReminders().entries).toEqual([]);
    storage.data.set(DOCUMENT_REMINDERS_KEY, JSON.stringify({ version: 2, showTitles: false, entries: [] }));
    expect(readDocumentReminders().entries).toEqual([]);
  });

  it('rejects invalid writes and reports a full storage', () => {
    expect(() => writeDocumentReminders({ version: 1, showTitles: false, entries: [{ ...entry, key: 'a:b' }] })).toThrow('not valid');
    storage.failWith = 'QuotaExceededError';
    expect(() => writeDocumentReminders({ version: 1, showTitles: false, entries: [entry] })).toThrow('storage is full');
  });
});
