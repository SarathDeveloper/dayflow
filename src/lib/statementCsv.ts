/**
 * CSV in and out of the Money ledger. Pure.
 *
 * Out: any list of entries as a spreadsheet-safe CSV, and the Indian financial
 * year (1 April to 31 March) as a range.
 *
 * In: a bank statement CSV (the Play-safe stand-in for reading bank SMS). The
 * columns are guessed from the header (date, description, debit / credit or one
 * signed amount), rows already in the ledger are marked as duplicates, and each
 * row gets a suggested category from its words and from the user's history.
 */
import type { Account, FinanceTransaction } from '../types';
import { countsAsIncome, countsAsSpending } from './moneyLinks';
import { fromPaise, toPaise } from './money';

// ---------------------------------------------------------------------------
// Financial year
// ---------------------------------------------------------------------------

/** The financial year a date falls in, named by its starting year (2026 = FY 2026-27). */
export function financialYearOf(date: string): number {
  const [y, m] = date.split('-').map(Number);
  return m >= 4 ? y : y - 1;
}

export function financialYearRange(startYear: number): { from: string; to: string } {
  return { from: `${startYear}-04-01`, to: `${startYear + 1}-03-31` };
}

/** "FY 2026-27". */
export function financialYearLabel(startYear: number): string {
  return `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function csvCell(value: string | number | undefined): string {
  const text = value === undefined || value === null ? '' : String(value);
  // A leading = + - @ would run as a formula in Excel or Sheets.
  const safe = /^[=+\-@]/.test(text) && typeof value === 'string' ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Entries as CSV, oldest first, with account names; "Counts as" says what totals include it. */
export function transactionsCsv(
  transactions: FinanceTransaction[],
  accounts: Pick<Account, 'id' | 'name'>[]
): string {
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  const name = (id?: string) => (id ? names.get(id) ?? '' : '');
  const rows = [...transactions].sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? '') || a.createdAt.localeCompare(b.createdAt)
  );
  const header = ['Date', 'Time', 'Type', 'Category', 'Amount', 'Account', 'To account', 'Payment', 'Note', 'Counts as'];
  const lines = [header.join(',')];
  for (const tx of rows) {
    const countsAs = countsAsSpending(tx) ? 'Spending' : countsAsIncome(tx) ? 'Income' : tx.type === 'transfer' ? 'Transfer' : 'Not counted';
    lines.push(
      [
        tx.date,
        tx.time,
        tx.type,
        tx.category,
        fromPaise(toPaise(tx.amount)).toFixed(2),
        name(tx.accountId),
        name(tx.destinationAccountId),
        tx.paymentMethod,
        tx.note,
        countsAs,
      ]
        .map(csvCell)
        .join(',')
    );
  }
  // CRLF and a BOM so Excel opens it as UTF-8 with rows intact.
  return `﻿${lines.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** Rows of a CSV (quoted fields, "" escapes, CRLF or LF). Blank lines are dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const input = text.replace(/^﻿/, '');
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

export interface ColumnMap {
  date: number;
  description: number;
  /** Money out and money in in separate columns (most Indian banks)... */
  debit?: number;
  credit?: number;
  /** ...or one amount column, negative or marked Dr for money out. */
  amount?: number;
  /** A separate Dr / Cr column next to a single amount. */
  drCr?: number;
}

const has = (cell: string, words: RegExp) => words.test(cell.trim().toLowerCase());

/** The header row (first row with a date-like and an amount-like column) and its columns, or null. */
export function detectColumns(rows: string[][]): { headerRow: number; columns: ColumnMap } | null {
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const cells = rows[r];
    const find = (words: RegExp, skip: number[] = []) => cells.findIndex((c, i) => !skip.includes(i) && has(c, words));
    const date = find(/^(txn |transaction |value |tran )?date|^date/);
    if (date < 0) continue;
    const description = find(/narration|description|particulars|details|remarks|transaction details/);
    const debit = find(/withdrawal|debit|dr\.? amount|^dr$|money out|paid out/);
    const credit = find(/deposit|credit|cr\.? amount|^cr$|money in|paid in/);
    const amount = find(/^amount|amount \(inr\)|^amt/, [debit, credit]);
    const drCr = find(/^(dr ?\/ ?cr|cr ?\/ ?dr|type)$/);
    if (debit >= 0 && credit >= 0) {
      return { headerRow: r, columns: { date, description: description >= 0 ? description : date, debit, credit } };
    }
    if (amount >= 0) {
      return {
        headerRow: r,
        columns: { date, description: description >= 0 ? description : date, amount, drCr: drCr >= 0 ? drCr : undefined },
      };
    }
  }
  return null;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** A statement date as local YYYY-MM-DD: 20/11/2026, 20-11-26, 20 Nov 2026, 20-Nov-2026, 2026-11-20. Day first. */
export function parseStatementDate(value: string): string | null {
  const text = value.trim().split(/\s+\d{1,2}:\d{2}/)[0].trim();
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (match) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(text))) {
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = /^(\d{1,2})[\s/-]([A-Za-z]{3})[A-Za-z]*[\s/-](\d{2}|\d{4})$/.exec(text))) {
    d = Number(match[1]);
    m = MONTHS[match[2].toLowerCase()] ?? 0;
    y = Number(match[3]);
  } else return null;
  if (y < 100) y += 2000;
  const probe = new Date(y, m - 1, d);
  if (!m || probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** "1,23,456.50", "(500)", "500.00 Dr", "-500" as signed rupees (negative = money out), or null. */
export function parseStatementAmount(value: string): number | null {
  let text = value.trim();
  if (!text || text === '-') return null;
  let sign = 1;
  if (/\bdr\.?$/i.test(text)) {
    sign = -1;
    text = text.replace(/\s*dr\.?$/i, '');
  } else if (/\bcr\.?$/i.test(text)) text = text.replace(/\s*cr\.?$/i, '');
  if (/^\(.*\)$/.test(text)) {
    sign = -sign;
    text = text.slice(1, -1);
  }
  text = text.replace(/[₹,\s]|INR|Rs\.?/gi, '');
  if (text.startsWith('-')) {
    sign = -sign;
    text = text.slice(1);
  }
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const rupees = Number(text);
  return rupees === 0 ? null : sign * rupees;
}

export interface StatementRow {
  /** Position in the file, for keys. */
  line: number;
  date: string;
  description: string;
  type: 'income' | 'expense';
  amount: number;
}

/** Statement rows that have a real date and a non-zero amount. */
export function readStatementRows(rows: string[][], headerRow: number, columns: ColumnMap): StatementRow[] {
  const out: StatementRow[] = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const cells = rows[r];
    const date = parseStatementDate(cells[columns.date] ?? '');
    if (!date) continue;
    let signed: number | null = null;
    if (columns.debit !== undefined && columns.credit !== undefined) {
      const out = parseStatementAmount(cells[columns.debit] ?? '');
      const inn = parseStatementAmount(cells[columns.credit] ?? '');
      signed = out ? -Math.abs(out) : inn ? Math.abs(inn) : null;
    } else if (columns.amount !== undefined) {
      signed = parseStatementAmount(cells[columns.amount] ?? '');
      const marker = columns.drCr !== undefined ? (cells[columns.drCr] ?? '').trim().toLowerCase() : '';
      if (signed !== null && marker.startsWith('d')) signed = -Math.abs(signed);
      if (signed !== null && marker.startsWith('c')) signed = Math.abs(signed);
    }
    if (signed === null) continue;
    out.push({
      line: r + 1,
      date,
      description: (cells[columns.description] ?? '').replace(/\s+/g, ' ').trim(),
      type: signed < 0 ? 'expense' : 'income',
      amount: fromPaise(Math.abs(toPaise(signed))),
    });
  }
  return out;
}

