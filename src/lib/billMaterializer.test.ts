import { afterAll, describe, expect, it } from 'vitest';
import { materializeBillPayments } from './billMaterializer';
import type { BillTemplate } from '../types';

// India is east of UTC: early on the 1st, the UTC timestamp is still last month.
const originalTz = process.env.TZ;
process.env.TZ = 'Asia/Kolkata';
afterAll(() => {
  process.env.TZ = originalTz;
});

const template = (createdAt: string): BillTemplate => ({
  id: 'bill-1',
  name: 'Internet',
  amount: 799,
  category: 'Bills',
  dueDayOfMonth: 5,
  active: true,
  createdAt,
  updatedAt: createdAt,
});

describe('materializeBillPayments', () => {
  it('starts from the local month a template was created in', () => {
    // 1 Dec 2026, 02:00 India time.
    const createdAt = new Date(2026, 11, 1, 2, 0).toISOString();
    expect(createdAt.startsWith('2026-11-30')).toBe(true);

    const { payments } = materializeBillPayments([template(createdAt)], [], '2026-12');
    expect(payments.map((p) => p.month)).toEqual(['2026-12']);
  });

  it('creates one unpaid payment per month up to the current month', () => {
    const { payments } = materializeBillPayments([template('2026-09-15T10:00:00.000Z')], [], '2026-11');
    expect(payments.map((p) => p.month).sort()).toEqual(['2026-09', '2026-10', '2026-11']);
    expect(payments.every((p) => !p.paid)).toBe(true);
  });
});
