/**
 * Fast money entry: a one-line quick add ("250 lunch upi"), sums typed into an
 * amount field ("120+45*2"), the entries a person repeats most, and splitting
 * one payment across categories. Pure; amounts are rupees, maths in paise.
 */
import type { Account, FinanceTransaction, PaymentMethod } from '../types';
import { fromPaise, toPaise } from './money';

// ---------------------------------------------------------------------------
// Amount expressions
// ---------------------------------------------------------------------------

/**
 * Evaluates + - * / and brackets on rupee amounts ("1,200 + 85.50", "3*40").
 * Returns rupees rounded to paise, or null when it is not a valid, positive sum.
 * A hand-written parser: never `eval`.
 */
export function evaluateAmount(input: string): number | null {
  const source = input.replace(/[₹,\s]/g, '').replace(/[×x]/gi, '*').replace(/÷/g, '/');
  if (!source || source.length > 80 || /[^0-9.+\-*/()]/.test(source)) return null;
  let index = 0;
  const peek = () => source[index];

  function number(): number | null {
    const match = /^\d+(\.\d+)?|^\.\d+/.exec(source.slice(index));
    if (!match) return null;
    index += match[0].length;
    return Number(match[0]);
  }
  function factor(): number | null {
    if (peek() === '-') {
      index++;
      const value = factor();
      return value === null ? null : -value;
    }
    if (peek() === '(') {
      index++;
      const value = expression();
      if (value === null || peek() !== ')') return null;
      index++;
      return value;
    }
    return number();
  }
  function term(): number | null {
    let value = factor();
    while (value !== null && (peek() === '*' || peek() === '/')) {
      const operator = source[index++];
      const right = factor();
      if (right === null || (operator === '/' && right === 0)) return null;
      value = operator === '*' ? value * right : value / right;
    }
    return value;
  }
  function expression(): number | null {
    let value = term();
    while (value !== null && (peek() === '+' || peek() === '-')) {
      const operator = source[index++];
      const right = term();
      if (right === null) return null;
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  }

  const result = expression();
  if (result === null || index !== source.length || !Number.isFinite(result)) return null;
  const rounded = fromPaise(Math.round(result * 100));
  return rounded > 0 && rounded <= 100_000_000 ? rounded : null;
}

/** True when the text holds an operator, so the field should show the result. */
export function isAmountExpression(input: string): boolean {
  return /\d\s*[+\-*/×x÷]\s*[\d(.]/i.test(input);
}

// ---------------------------------------------------------------------------
// One-line quick add
// ---------------------------------------------------------------------------

/** Words that point to a built-in category. Custom categories match by name. */
const CATEGORY_WORDS: Record<string, string[]> = {
  'Food & Dining': ['food', 'lunch', 'dinner', 'breakfast', 'snack', 'snacks', 'tea', 'coffee', 'chai', 'swiggy', 'zomato', 'restaurant', 'hotel', 'biryani', 'pizza', 'meal', 'groceries', 'grocery', 'vegetables', 'milk', 'fruits', 'bigbasket', 'blinkit', 'zepto'],
  Transport: ['transport', 'uber', 'ola', 'rapido', 'auto', 'cab', 'taxi', 'bus', 'train', 'metro', 'flight', 'parking', 'toll', 'travel'],
  Fuel: ['fuel', 'petrol', 'diesel', 'cng', 'gas'],
  Shopping: ['shopping', 'amazon', 'flipkart', 'myntra', 'clothes', 'shoes', 'gift', 'meesho'],
  'Bills & Utilities': ['bill', 'bills', 'electricity', 'current', 'eb', 'water', 'internet', 'wifi', 'broadband', 'recharge', 'mobile', 'dth', 'gas cylinder'],
  'Rent & Housing': ['rent', 'maintenance', 'housing'],
  Health: ['health', 'medicine', 'medicines', 'pharmacy', 'doctor', 'hospital', 'medical', 'gym', 'clinic', 'lab'],
  Entertainment: ['movie', 'movies', 'netflix', 'prime', 'hotstar', 'spotify', 'game', 'games', 'entertainment', 'outing'],
  Education: ['education', 'course', 'books', 'book', 'fees', 'tuition', 'school', 'college', 'exam'],
  'Personal Care': ['salon', 'haircut', 'spa', 'cosmetics', 'grooming'],
  Salary: ['salary', 'payroll', 'stipend'],
  Freelance: ['freelance', 'client', 'project'],
  Business: ['business', 'sales', 'revenue'],
  Investment: ['dividend', 'returns'],
  Interest: ['interest'],
};

const INCOME_WORDS = ['salary', 'received', 'income', 'refund', 'cashback', 'got', 'credited', 'credit'];

const METHOD_WORDS: Record<string, PaymentMethod> = {
  cash: 'cash',
  gpay: 'gpay',
  googlepay: 'gpay',
  phonepe: 'phonepe',
  upi: 'gpay',
  card: 'card',
  credit: 'card',
  debit: 'card',
  bank: 'bank_transfer',
  neft: 'bank_transfer',
  imps: 'bank_transfer',
  netbanking: 'bank_transfer',
};

export interface QuickEntry {
  type: 'income' | 'expense';
  amount: number;
  category: string;
  /** The words that were not amount, category, method or account. */
  note: string;
  paymentMethod?: PaymentMethod;
  accountId?: string;
}

export interface QuickEntryContext {
  expenseCategories: string[];
  incomeCategories: string[];
  accounts: Account[];
}

function normal(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findCategory(words: string[], categories: string[]): { category: string; word: string } | null {
  const byName = new Map(categories.map((name) => [normal(name), name]));
  for (const word of words) {
    const exact = byName.get(normal(word));
    if (exact) return { category: exact, word };
  }
  for (const word of words) {
    for (const [category, hints] of Object.entries(CATEGORY_WORDS)) {
      if (categories.includes(category) && hints.includes(word.toLowerCase())) return { category, word };
    }
  }
  // A custom category whose first word was typed ("Groceries" from "grocer" is not enough).
  for (const word of words) {
    const key = normal(word);
    if (key.length < 3) continue;
    const match = categories.find((name) => normal(name).startsWith(key));
    if (match) return { category: match, word };
  }
  return null;
}

function findAccount(words: string[], accounts: Account[]): { account: Account; word: string } | null {
  for (const word of words) {
    const key = normal(word);
    if (key.length < 2) continue;
    // "hdfc" matches "HDFC Bank": the name's first word, the whole name, nickname, bank or last four digits.
    const account = accounts.find((item) => !item.isArchived && (
      normal(item.name.split(/\s+/)[0] ?? '') === key ||
      normal(item.name) === key ||
      (item.accountNickname && normal(item.accountNickname) === key) ||
      (item.bankName && normal(item.bankName) === key) ||
      (item.lastFourDigits && item.lastFourDigits === key)
    ));
    if (account) return { account, word };
  }
  return null;
}

/**
 * Reads "250 lunch upi", "+5000 salary", "lunch 250 cash hdfc", "1,200.50 petrol".
 * Returns null when there is no amount. A leading "+" or an income word makes it income.
 */
export function parseQuickEntry(input: string, context: QuickEntryContext): QuickEntry | null {
  const text = input.trim();
  if (!text || text.length > 200) return null;
  const amountMatch = /(^|\s)([+-]?)₹?\s?(\d[\d,]*(?:\.\d{1,2})?(?:\s*[+\-*/x]\s*\d[\d,]*(?:\.\d{1,2})?)*)(?=\s|$)/i.exec(text);
  if (!amountMatch) return null;
  const amount = evaluateAmount(amountMatch[3]);
  if (amount === null) return null;
  const rest = (text.slice(0, amountMatch.index) + ' ' + text.slice(amountMatch.index + amountMatch[0].length))
    .split(/\s+/).filter(Boolean);
  const lowerWords = rest.map((word) => word.toLowerCase());

  let paymentMethod: PaymentMethod | undefined;
  const used = new Set<string>();
  for (const word of rest) {
    const method = METHOD_WORDS[normal(word)];
    if (method && !paymentMethod) {
      paymentMethod = method;
      used.add(word);
    }
  }
  const account = findAccount(rest.filter((word) => !used.has(word)), context.accounts);
  if (account) used.add(account.word);

  const remaining = rest.filter((word) => !used.has(word));
  const incomeHint = amountMatch[2] === '+' || lowerWords.some((word) => INCOME_WORDS.includes(word));
  const incomeMatch = findCategory(remaining, context.incomeCategories.filter((name) => name !== 'Other'));
  const expenseMatch = findCategory(remaining, context.expenseCategories.filter((name) => name !== 'Other'));
  const type: 'income' | 'expense' = incomeHint || (incomeMatch && !expenseMatch) ? 'income' : 'expense';
  const match = type === 'income' ? incomeMatch : expenseMatch;
  const category = match?.category ?? 'Other';
  // The note keeps the descriptive words ("lunch", "amazon"), but not a word
  // that only repeats the category name or flags income ("received").
  const note = remaining
    .filter((word) => !(match && word === match.word && normal(word) === normal(category)))
    .filter((word) => !(INCOME_WORDS.includes(word.toLowerCase()) && word !== match?.word))
    .join(' ');

  return {
    type,
    amount,
    category,
    note: note.slice(0, 200),
    paymentMethod: paymentMethod ?? (account?.account.type === 'cash' ? 'cash' : undefined),
    accountId: account?.account.id,
  };
}

// ---------------------------------------------------------------------------
// Repeat a recent entry
// ---------------------------------------------------------------------------

export interface RepeatableEntry {
  key: string;
  type: 'income' | 'expense';
  amount: number;
  category: string;
  note?: string;
  accountId?: string;
  paymentMethod?: PaymentMethod;
  /** How often it happened in the window. */
  count: number;
  lastDate: string;
}

/**
 * Entries worth one tap: the same type, category, amount and note seen in the
 * last `days` days, ranked by how often, then how recent. Transfers and ATM
 * fees are left out.
 */
export function repeatableEntries(transactions: FinanceTransaction[], today: string, days = 60, limit = 6): RepeatableEntry[] {
  const since = new Date(`${today}T00:00:00`);
  since.setDate(since.getDate() - days);
  const from = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, '0')}-${String(since.getDate()).padStart(2, '0')}`;
  const groups = new Map<string, RepeatableEntry>();
  for (const tx of transactions) {
    if ((tx.type !== 'expense' && tx.type !== 'income') || tx.linkedTransferId || tx.date < from || tx.date > today) continue;
    const note = tx.note?.trim() || undefined;
    const key = [tx.type, tx.category, toPaise(tx.amount), (note ?? '').toLowerCase()].join('|');
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      if (tx.date > existing.lastDate) {
        existing.lastDate = tx.date;
        existing.accountId = tx.accountId;
        existing.paymentMethod = tx.paymentMethod;
      }
    } else {
      groups.set(key, {
        key, type: tx.type, amount: tx.amount, category: tx.category, note,
        accountId: tx.accountId, paymentMethod: tx.paymentMethod, count: 1, lastDate: tx.date,
      });
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || b.lastDate.localeCompare(a.lastDate))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Split one payment
// ---------------------------------------------------------------------------

export interface SplitLine {
  category: string;
  amount: number;
  note?: string;
}

/**
 * Checks split lines against the total paid: every line positive, at least two
 * lines, and the lines adding up exactly to the total (in paise).
 */
export function checkSplit(total: number, lines: SplitLine[]): string | null {
  if (!(total > 0)) return 'Enter the total paid.';
  const filled = lines.filter((line) => line.amount > 0);
  if (filled.length < 2) return 'Split into at least two categories.';
  if (filled.some((line) => !line.category)) return 'Choose a category for each part.';
  const sum = filled.reduce((paise, line) => paise + toPaise(line.amount), 0);
  const difference = toPaise(total) - sum;
  if (difference !== 0) {
    const left = fromPaise(Math.abs(difference)).toFixed(2);
    return difference > 0 ? `₹${left} is not assigned yet.` : `The parts are ₹${left} more than the total.`;
  }
  return null;
}

/** What is left of the total after the lines so far (never negative), in rupees. */
export function splitRemainder(total: number, lines: SplitLine[]): number {
  const sum = lines.reduce((paise, line) => paise + (line.amount > 0 ? toPaise(line.amount) : 0), 0);
  return fromPaise(Math.max(0, toPaise(total) - sum));
}
