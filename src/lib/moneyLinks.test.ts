import { describe, expect, it } from 'vitest';
import type { BillPayment, BillTemplate, Debt, FinanceTransaction } from '../types';
import {
  addDebtPayment, countsAsIncome, countsAsSpending, debtOpeningDraft, debtPaymentDraft, debtTransactionIds, emiBillChanged,
  emiBillTemplate, linkBillPayment, matchBillForExpense, relinkRestoredTransactions, reopenDebt, syncEditedTransaction,
  unlinkDeletedTransactions,
} from './moneyLinks';
import { materializeBillPayments } from './billMaterializer';
import { unpaidBills } from './moneyForecast';
import { summarize } from './ledger';

const stamp = '2026-11-18T10:00:00.000Z';
const debt = (extra: Partial<Debt> = {}): Debt => ({
  id: 'd1', direction: 'owed', personName: 'Ravi', amount: 10000, date: '2026-11-01', paid: false,
  createdAt: stamp, updatedAt: stamp, ...extra,
});
const tx = (extra: Partial<FinanceTransaction>): FinanceTransaction => ({
  id: 't1', type: 'expense', amount: 100, category: 'Food & Dining', date: '2026-11-18',
  recurrence: { type: 'none' }, createdAt: stamp, updatedAt: stamp, ...extra,
});
const template = (extra: Partial<BillTemplate> = {}): BillTemplate => ({
  id: 'eb', name: 'Electricity', amount: 1800, category: 'Bills & Utilities', dueDayOfMonth: 25, active: true,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: stamp, ...extra,
});
const payment = (extra: Partial<BillPayment> = {}): BillPayment => ({
  id: 'p-eb', billId: 'eb', month: '2026-11', amount: 1800, dueDate: '2026-11-25', paid: false,
  createdAt: stamp, updatedAt: stamp, ...extra,
});

describe('what counts as income and spending', () => {
  it('leaves borrowed, lent, repaid and received money out, keeps EMIs', () => {
    expect(countsAsIncome(tx({ type: 'income', debtRole: 'borrowed' }))).toBe(false);
    expect(countsAsIncome(tx({ type: 'income', debtRole: 'received' }))).toBe(false);
    expect(countsAsSpending(tx({ debtRole: 'lent' }))).toBe(false);
    expect(countsAsSpending(tx({ debtRole: 'repaid' }))).toBe(false);
    expect(countsAsSpending(tx({ debtRole: 'emi' }))).toBe(true);
    expect(countsAsIncome(tx({ type: 'income' }))).toBe(true);
    const totals = summarize([
      tx({ type: 'income', amount: 50000, category: 'Salary' }),
      tx({ id: 't2', type: 'income', amount: 10000, debtRole: 'borrowed' }),
      tx({ id: 't3', amount: 2000 }),
      tx({ id: 't4', amount: 3000, debtRole: 'repaid' }),
    ], { from: '2026-11-01', to: '2026-11-30' });
    expect(totals).toMatchObject({ incomePaise: 5000000, expensePaise: 200000 });
    // The ledger list shows cash flow: every movement of money counts there.
    const cash = summarize([
      tx({ type: 'income', amount: 10000, debtRole: 'borrowed' }),
      tx({ id: 't4', amount: 3000, debtRole: 'repaid' }),
    ], { from: '2026-11-01', to: '2026-11-30' }, { cashFlow: true });
    expect(cash).toMatchObject({ incomePaise: 1000000, expensePaise: 300000 });
  });
});