/** Keys of statement rows that are already in the ledger: same account, date, type and amount (each entry matches once). */
export function findDuplicates(rows: StatementRow[], transactions: FinanceTransaction[], accountId: string): Set<number> {
  const pool = new Map<string, number>();
  const key = (date: string, type: string, paise: number) => `${date}|${type}|${paise}`;
  for (const tx of transactions) {
    let type: string | null = null;
    if (tx.accountId === accountId && (tx.type === 'income' || tx.type === 'expense')) type = tx.type;
    else if (tx.type === 'transfer' && tx.accountId === accountId) type = 'expense';
    else if (tx.type === 'transfer' && tx.destinationAccountId === accountId) type = 'income';
    if (!type) continue;
    const k = key(tx.date, type, toPaise(tx.amount));
    pool.set(k, (pool.get(k) ?? 0) + 1);
  }
  const duplicates = new Set<number>();
  for (const row of rows) {
    const k = key(row.date, row.type, toPaise(row.amount));
    const left = pool.get(k) ?? 0;
    if (left > 0) {
      duplicates.add(row.line);
      pool.set(k, left - 1);
    }
  }
  return duplicates;
}

const KEYWORDS: [RegExp, string, 'income' | 'expense'][] = [
  [/salary|sal cr|payroll/, 'Salary', 'income'],
  [/interest|int\.? ?(pd|cr)/, 'Interest', 'income'],
  [/refund|reversal|cashback/, 'Refund', 'income'],
  [/swiggy|zomato|restaurant|cafe|hotel|food|dominos|mcdonald|kfc/, 'Food & Dining', 'expense'],
  [/bigbasket|blinkit|zepto|dmart|grocer|supermarket|instamart/, 'Groceries', 'expense'],
  [/uber|ola|rapido|irctc|metro|fastag|redbus/, 'Transport', 'expense'],
  [/petrol|fuel|hpcl|bpcl|iocl|indian oil|bharat petrol|shell/, 'Petrol', 'expense'],
  [/amazon|flipkart|myntra|ajio|meesho|nykaa/, 'Shopping', 'expense'],
  [/electricity|bescom|tneb|tangedco|msedcl|water bill|gas bill|broadband|airtel|jio|vodafone|\bvi\b|recharge|dth/, 'Bills & Utilities', 'expense'],
  [/pharmacy|apollo|medplus|hospital|clinic|medical|1mg|pharmeasy/, 'Medical', 'expense'],
  [/netflix|hotstar|spotify|prime video|youtube premium|bookmyshow/, 'Entertainment', 'expense'],
  [/\brent\b/, 'Rent', 'expense'],
  [/\bemi\b|loan/, 'Loan EMI', 'expense'],
  [/atm|cash wdl|cash withdrawal/, 'Cash withdrawal', 'expense'],
];

