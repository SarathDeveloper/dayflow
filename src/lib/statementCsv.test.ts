import { describe, expect, it } from 'vitest';
import type { FinanceTransaction } from '../types';
import {
  detectColumns,
  financialYearLabel,
  financialYearOf,
  financialYearRange,
  findDuplicates,
  parseCsv,
  parseStatementAmount,
  parseStatementDate,
  readStatementRows,
  suggestCategory,
  transactionsCsv,
} from './statementCsv';

const STAMP = '2026-11-01T00:00:00.000Z';
const tx = (over: Partial<FinanceTransaction>): FinanceTransaction => ({
  id: 'tx',
  type: 'expense',
  amount: 100,
  category: 'Food & Dining',
  date: '2026-11-10',
  recurrence: { type: 'none' },
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
});

describe('financial year', () => {
  it('runs from April to March', () => {
    expect(financialYearOf('2026-03-31')).toBe(2025);
    expect(financialYearOf('2026-04-01')).toBe(2026);
    expect(financialYearRange(2026)).toEqual({ from: '2026-04-01', to: '2027-03-31' });
    expect(financialYearLabel(2026)).toBe('FY 2026-27');
    expect(financialYearLabel(2099)).toBe('FY 2099-00');
  });
});

describe('CSV export', () => {
  it('writes entries oldest first, safe for spreadsheets, with what they count as', () => {
    const csv = transactionsCsv(
      [
        tx({ id: 'b', date: '2026-11-12', note: '=SUM(A1)', accountId: 'a1' }),
        tx({ id: 'a', date: '2026-11-01', type: 'income', category: 'Salary', amount: 50000, accountId: 'a1', note: 'Nov, salary' }),
        tx({ id: 'c', date: '2026-11-13', category: 'Lent', debtRole: 'lent', accountId: 'a1' }),
      ],
      [{ id: 'a1', name: 'YesBank' }]
    );
    const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Date,Time,Type,Category,Amount,Account,To account,Payment,Note,Counts as');
    expect(lines[1]).toBe('2026-11-01,,income,Salary,50000.00,YesBank,,,"Nov, salary",Income');
    expect(lines[2]).toContain("'=SUM(A1)");
    expect(lines[3].endsWith('Not counted')).toBe(true);
  });
});

describe('statement import', () => {
  const hdfc = [
    'HDFC BANK',
    'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
    '01/11/26,"UPI-SWIGGY-swiggy@icici-123",0000123,01/11/26,"1,250.00",,"48,750.00"',
    '02/11/26,SALARY NOV,,02/11/26,,"55,000.00","1,03,750.00"',
    '03/11/26,UPI-BHARAT PETROL-456,,03/11/26,500.00,,"1,03,250.00"',
    'Opening balance,,,,,,',
  ].join('\n');

  it('parses quoted CSV', () => {
    expect(parseCsv('a,"b, c","d ""q"""\r\n\r\n1,2,3')).toEqual([['a', 'b, c', 'd "q"'], ['1', '2', '3']]);
  });

  it('reads dates and amounts the way Indian statements write them', () => {
    expect(parseStatementDate('20/11/2026')).toBe('2026-11-20');
    expect(parseStatementDate('20-11-26')).toBe('2026-11-20');
    expect(parseStatementDate('20 Nov 2026')).toBe('2026-11-20');
    expect(parseStatementDate('20-Nov-2026 10:15')).toBe('2026-11-20');
    expect(parseStatementDate('31/02/2026')).toBeNull();
    expect(parseStatementAmount('1,23,456.50')).toBe(123456.5);
    expect(parseStatementAmount('500.00 Dr')).toBe(-500);
    expect(parseStatementAmount('(250)')).toBe(-250);
    expect(parseStatementAmount('')).toBeNull();
  });

  it('finds the header and reads debit / credit rows, skipping summary lines', () => {
    const rows = parseCsv(hdfc);
    const detected = detectColumns(rows);
    expect(detected?.headerRow).toBe(1);
    const read = readStatementRows(rows, detected!.headerRow, detected!.columns);
    expect(read.map((r) => [r.date, r.type, r.amount])).toEqual([
      ['2026-11-01', 'expense', 1250],
      ['2026-11-02', 'income', 55000],
      ['2026-11-03', 'expense', 500],
    ]);
  });

  it('reads a single signed amount column with a Dr/Cr marker', () => {
    const rows = parseCsv('Txn Date,Description,Amount,Dr/Cr\n05-11-2026,ATM CASH,2000,DR\n06-11-2026,INTEREST,12.5,CR');
    const detected = detectColumns(rows)!;
    expect(readStatementRows(rows, detected.headerRow, detected.columns).map((r) => [r.type, r.amount])).toEqual([
      ['expense', 2000],
      ['income', 12.5],
    ]);
  });

  it('marks rows already in the ledger, each entry matching once', () => {
    const rows = [
      { line: 3, date: '2026-11-01', description: 'a', type: 'expense' as const, amount: 1250 },
      { line: 4, date: '2026-11-01', description: 'b', type: 'expense' as const, amount: 1250 },
    ];
    const dups = findDuplicates(rows, [tx({ date: '2026-11-01', amount: 1250, accountId: 'bank' })], 'bank');
    expect([...dups]).toEqual([3]);
    expect(findDuplicates(rows, [tx({ date: '2026-11-01', amount: 1250, accountId: 'other' })], 'bank').size).toBe(0);
  });

  it('suggests a category from history first, then from keywords', () => {
    const known = { income: ['Salary', 'Other'], expense: ['Food & Dining', 'Petrol', 'Other'] };
    const history = [tx({ note: 'UPI-SWIGGY-swiggy@icici-999', category: 'Food & Dining', type: 'expense' })];
    expect(suggestCategory({ description: 'UPI-SWIGGY-swiggy@icici-123', type: 'expense' }, history, known)).toBe('Food & Dining');
    expect(suggestCategory({ description: 'UPI-BHARAT PETROL-456', type: 'expense' }, [], known)).toBe('Petrol');
    expect(suggestCategory({ description: 'SALARY NOV', type: 'income' }, [], known)).toBe('Salary');
    expect(suggestCategory({ description: 'Something new', type: 'expense' }, [], known)).toBe('Other');
  });
});