describe('debt ledger entries', () => {
  it('borrowing brings money in, lending sends it out; repaying is the reverse', () => {
    expect(debtOpeningDraft(debt(), { accountId: 'bank' })).toMatchObject({ type: 'income', amount: 10000, debtRole: 'borrowed', category: 'Borrowed', note: 'Borrowed from Ravi', date: '2026-11-01' });
    expect(debtOpeningDraft(debt({ direction: 'lent' }), { accountId: 'bank' })).toMatchObject({ type: 'expense', debtRole: 'lent' });
    expect(debtPaymentDraft(debt(), 2500, '2026-11-20', { accountId: 'bank' })).toMatchObject({ type: 'expense', debtRole: 'repaid', amount: 2500 });
    expect(debtPaymentDraft(debt({ direction: 'lent' }), 2500, '2026-11-20', { accountId: 'bank' })).toMatchObject({ type: 'income', debtRole: 'received' });
  });

  it('marks a debt paid when payments cover it, and reopens it on untick', () => {
    let d = addDebtPayment(debt(), { id: 'a', date: '2026-11-10', amount: 4000 }, stamp);
    expect(d.paid).toBe(false);
    d = addDebtPayment(d, { id: 'b', date: '2026-11-15', amount: 6000, transactionId: 'tx-b', settles: true }, stamp);
    expect(d.paid).toBe(true);
    const reopened = reopenDebt(d, stamp);
    expect(reopened.debt.paid).toBe(false);
    expect(reopened.debt.payments?.map((p) => p.id)).toEqual(['a']);
    expect(reopened.removedTransactionIds).toEqual(['tx-b']);
  });

  it('finds every ledger entry of a debt', () => {
    const d = debt({ transactionId: 'open', payments: [{ id: 'p', date: '2026-11-10', amount: 100, transactionId: 'pay' }] });
    const list = [tx({ id: 'open' }), tx({ id: 'pay' }), tx({ id: 'emi', debtId: 'd1', debtRole: 'emi' }), tx({ id: 'other' })];
    expect(debtTransactionIds(d, list).sort()).toEqual(['emi', 'open', 'pay']);
  });
});

describe('loan EMIs as bills', () => {
  const loan = debt({ amount: 120000, loan: { annualRate: 0, tenureMonths: 12, firstEmiDate: '2026-06-05' }, accountId: 'bank' });

  it('builds one EMI bill per loan you owe, only within the loan months', () => {
    const bill = emiBillTemplate(loan, undefined, stamp)!;
    expect(bill).toMatchObject({ id: 'bill-emi-d1', amount: 10000, dueDayOfMonth: 5, startMonth: '2026-06', endMonth: '2027-05', debtId: 'd1', accountId: 'bank', active: true });
    expect(emiBillTemplate(debt(), undefined, stamp)).toBeNull();
    expect(emiBillTemplate({ ...loan, direction: 'lent' }, undefined, stamp)).toBeNull();
    expect(emiBillTemplate({ ...loan, paid: true }, bill, stamp)?.active).toBe(false);
    expect(emiBillChanged(bill, bill)).toBe(false);
    expect(emiBillChanged({ ...bill, amount: 1 }, bill)).toBe(true);
  });

  it('does not create bills for months before the app knew the loan, or after it ends', () => {
    const bill = { ...emiBillTemplate(loan, undefined, stamp)!, createdAt: '2026-11-18T10:00:00.000Z' };
    const created = materializeBillPayments([bill], [], '2026-11').created;
    expect(created.map((p) => p.month)).toEqual(['2026-11']);
    expect(materializeBillPayments([bill], [], '2027-08').created.map((p) => p.month).at(-1)).toBe('2027-05');
    expect(unpaidBills('2027-07', '2027-07-01', [bill], [])).toEqual([]);
  });
});

