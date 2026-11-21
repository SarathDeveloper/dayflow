import { describe, expect, it } from 'vitest';
import type { BucketItem } from '../types';
import {
  bucketIdFromRoute,
  bucketReminderAnchor,
  bucketRoute,
  bucketSummary,
  bucketTargetDate,
  bucketTargetLabel,
  goalDraftFor,
  groupByCategory,
  markBucketDone,
  moneyGoalDraftFor,
  reopenBucketItem,
  sortDoneItems,
  sortOpenItems,
  unlinkMissingGoals,
  validateBucketDraft,
} from './bucketList';
import { buildExtraReminderPlans } from './extraReminders';

const STAMP = '2026-11-01T00:00:00.000Z';
const item = (over: Partial<BucketItem> = {}): BucketItem => ({
  id: 'b1',
  title: 'See Ladakh',
  category: 'travel',
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
});

describe('bucket list drafts', () => {
  it('needs a name and a known category', () => {
    expect(validateBucketDraft({ title: '  ', category: 'travel' }, '2026-11-21', true)).toBe('Give it a name.');
    expect(validateBucketDraft({ title: 'Laptop', category: 'gadgets' }, '2026-11-21', true)).toBe('Choose a category.');
    expect(validateBucketDraft({ title: 'Laptop', category: 'buy', cost: 80000 }, '2026-11-21', true)).toBeNull();
  });

  it('refuses a negative cost and a bad date', () => {
    expect(validateBucketDraft({ title: 'Bag', category: 'buy', cost: -1 }, '2026-11-21', true)).toBe('Cost must be zero or more.');
    expect(
      validateBucketDraft({ title: 'Trip', category: 'travel', target: { kind: 'date', date: '2027-02-29' } }, '2026-11-21', true)
    ).toBe('Choose a valid date.');
  });

  it('refuses a past target only for new items', () => {
    const past = { title: 'Trip', category: 'travel', target: { kind: 'date' as const, date: '2026-11-20' } };
    expect(validateBucketDraft(past, '2026-11-21', true)).toBe('Pick a date that is still ahead.');
    expect(validateBucketDraft(past, '2026-11-21', false)).toBeNull();
    expect(validateBucketDraft({ title: 'Trip', category: 'travel', target: { kind: 'year', year: 2026 } }, '2026-11-21', true)).toBeNull();
  });
});

describe('bucket list targets', () => {
  it('treats a year as due on Dec 31 and reminds from Dec 1', () => {
    expect(bucketTargetDate({ kind: 'year', year: 2028 })).toBe('2028-12-31');
    expect(bucketReminderAnchor({ kind: 'year', year: 2028 })).toBe('2028-12-01');
    expect(bucketTargetDate({ kind: 'date', date: '2027-05-04' })).toBe('2027-05-04');
    expect(bucketTargetDate(undefined)).toBeNull();
  });

  it('labels targets in plain words', () => {
    const today = '2026-11-21';
    expect(bucketTargetLabel({ kind: 'year', year: 2028 }, today)).toBe('by 2028');
    expect(bucketTargetLabel({ kind: 'year', year: 2026 }, today)).toBe('this year');
    expect(bucketTargetLabel({ kind: 'date', date: '2026-11-21' }, today)).toBe('today');
    expect(bucketTargetLabel({ kind: 'date', date: '2026-12-01' }, today)).toBe('in 10 days');
    expect(bucketTargetLabel({ kind: 'date', date: '2026-11-19' }, today)).toBe('2 days late');
  });
});