/** A short version of a statement description for matching (drops UPI ids, refs, digits). */
export function descriptionKey(description: string): string {
  return description
    .toLowerCase()
    .replace(/upi[/-]?|imps[/-]?|neft[/-]?|rtgs[/-]?|pos[/-]?|ach[/-]?/g, ' ')
    .replace(/[a-z0-9._-]+@[a-z]+/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^a-z]+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word.length > 2)
    .slice(0, 3)
    .join(' ');
}

/**
 * Category for an imported row: the category of an earlier entry whose note
 * looks the same, else a keyword match, else Other. Only names the user has
 * (`known`) are suggested, so the row saves without a new category.
 */
export function suggestCategory(
  row: Pick<StatementRow, 'description' | 'type'>,
  history: FinanceTransaction[],
  known: { income: string[]; expense: string[] }
): string {
  const options = row.type === 'income' ? known.income : known.expense;
  const pick = (name: string) => options.find((option) => option.toLowerCase() === name.toLowerCase());
  const key = descriptionKey(row.description);
  if (key) {
    const past = [...history]
      .filter((tx) => tx.type === row.type && tx.note && descriptionKey(tx.note) === key)
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    if (past && pick(past.category)) return pick(past.category)!;
  }
  const text = row.description.toLowerCase();
  for (const [words, category, type] of KEYWORDS) {
    if (type === row.type && words.test(text) && pick(category)) return pick(category)!;
  }
  return pick('Other') ?? options[0] ?? 'Other';
}