describe('bills paid from the ledger', () => {
  it('matches by name in the note, or by category and close amount near the due date', () => {
    const templates = [template()];
    expect(matchBillForExpense(tx({ amount: 1750, note: 'TNEB electricity' }), templates, [payment()])?.template.id).toBe('eb');
    expect(matchBillForExpense(tx({ amount: 1900, category: 'Bills & Utilities' }), templates, [payment()])?.payment.id).toBe('p-eb');
    expect(matchBillForExpense(tx({ amount: 900, category: 'Bills & Utilities' }), templates, [payment()])).toBeNull();
    expect(matchBillForExpense(tx({ amount: 1800, category: 'Bills & Utilities', date: '2026-10-01' }), templates, [payment()])).toBeNull();
    expect(matchBillForExpense(tx({ amount: 1800, note: 'electricity' }), templates, [payment({ paid: true })])).toBeNull();
    expect(matchBillForExpense(tx({ amount: 1800, note: 'electricity', billPaymentId: 'x' }), templates, [payment()])).toBeNull();
  });

  it('links both ways and takes the amount actually paid', () => {
    const linked = linkBillPayment(payment(), tx({ id: 'paid', amount: 1750 }), stamp);
    expect(linked.payment).toMatchObject({ paid: true, transactionId: 'paid', amount: 1750, updatedAt: stamp });
    expect(linked.transaction.billPaymentId).toBe('p-eb');
  });
});

describe('keeping both sides in step', () => {
  it('a deleted entry makes its bill unpaid and takes its payment off the debt', () => {
    const debts = [debt({
      paid: true, transactionId: 'open',
      payments: [{ id: 'a', date: '2026-11-10', amount: 4000 }, { id: 'b', date: '2026-11-12', amount: 6000, transactionId: 'pay' }],
    })];
    const result = unlinkDeletedTransactions(['bill-tx', 'pay', 'open'], [payment({ paid: true, transactionId: 'bill-tx' })], debts, stamp);
    expect(result.changed).toBe(true);
    expect(result.billPayments[0]).toMatchObject({ paid: false, transactionId: undefined });
    expect(result.debts[0]).toMatchObject({ paid: false, transactionId: undefined });
    expect(result.debts[0].payments?.map((p) => p.id)).toEqual(['a']);
    expect(unlinkDeletedTransactions(['unrelated'], [payment()], debts, stamp).changed).toBe(false);
  });

  it('undo restores the links', () => {
    const restored = [
      tx({ id: 'bill-tx', amount: 1800, billPaymentId: 'p-eb' }),
      tx({ id: 'pay', amount: 6000, debtId: 'd1', debtRole: 'repaid' }),
      tx({ id: 'open', type: 'income', amount: 10000, debtId: 'd1', debtRole: 'borrowed', accountId: 'bank' }),
    ];
    const result = relinkRestoredTransactions(restored, [payment()], [debt({ payments: [{ id: 'a', date: '2026-11-10', amount: 4000 }] })], stamp);
    expect(result.billPayments[0]).toMatchObject({ paid: true, transactionId: 'bill-tx' });
    expect(result.debts[0]).toMatchObject({ transactionId: 'open', accountId: 'bank', paid: true });
  });

  it('an edited entry updates the bill amount, the debt payment and the borrowed amount', () => {
    const debts = [
      debt({ transactionId: 'open' }),
      debt({ id: 'd2', payments: [{ id: 'p', date: '2026-11-10', amount: 500, transactionId: 'pay' }] }),
    ];
    const bills = [payment({ paid: true, transactionId: 'bill-tx' })];
    expect(syncEditedTransaction(tx({ id: 'bill-tx', amount: 1650 }), bills, debts, stamp).billPayments[0].amount).toBe(1650);
    expect(syncEditedTransaction(tx({ id: 'open', amount: 12000, date: '2026-11-02', accountId: 'cash' }), bills, debts, stamp).debts[0])
      .toMatchObject({ amount: 12000, date: '2026-11-02', accountId: 'cash' });
    expect(syncEditedTransaction(tx({ id: 'pay', amount: 700, date: '2026-11-11' }), bills, debts, stamp).debts[1].payments?.[0])
      .toMatchObject({ amount: 700, date: '2026-11-11' });
    expect(syncEditedTransaction(tx({ id: 'nothing' }), bills, debts, stamp).changed).toBe(false);
  });
});
