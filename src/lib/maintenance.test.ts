import { afterAll, describe, expect, it } from 'vitest';
import type { FinanceTransaction, MaintenanceItem } from '../types';
import {
  DEFAULT_MAINTENANCE_REMINDER_DAYS,
  deleteServiceRecord,
  dueMaintenance,
  linkableTransactions,
  linkedTransactionIds,
  loadMaintenanceStore,
  maintenanceSpend,
  maintenanceStatus,
  mergeMaintenanceItems,
  newMaintenanceItem,
  nextMaintenanceDate,
  parseMaintenanceExport,
  parseMaintenanceItems,
  recordService,
  serializeMaintenanceExport,
  serviceCost,
  updateMaintenanceItem,
  updateServiceRecord,
} from './maintenance';

const originalTz = process.env.TZ;
process.env.TZ = 'Asia/Kolkata';
afterAll(() => {
  process.env.TZ = originalTz;
});

const T0 = '2026-11-01T06:00:00.000Z';
const NOW = '2026-11-16T06:00:00.000Z';
const LATER = '2026-11-17T06:00:00.000Z';

const item = (over: Partial<MaintenanceItem> = {}): MaintenanceItem => ({
  id: 'item-1',
  asset: 'Honda City',
  kind: 'vehicle',
  title: 'Engine oil change',
  due: '2026-12-01',
  intervalMonths: 6,
  reminderDays: [3, 0],
  history: [],
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

const tx = (id: string, amount: number, over: Partial<FinanceTransaction> = {}): FinanceTransaction => ({
  id,
  type: 'expense',
  amount,
  category: 'Vehicle',
  date: '2026-11-10',
  recurrence: { type: 'none' } as FinanceTransaction['recurrence'],
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

describe('nextMaintenanceDate', () => {
  it('clamps to the end of the month', () => {
    expect(nextMaintenanceDate('2027-01-31', 1)).toBe('2027-02-28');
    expect(nextMaintenanceDate('2028-01-31', 1)).toBe('2028-02-29');
    expect(nextMaintenanceDate('2026-08-31', 1)).toBe('2026-09-30');
    expect(nextMaintenanceDate('2026-11-15', 6)).toBe('2027-05-15');
  });

  it('handles leap days', () => {
    expect(nextMaintenanceDate('2028-02-29', 12)).toBe('2029-02-28');
    expect(nextMaintenanceDate('2028-02-29', 48)).toBe('2032-02-29');
  });

  it('rejects invalid dates', () => {
    expect(() => nextMaintenanceDate('2027-02-29', 1)).toThrow();
    expect(() => nextMaintenanceDate('2026-13-01', 1)).toThrow();
  });
});

describe('loadMaintenanceStore', () => {
  it('migrates the legacy shape (no timestamps, history without ids)', () => {
    const legacy = JSON.stringify([
      {
        id: 'old-1',
        asset: 'Kitchen',
        kind: 'home',
        title: 'Water filter',
        due: '2026-12-10',
        intervalMonths: 3,
        history: [
          { date: '2026-06-10', notes: 'Changed' },
          { date: '2026-09-10', notes: '' },
        ],
      },
    ]);
    const result = loadMaintenanceStore(legacy, NOW);
    expect(result.damaged).toBe(false);
    expect(result.rejected).toBe(0);
    expect(result.items).toHaveLength(1);
    const migrated = result.items[0];
    expect(migrated.createdAt).toBe(NOW);
    expect(migrated.updatedAt).toBe(NOW);
    expect(migrated.reminderDays).toEqual(DEFAULT_MAINTENANCE_REMINDER_DAYS);
    expect(migrated.history.map((record) => record.id)).toEqual(['old-1-service-1', 'old-1-service-2']);
    expect(migrated.history[0]).toMatchObject({ date: '2026-06-10', notes: 'Changed', createdAt: NOW });
    // Migrating the same text again gives the same ids.
    expect(loadMaintenanceStore(legacy, NOW).items).toEqual(result.items);
  });

  it('reads the current shape untouched', () => {
    const saved = item({ history: [{ id: 'svc-1', date: '2026-06-01', notes: 'ok', cost: 1200.5, createdAt: T0, updatedAt: T0 }] });
    const result = loadMaintenanceStore(JSON.stringify([saved]), NOW);
    expect(result).toEqual({ items: [saved], rejected: 0, damaged: false });
  });

  it('flags broken JSON or a non-list as damaged', () => {
    expect(loadMaintenanceStore('{not json', NOW)).toEqual({ items: [], rejected: 0, damaged: true });
    expect(loadMaintenanceStore('{"a":1}', NOW)).toEqual({ items: [], rejected: 0, damaged: true });
    expect(loadMaintenanceStore(null, NOW)).toEqual({ items: [], rejected: 0, damaged: false });
  });

  it('keeps valid items and counts rejected ones', () => {
    const raw = JSON.stringify([item(), item({ id: 'bad', intervalMonths: 0 }), { id: 'x' }, item({ id: 'item-1' })]);
    const result = loadMaintenanceStore(raw, NOW);
    expect(result.items.map((entry) => entry.id)).toEqual(['item-1']);
    expect(result.rejected).toBe(3);
    expect(result.damaged).toBe(true);
  });
});

describe('parseMaintenanceItems', () => {
  it('rebuilds objects without unknown fields and trims text', () => {
    const { items, rejected } = parseMaintenanceItems([{ ...item(), asset: '  Honda City ', extra: 'drop me' }]);
    expect(rejected).toBe(0);
    expect(items[0]).not.toHaveProperty('extra');
    expect(items[0].asset).toBe('Honda City');
  });

  it('applies the validation rules', () => {
    const bad: unknown[] = [
      item({ id: '' }),
      item({ id: 'x'.repeat(65) }),
      item({ asset: '   ' }),
      item({ title: 'x'.repeat(201) }),
      item({ due: '2027-02-29' }),
      item({ intervalMonths: 121 }),
      item({ intervalMonths: 1.5 }),
      item({ reminderDays: [3, 3] }),
      item({ reminderDays: [366] }),
      item({ reminderDays: [1, 2, 3, 4, 5, 6] }),
      item({ kind: 'boat' as MaintenanceItem['kind'] }),
      item({ updatedAt: 'yesterday' }),
      item({ history: [{ id: 's', date: '2026-01-01', notes: 'x'.repeat(4001), createdAt: T0, updatedAt: T0 }] }),
      item({ history: [{ id: 's', date: '2026-01-01', notes: '', cost: 10.005, createdAt: T0, updatedAt: T0 }] }),
      item({ history: [{ id: 's', date: '2026-01-01', notes: '', cost: -1, createdAt: T0, updatedAt: T0 }] }),
      item({ history: [{ id: 's', date: '2026-01-01', notes: '', cost: 2e9, createdAt: T0, updatedAt: T0 }] }),
      item({
        history: [{ id: 's', date: '2026-01-01', notes: '', cost: 10, transactionId: 'tx', createdAt: T0, updatedAt: T0 }],
      }),
    ];
    // Distinct ids, so each item is rejected for its own rule and not as a duplicate.
    const distinct = bad.map((entry, index) => {
      const candidate = entry as MaintenanceItem;
      return candidate.id === 'item-1' ? { ...candidate, id: `bad-${index}` } : candidate;
    });
    const { items, rejected } = parseMaintenanceItems(distinct);
    expect(items).toEqual([]);
    expect(rejected).toBe(bad.length);
  });

  it('rejects a service record id that another item already uses', () => {
    const record = { id: 'svc-1', date: '2026-06-01', notes: '', createdAt: T0, updatedAt: T0 };
    const { items, rejected } = parseMaintenanceItems([item({ history: [record] }), item({ id: 'item-2', history: [record] })]);
    expect(items.map((entry) => entry.id)).toEqual(['item-1']);
    expect(rejected).toBe(1);
  });
});

describe('edits', () => {
  it('creates a validated item with default reminders', () => {
    const created = newMaintenanceItem(
      { asset: ' Car ', kind: 'vehicle', title: ' Tyres ', due: '2026-12-01', intervalMonths: 12 },
      NOW
    );
    expect(created).toMatchObject({ asset: 'Car', title: 'Tyres', reminderDays: [3, 0], history: [], createdAt: NOW, updatedAt: NOW });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => newMaintenanceItem({ asset: '', kind: 'vehicle', title: 'x', due: '2026-12-01', intervalMonths: 1 }, NOW)).toThrow(
      /vehicle or place/
    );
    expect(() =>
      newMaintenanceItem({ asset: 'a', kind: 'vehicle', title: 'x', due: '2026-12-01', intervalMonths: 1, reminderDays: [1, 2, 3, 4, 5, 6] }, NOW)
    ).toThrow(/at most 5/);
  });

  it('updates fields and stamps updatedAt', () => {
    const updated = updateMaintenanceItem(item(), { title: 'Oil + filter', reminderDays: [0, 7, 7] }, NOW);
    expect(updated.title).toBe('Oil + filter');
    expect(updated.reminderDays).toEqual([7, 0]);
    expect(updated.updatedAt).toBe(NOW);
    expect(updated.due).toBe('2026-12-01');
    expect(() => updateMaintenanceItem(item(), { due: '2026-02-30' }, NOW)).toThrow();
  });

  it('moves the due date from the completion date when serviced', () => {
    const serviced = recordService(item(), { date: '2026-11-15', notes: ' Done ', cost: 2500 }, NOW);
    expect(serviced.due).toBe('2027-05-15');
    expect(serviced.updatedAt).toBe(NOW);
    expect(serviced.history).toHaveLength(1);
    expect(serviced.history[0]).toMatchObject({ date: '2026-11-15', notes: 'Done', cost: 2500, createdAt: NOW, updatedAt: NOW });
    // Logging an older service later keeps the due date from the latest one.
    const backfilled = recordService(serviced, { date: '2026-05-01', notes: '' }, LATER);
    expect(backfilled.due).toBe('2027-05-15');
  });

  it('clamps the next due date at month end', () => {
    const monthly = item({ intervalMonths: 1 });
    expect(recordService(monthly, { date: '2026-10-31', notes: '' }, NOW).due).toBe('2026-11-30');
  });

  it('refuses future dates, both cost and link, and a link already used', () => {
    expect(() => recordService(item(), { date: '2026-11-17', notes: '' }, NOW)).toThrow(/future/);
    expect(() => recordService(item(), { date: '2026-11-10', notes: '', cost: 5, transactionId: 'tx-1' }, NOW)).toThrow(/not both/);
    const other = recordService(item({ id: 'item-2' }), { date: '2026-11-10', notes: '', transactionId: 'tx-1' }, NOW);
    expect(() =>
      recordService(item(), { date: '2026-11-10', notes: '', transactionId: 'tx-1' }, NOW, { items: [other] })
    ).toThrow(/already linked/);
    expect(() =>
      recordService(item(), { date: '2026-11-10', notes: '', transactionId: 'tx-9' }, NOW, { transactions: [tx('tx-1', 10)] })
    ).toThrow(/no longer exists/);
    expect(() =>
      recordService(item(), { date: '2026-11-10', notes: '', transactionId: 'tx-1' }, NOW, {
        transactions: [tx('tx-1', 10, { type: 'income' })],
      })
    ).toThrow(/Only an expense/);
  });

  it('edits a service record and switches cost to a linked expense', () => {
    const serviced = recordService(item(), { date: '2026-11-10', notes: '', cost: 100 }, NOW);
    const recordId = serviced.history[0].id;
    const linked = updateServiceRecord(serviced, recordId, { transactionId: 'tx-1' }, LATER);
    expect(linked.history[0].cost).toBeUndefined();
    expect(linked.history[0].transactionId).toBe('tx-1');
    expect(linked.history[0].updatedAt).toBe(LATER);
    expect(linked.updatedAt).toBe(LATER);
    const backToCost = updateServiceRecord(linked, recordId, { cost: 50, transactionId: null }, LATER);
    expect(backToCost.history[0]).toMatchObject({ cost: 50 });
    expect(backToCost.history[0].transactionId).toBeUndefined();
    expect(() => updateServiceRecord(serviced, 'missing', { notes: 'x' }, LATER)).toThrow(/no longer exists/);
  });

  it('moves the due date when the latest service date is corrected', () => {
    const serviced = recordService(item(), { date: '2026-11-10', notes: '' }, NOW);
    expect(serviced.due).toBe('2027-05-10');
    const corrected = updateServiceRecord(serviced, serviced.history[0].id, { date: '2026-11-12' }, LATER);
    expect(corrected.due).toBe('2027-05-12');
    // A due date set by hand afterwards is left alone.
    const manual = updateMaintenanceItem(serviced, { due: '2027-01-01' }, LATER);
    expect(updateServiceRecord(manual, manual.history[0].id, { date: '2026-11-12' }, LATER).due).toBe('2027-01-01');
  });

  it('deleting a service record does not move the due date back', () => {
    const serviced = recordService(item(), { date: '2026-11-10', notes: '' }, NOW);
    const removed = deleteServiceRecord(serviced, serviced.history[0].id, LATER);
    expect(removed.history).toEqual([]);
    expect(removed.due).toBe(serviced.due);
    expect(removed.updatedAt).toBe(LATER);
  });
});

describe('spend and links', () => {
  const record = (id: string, over: Partial<MaintenanceItem['history'][number]> = {}) => ({
    id,
    date: '2026-11-10',
    notes: '',
    createdAt: T0,
    updatedAt: T0,
    ...over,
  });

  it('uses the linked expense or the standalone cost, never both', () => {
    const transactions = [tx('tx-1', 1999.99), tx('tx-2', 0.1)];
    const linked = item({
      history: [
        record('a', { transactionId: 'tx-1' }),
        record('b', { cost: 0.2 }),
        record('c', { transactionId: 'tx-2' }),
        record('d', { transactionId: 'tx-gone' }),
        record('e'),
      ],
    });
    expect(serviceCost(linked.history[0], transactions)).toBe(1999.99);
    expect(serviceCost(linked.history[3], transactions)).toBe(0);
    expect(maintenanceSpend(linked, transactions)).toBe(2000.29);
  });

  it('counts a transaction linked twice only once', () => {
    const doubled = item({ history: [record('a', { transactionId: 'tx-1' }), record('b', { transactionId: 'tx-1' })] });
    expect(maintenanceSpend(doubled, [tx('tx-1', 500)])).toBe(500);
  });

  it('lists linkable expenses newest first, excluding ones linked elsewhere', () => {
    const transactions = [
      tx('tx-1', 100, { date: '2026-11-01' }),
      tx('tx-2', 200, { date: '2026-11-12' }),
      tx('tx-3', 300, { date: '2026-11-05' }),
      tx('tx-income', 300, { type: 'income' }),
    ];
    const items = [
      item({ history: [record('a', { transactionId: 'tx-1' })] }),
      item({ id: 'item-2', history: [record('b', { transactionId: 'tx-3' }), record('c', { transactionId: 'tx-3' })] }),
    ];
    expect(linkedTransactionIds(items).get('tx-3')).toEqual({ itemId: 'item-2', recordId: 'b' });
    expect(linkableTransactions(items, transactions).map((t) => t.id)).toEqual(['tx-2']);
    // Editing record a may keep its own link.
    expect(linkableTransactions(items, transactions, 'a').map((t) => t.id)).toEqual(['tx-2', 'tx-1']);
    // tx-3 is linked by b AND c: still taken when editing b.
    expect(linkableTransactions(items, transactions, 'b').map((t) => t.id)).toEqual(['tx-2']);
  });
});

describe('status', () => {
  const today = '2026-11-16';
  it('classifies overdue, due soon and upcoming', () => {
    expect(maintenanceStatus(item({ due: '2026-11-15' }), today)).toBe('overdue');
    expect(maintenanceStatus(item({ due: '2026-11-16' }), today)).toBe('due-soon');
    expect(maintenanceStatus(item({ due: '2026-11-23' }), today)).toBe('due-soon');
    expect(maintenanceStatus(item({ due: '2026-11-24' }), today)).toBe('upcoming');
  });

  it('orders overdue first, then by due date', () => {
    const items = [
      item({ id: 'soon', due: '2026-11-20' }),
      item({ id: 'later', due: '2026-12-30' }),
      item({ id: 'late', due: '2026-11-01' }),
      item({ id: 'today', due: '2026-11-16' }),
      item({ id: 'very-late', due: '2026-10-01' }),
    ];
    expect(dueMaintenance(items, today).map((entry) => entry.id)).toEqual(['very-late', 'late', 'today', 'soon']);
  });
});

describe('export / import / merge', () => {
  const full = item({
    history: [{ id: 'svc-1', date: '2026-06-01', notes: 'ok', transactionId: 'tx-1', createdAt: T0, updatedAt: T0 }],
  });

  it('round-trips an export', () => {
    const text = serializeMaintenanceExport([full, item({ id: 'item-2', kind: 'home' })], NOW);
    expect(JSON.parse(text)).toMatchObject({ format: 'dayflow-maintenance', version: 1, exportedAt: NOW });
    expect(parseMaintenanceExport(text)).toEqual([full, item({ id: 'item-2', kind: 'home' })]);
  });

  it('rejects tampered or foreign files with a clear message', () => {
    expect(() => parseMaintenanceExport('')).toThrow(/empty/);
    expect(() => parseMaintenanceExport('{oops')).toThrow(/not valid JSON/);
    expect(() => parseMaintenanceExport(JSON.stringify({ format: 'other', version: 1, items: [] }))).toThrow(/not a Dayflow/);
    expect(() => parseMaintenanceExport(JSON.stringify({ format: 'dayflow-maintenance', version: 2, items: [] }))).toThrow(/newer/);
    expect(() => parseMaintenanceExport(JSON.stringify({ format: 'dayflow-maintenance', version: 1, items: {} }))).toThrow(/not a Dayflow/);
    const tampered = JSON.parse(serializeMaintenanceExport([full], NOW));
    tampered.items[0].history[0].cost = 10;
    expect(() => parseMaintenanceExport(JSON.stringify(tampered))).toThrow(/1 item in this file is damaged/);
  });

  it('merges by id, newer updatedAt wins', () => {
    const current = [item({ title: 'Local', updatedAt: NOW }), item({ id: 'item-2', title: 'Old', updatedAt: T0 })];
    const incoming = [
      item({ title: 'Older import', updatedAt: T0 }),
      item({ id: 'item-2', title: 'Newer import', updatedAt: LATER }),
      item({ id: 'item-3', title: 'New' }),
    ];
    const merged = mergeMaintenanceItems(current, incoming);
    expect(merged.map((entry) => [entry.id, entry.title])).toEqual([
      ['item-1', 'Local'],
      ['item-2', 'Newer import'],
      ['item-3', 'New'],
    ]);
  });

  it('skips an incoming item that reuses another item\'s record id', () => {
    const current = [full];
    const clash = item({ id: 'item-9', history: [{ ...full.history[0] }] });
    expect(mergeMaintenanceItems(current, [clash])).toEqual([full]);
  });
});
