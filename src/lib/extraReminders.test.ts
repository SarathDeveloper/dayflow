import { describe, expect, it } from 'vitest';
import type { MaintenanceItem } from '../types';
import {
  EXTRA_ID_MIN,
  EXTRA_REMINDER_HOUR,
  MAX_EXTRA_REMINDERS,
  buildExtraReminderPlans,
  extraNotificationId,
  extraReminderFireAt,
  maintenanceIdFromRoute,
  shiftLocalDate,
  type DocumentReminderEntry,
} from './extraReminders';

const NOW = new Date(2026, 10, 16, 10, 30, 0); // 2026-11-16 10:30 local

function item(overrides: Partial<MaintenanceItem> = {}): MaintenanceItem {
  return {
    id: 'mnt-1',
    asset: 'Honda City',
    kind: 'vehicle',
    title: 'Engine oil change',
    due: '2026-12-01',
    intervalMonths: 6,
    reminderDays: [3, 0],
    history: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function doc(overrides: Partial<DocumentReminderEntry> = {}): DocumentReminderEntry {
  return { key: 'k1', date: '2026-12-01', expiresOn: '2026-12-08', ...overrides };
}

function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

describe('extraNotificationId', () => {
  it('is negative, in range and deterministic', () => {
    const keys = ['doc:a:2026-12-01', 'mnt:x:2027-01-01', '', 'z'.repeat(500), 'doc:ünïcode:2026-01-01'];
    for (const key of keys) {
      const id = extraNotificationId(key);
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeLessThanOrEqual(-1);
      expect(id).toBeGreaterThanOrEqual(EXTRA_ID_MIN);
      expect(extraNotificationId(key)).toBe(id);
    }
    expect(extraNotificationId('doc:a:2026-12-01')).not.toBe(extraNotificationId('doc:a:2026-12-02'));
  });

  it('spreads many keys without falling outside the range', () => {
    const ids = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      const id = extraNotificationId(`mnt:item-${i}:2026-12-01`);
      expect(id).toBeLessThan(0);
      expect(id).toBeGreaterThanOrEqual(EXTRA_ID_MIN);
      ids.add(id);
    }
    expect(ids.size).toBeGreaterThan(4990);
  });
});

describe('local date helpers', () => {
  it('fires at 09:00 local on the reminder day', () => {
    const fireAt = extraReminderFireAt('2027-03-01')!;
    expect(fireAt.getFullYear()).toBe(2027);
    expect(fireAt.getMonth()).toBe(2);
    expect(fireAt.getDate()).toBe(1);
    expect(fireAt.getHours()).toBe(EXTRA_REMINDER_HOUR);
    expect(fireAt.getMinutes()).toBe(0);
    expect(extraReminderFireAt('2027-02-29')).toBeNull();
    expect(extraReminderFireAt('2026-13-01')).toBeNull();
    expect(extraReminderFireAt('not a date')).toBeNull();
  });

  it('does calendar arithmetic across month ends and leap years', () => {
    expect(shiftLocalDate('2027-03-01', -1)).toBe('2027-02-28');
    expect(shiftLocalDate('2028-03-01', -1)).toBe('2028-02-29');
    expect(shiftLocalDate('2028-03-29', -30)).toBe('2028-02-28');
    expect(shiftLocalDate('2027-03-29', -30)).toBe('2027-02-27');
    expect(shiftLocalDate('2027-01-01', -1)).toBe('2026-12-31');
    expect(shiftLocalDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftLocalDate('2027-02-29', -1)).toBeNull();
  });
});

describe('buildExtraReminderPlans: maintenance', () => {
  it('schedules due minus each reminder day at 09:00 local with the asset and task', () => {
    const plans = buildExtraReminderPlans({ documents: [], maintenance: [item()], now: NOW });
    const reminders = plans.filter((plan) => plan.title === 'Maintenance due');
    expect(reminders.map((plan) => localDay(plan.fireAt))).toEqual(['2026-11-28', '2026-12-01']);
    for (const plan of reminders) {
      expect(plan.fireAt.getHours()).toBe(9);
      expect(plan.fireAt.getMinutes()).toBe(0);
      expect(plan.route).toBe('maintenance:mnt-1');
      expect(maintenanceIdFromRoute(plan.route)).toBe('mnt-1');
    }
    expect(reminders[0].body).toBe('Honda City: Engine oil change is due in 3 days');
    expect(reminders[1].body).toBe('Honda City: Engine oil change is due today');
  });

  it('handles due dates right after a month end and in leap years', () => {
    const leap = buildExtraReminderPlans({
      documents: [],
      maintenance: [item({ id: 'a', due: '2028-03-01', reminderDays: [1] })],
      now: NOW,
    });
    expect(leap.map((plan) => localDay(plan.fireAt))[0]).toBe('2028-02-29');
    expect(leap[0].body).toBe('Honda City: Engine oil change is due tomorrow');

    const common = buildExtraReminderPlans({
      documents: [],
      maintenance: [item({ id: 'b', due: '2027-03-01', reminderDays: [1, 30] })],
      now: NOW,
    });
    expect(common.slice(0, 2).map((plan) => localDay(plan.fireAt))).toEqual(['2027-01-30', '2027-02-28']);
  });

  it('skips reminder dates that are already past, including 09:00 today once passed', () => {
    // NOW is 10:30 on 2026-11-16: the reminder for today (due - 0) has passed.
    const plans = buildExtraReminderPlans({
      documents: [],
      maintenance: [item({ due: '2026-11-19', reminderDays: [3, 0] })],
      now: NOW,
    });
    expect(plans.filter((plan) => plan.title === 'Maintenance due').map((plan) => localDay(plan.fireAt))).toEqual([
      '2026-11-19',
    ]);

    const early = buildExtraReminderPlans({
      documents: [],
      maintenance: [item({ due: '2026-11-19', reminderDays: [3] })],
      now: new Date(2026, 10, 16, 8, 59, 0),
    });
    expect(localDay(early[0].fireAt)).toBe('2026-11-16');
  });

  it('nudges an overdue item weekly with overdue phrasing', () => {
    const plans = buildExtraReminderPlans({
      documents: [],
      maintenance: [item({ due: '2026-11-10', reminderDays: [3, 0] })],
      now: NOW,
    });
    expect(plans).toHaveLength(1);
    expect(localDay(plans[0].fireAt)).toBe('2026-11-17');
    expect(plans[0].title).toBe('Maintenance overdue');
    expect(plans[0].body).toBe('Honda City: Engine oil change is overdue by 7 days');
  });

  it('stops nudging long-overdue items and items without reminders', () => {
    const plans = buildExtraReminderPlans({
      documents: [],
      maintenance: [item({ id: 'old', due: '2025-01-01' }), item({ id: 'off', reminderDays: [] })],
      now: NOW,
    });
    expect(plans).toEqual([]);
  });

  it('ignores items with an invalid due date or invalid reminder days', () => {
    const plans = buildExtraReminderPlans({
      documents: [],
      maintenance: [
        item({ id: 'bad', due: '2027-02-29' }),
        item({ id: 'odd', reminderDays: [-1, 1.5, 400, 2, 2] as number[] }),
      ],
      now: NOW,
    });
    expect(plans.every((plan) => plan.route === 'maintenance:odd')).toBe(true);
    expect(plans.filter((plan) => plan.title === 'Maintenance due').map((plan) => localDay(plan.fireAt))).toEqual([
      '2026-11-29',
    ]);
  });
});

describe('buildExtraReminderPlans: documents', () => {
  it('uses generic text by default and routes to the vault', () => {
    const [plan] = buildExtraReminderPlans({ documents: [doc()], maintenance: [], now: NOW });
    expect(plan.title).toBe('Document reminder');
    expect(plan.body).toBe('A document in your vault expires in 7 days. Open Documents to see it.');
    expect(plan.route).toBe('documents');
    expect(localDay(plan.fireAt)).toBe('2026-12-01');
    expect(plan.fireAt.getHours()).toBe(9);
  });

  it('uses the label only when present', () => {
    const [plan] = buildExtraReminderPlans({ documents: [doc({ label: '  Passport  ' })], maintenance: [], now: NOW });
    expect(plan.body).toBe('Passport expires in 7 days. Open Documents to see it.');
    expect(plan.title).toBe('Document reminder');
  });

  it('phrases today, tomorrow and already expired', () => {
    const plans = buildExtraReminderPlans({
      documents: [
        doc({ key: 'a', date: '2026-12-01', expiresOn: '2026-12-01' }),
        doc({ key: 'b', date: '2026-12-02', expiresOn: '2026-12-03' }),
        doc({ key: 'c', date: '2026-12-03', expiresOn: '2026-11-01' }),
      ],
      maintenance: [],
      now: NOW,
    });
    expect(plans.map((plan) => plan.body)).toEqual([
      'A document in your vault expires today. Open Documents to see it.',
      'A document in your vault expires tomorrow. Open Documents to see it.',
      'A document in your vault has expired. Open Documents to see it.',
    ]);
  });

  it('skips past dates, invalid entries and duplicates', () => {
    const plans = buildExtraReminderPlans({
      documents: [
        doc({ key: 'past', date: '2026-11-15' }),
        doc({ key: 'today-passed', date: '2026-11-16' }),
        doc({ key: 'bad', date: '2027-02-29' }),
        doc({ key: '', date: '2026-12-01' }),
        doc({ key: 'dup' }),
        doc({ key: 'dup' }),
      ],
      maintenance: [],
      now: NOW,
    });
    expect(plans).toHaveLength(1);
  });

  it('works across month ends (a reminder dated Feb 28 for a Mar 1 expiry)', () => {
    const [plan] = buildExtraReminderPlans({
      documents: [doc({ date: '2027-02-28', expiresOn: '2027-03-01' })],
      maintenance: [],
      now: NOW,
    });
    expect(plan.body).toContain('expires tomorrow');
  });
});

describe('buildExtraReminderPlans: ordering, ids and cap', () => {
  it('sorts by fire time, caps at the soonest 64 and keeps ids unique and negative', () => {
    const documents: DocumentReminderEntry[] = [];
    for (let i = 0; i < 80; i++) {
      const date = shiftLocalDate('2026-11-17', i)!;
      documents.push(doc({ key: `k${i}`, date, expiresOn: shiftLocalDate(date, 30)! }));
    }
    const plans = buildExtraReminderPlans({ documents: documents.reverse(), maintenance: [item()], now: NOW });
    expect(plans).toHaveLength(MAX_EXTRA_REMINDERS);
    for (let i = 1; i < plans.length; i++) {
      expect(plans[i].fireAt.getTime()).toBeGreaterThanOrEqual(plans[i - 1].fireAt.getTime());
    }
    expect(localDay(plans[0].fireAt)).toBe('2026-11-17');
    const ids = plans.map((plan) => plan.notificationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id < 0 && id >= EXTRA_ID_MIN)).toBe(true);
  });

  it('gives the same ids for the same input', () => {
    const input = { documents: [doc(), doc({ key: 'k2', date: '2026-12-05' })], maintenance: [item()], now: NOW };
    const a = buildExtraReminderPlans(input).map((plan) => plan.notificationId);
    const b = buildExtraReminderPlans(input).map((plan) => plan.notificationId);
    expect(a).toEqual(b);
    const docPlan = buildExtraReminderPlans({ documents: [doc()], maintenance: [], now: NOW })[0];
    expect(docPlan.notificationId).toBe(extraNotificationId('doc:k1:2026-12-01'));
  });

  it('resolves hash collisions deterministically', () => {
    // Find two keys whose hashes collide by brute force over a small key space.
    const byId = new Map<number, string>();
    let pair: [string, string] | null = null;
    for (let i = 0; i < 400_000 && !pair; i++) {
      const key = `doc:c${i}:2026-12-01`;
      const id = extraNotificationId(key);
      const other = byId.get(id);
      if (other) pair = [other, key];
      else byId.set(id, key);
    }
    expect(pair).not.toBeNull();
    const [first, second] = pair!.map((key) => key.split(':')[1]);
    const documents = [doc({ key: second }), doc({ key: first })];
    const plans = buildExtraReminderPlans({ documents, maintenance: [], now: NOW });
    expect(plans).toHaveLength(2);
    expect(plans[0].notificationId).not.toBe(plans[1].notificationId);
    const again = buildExtraReminderPlans({ documents: [...documents].reverse(), maintenance: [], now: NOW });
    expect(again.map((plan) => plan.notificationId)).toEqual(plans.map((plan) => plan.notificationId));
    const shared = extraNotificationId(`doc:${first}:2026-12-01`);
    const expectedNext = shared <= EXTRA_ID_MIN ? -1 : shared - 1;
    expect(new Set(plans.map((plan) => plan.notificationId))).toEqual(new Set([shared, expectedNext]));
  });

  it('returns nothing for an invalid clock', () => {
    expect(buildExtraReminderPlans({ documents: [doc()], maintenance: [item()], now: new Date(NaN) })).toEqual([]);
  });
});