describe('bucket list lists', () => {
  const items = [
    item({ id: 'a', target: { kind: 'year', year: 2030 } }),
    item({ id: 'b', category: 'buy', target: { kind: 'date', date: '2027-01-10' } }),
    item({ id: 'c', createdAt: '2026-11-05T00:00:00.000Z' }),
    item({ id: 'd', doneOn: '2026-10-01' }),
    item({ id: 'e', doneOn: '2026-11-01', category: 'food' }),
  ];

  it('sorts open items soonest first, undated last', () => {
    expect(sortOpenItems(items).map((i) => i.id)).toEqual(['b', 'a', 'c']);
    expect(sortDoneItems(items).map((i) => i.id)).toEqual(['e', 'd']);
  });

  it('groups by category in a fixed order', () => {
    expect(groupByCategory(sortOpenItems(items)).map((g) => [g.category, g.items.map((i) => i.id)])).toEqual([
      ['travel', ['a', 'c']],
      ['buy', ['b']],
    ]);
  });

  it('adds open costs in paise', () => {
    const s = bucketSummary([item({ id: 'x', cost: 0.1 }), item({ id: 'y', cost: 0.2 }), item({ id: 'z', cost: 500, doneOn: '2026-11-01' })]);
    expect(s).toEqual({ total: 3, done: 1, open: 2, openCost: 0.3 });
  });
});

describe('ticking items off', () => {
  it('stamps updatedAt and keeps the memory when reopened', () => {
    const done = markBucketDone(item(), { doneOn: '2026-11-21', memory: '  Snow!  ' }, '2026-11-21T10:00:00.000Z');
    expect(done).toMatchObject({ doneOn: '2026-11-21', memory: 'Snow!', updatedAt: '2026-11-21T10:00:00.000Z' });
    const open = reopenBucketItem(done, '2026-11-22T10:00:00.000Z');
    expect(open.doneOn).toBeUndefined();
    expect(open.memory).toBe('Snow!');
    expect(open.updatedAt).toBe('2026-11-22T10:00:00.000Z');
  });
});

describe('links to goals', () => {
  it('builds a savings goal from the cost and due day', () => {
    expect(moneyGoalDraftFor(item({ title: ' Laptop ', cost: 80000, target: { kind: 'year', year: 2027 } }))).toEqual({
      name: 'Laptop',
      target: 80000,
      targetDate: '2027-12-31',
    });
  });

  it('builds a goal due a year out when there is no target', () => {
    expect(goalDraftFor(item(), '2026-11-21')).toMatchObject({ title: 'See Ladakh', startDate: '2026-11-21', targetDate: '2027-11-21' });
    expect(goalDraftFor(item(), '2028-02-29').targetDate).toBe('2029-02-28');
    expect(goalDraftFor(item({ target: { kind: 'date', date: '2027-04-01' } }), '2026-11-21').targetDate).toBe('2027-04-01');
  });

  it('clears links to deleted goals and stamps only those items', () => {
    const list = [item({ id: 'a', moneyGoalId: 'm1', goalId: 'g1' }), item({ id: 'b', moneyGoalId: 'm2' })];
    const next = unlinkMissingGoals(list, new Set(['m2']), new Set(['g1']), 'NOW');
    expect(next[0]).toMatchObject({ moneyGoalId: undefined, goalId: 'g1', updatedAt: 'NOW' });
    expect(next[1]).toBe(list[1]);
    expect(unlinkMissingGoals(list, new Set(['m1', 'm2']), new Set(['g1']), 'NOW')).toBe(list);
  });
});

describe('bucket reminders', () => {
  it('round-trips the route', () => {
    expect(bucketIdFromRoute(bucketRoute('b1'))).toBe('b1');
    expect(bucketIdFromRoute('maintenance:x')).toBeNull();
  });

  it('schedules 30 and 7 days before, negative ids, open items with reminders on only', () => {
    const plans = buildExtraReminderPlans({
      documents: [],
      maintenance: [],
      bucket: [
        item({ id: 'go', remind: true, target: { kind: 'date', date: '2027-01-31' } }),
        item({ id: 'off', target: { kind: 'date', date: '2027-01-31' } }),
        item({ id: 'done', remind: true, doneOn: '2026-11-20', target: { kind: 'date', date: '2027-01-31' } }),
        item({ id: 'undated', remind: true }),
      ],
      now: new Date(2026, 10, 21, 12),
    });
    expect(plans.map((p) => p.route)).toEqual(['bucket:go', 'bucket:go']);
    expect(plans.map((p) => p.fireAt.getDate())).toEqual([1, 24]);
    expect(plans.every((p) => p.notificationId < 0)).toBe(true);
    expect(plans[0].body).toBe('See Ladakh: 30 days to go. Still on for it?');
  });
});
