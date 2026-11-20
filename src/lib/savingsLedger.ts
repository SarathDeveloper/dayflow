import type { Account, AccountType, FinanceTransaction, SavingsEntry } from '../types';
import type { SavingsAmount } from './savingsStreak';

/** Accounts that hold saved or invested rupees. */
export const SAVINGS_BUCKET_TYPES: readonly AccountType[] = ['savings', 'gold', 'stocks'];

export function isSavingsBucketType(type: AccountType | undefined): boolean {
  return type === 'savings' || type === 'gold' || type === 'stocks';
}

export type SavingsMoveKind = 'save' | 'reallocation';

export interface ClassifiedSavingsTransfer {
  kind: SavingsMoveKind;
  transfer: FinanceTransaction;
}

export function accountsById(accounts: Account[]): Map<string, Account> {
  return new Map(accounts.map((account) => [account.id, account]));
}

/** An account kept for future savings: off the Money ledger, on the Savings page only. */
export function isSavingsOnly(account: Pick<Account, 'savingsOnly'> | undefined): boolean {
  return Boolean(account?.savingsOnly);
}

/** True once at least one active account is picked as a savings-only bank. */
export function hasSavingsOnlyAccounts(accounts: Account[]): boolean {
  return accounts.some((account) => !account.isArchived && isSavingsOnly(account));
}

/**
 * Which accounts hold savings. Once any bank is picked for future savings,
 * that is the picked banks plus gold and stocks; before that, every savings,
 * gold or stocks account (the old rule, so nothing changes until a pick).
 */
export function savingsBucketTest(accounts: Iterable<Account>): (account: Account | undefined) => boolean {
  const list = [...accounts];
  if (!hasSavingsOnlyAccounts(list)) return (account) => isSavingsBucketType(account?.type);
  return (account) => Boolean(account && (isSavingsOnly(account) || account.type === 'gold' || account.type === 'stocks'));
}

/**
 * A transfer into a savings bucket.
 * Money arriving from any other account is a new save.
 * Money moving between buckets is a reallocation and is not new savings.
 */
export function classifySavingsTransfer(
  tx: FinanceTransaction,
  accounts: Map<string, Account>,
  isBucket: (account: Account | undefined) => boolean = savingsBucketTest(accounts.values())
): ClassifiedSavingsTransfer | null {
  if (tx.type !== 'transfer' || tx.amount <= 0) return null;
  const destination = tx.destinationAccountId ? accounts.get(tx.destinationAccountId) : undefined;
  const source = tx.accountId ? accounts.get(tx.accountId) : undefined;
  if (!destination || !isBucket(destination) || !source) return null;
  if (isBucket(source)) return { kind: 'reallocation', transfer: tx };
  return { kind: 'save', transfer: tx };
}

/**
 * Amounts that extend the streak and the saved-this-month total:
 * legacy habit logs, plus new saves. Reallocations are left out.
 */
export function countedSavingsAmounts(
  entries: SavingsEntry[],
  transactions: FinanceTransaction[],
  accounts: Account[]
): SavingsAmount[] {
  const byId = accountsById(accounts);
  const isBucket = savingsBucketTest(accounts);
  const amounts: SavingsAmount[] = [];
  for (const entry of entries) {
    if (entry.amount > 0) amounts.push({ date: entry.date, amount: entry.amount });
  }
  for (const tx of transactions) {
    const classified = classifySavingsTransfer(tx, byId, isBucket);
    if (classified?.kind === 'save') {
      amounts.push({ date: classified.transfer.date, amount: classified.transfer.amount });
    }
  }
  return amounts;
}

export type SavingsListRow =
  | {
      kind: 'save' | 'reallocation';
      id: string;
      date: string;
      amount: number;
      note?: string;
      createdAt: string;
      fromName: string;
      toName: string;
      transfer: FinanceTransaction;
    }
  | {
      kind: 'legacy';
      id: string;
      date: string;
      amount: number;
      note?: string;
      createdAt: string;
      entry: SavingsEntry;
    };

/** Month list: new saves, reallocations, and legacy logs that have no account. */
export function savingsRowsForMonth(
  entries: SavingsEntry[],
  transactions: FinanceTransaction[],
  accounts: Account[],
  month: string
): SavingsListRow[] {
  const byId = accountsById(accounts);
  const isBucket = savingsBucketTest(accounts);
  const rows: SavingsListRow[] = [];
  for (const tx of transactions) {
    if (!tx.date.startsWith(month)) continue;
    const classified = classifySavingsTransfer(tx, byId, isBucket);
    if (!classified) continue;
    const source = tx.accountId ? byId.get(tx.accountId) : undefined;
    const destination = tx.destinationAccountId ? byId.get(tx.destinationAccountId) : undefined;
    rows.push({
      kind: classified.kind,
      id: tx.id,
      date: tx.date,
      amount: tx.amount,
      note: tx.note,
      createdAt: tx.createdAt,
      fromName: source?.name || 'Unknown account',
      toName: destination?.name || 'Unknown account',
      transfer: tx,
    });
  }
  for (const entry of entries) {
    if (!entry.date.startsWith(month) || entry.amount <= 0) continue;
    rows.push({
      kind: 'legacy',
      id: entry.id,
      date: entry.date,
      amount: entry.amount,
      note: entry.note,
      createdAt: entry.createdAt,
      entry,
    });
  }
  rows.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  return rows;
}

export function bucketAccounts(accounts: Account[]): Account[] {
  const isBucket = savingsBucketTest(accounts);
  return accounts
    .filter((account) => !account.isArchived && isBucket(account))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Banks that can be picked for future savings: any active account except cash. */
export function savingsOnlyCandidates(accounts: Account[]): Account[] {
  return accounts
    .filter((account) => !account.isArchived && account.type !== 'cash' && account.type !== 'credit_card')
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// The Money ledger without savings-only banks
// ---------------------------------------------------------------------------

/** Accounts the Money ledger shows: everything except savings-only banks. */
export function ledgerAccounts(accounts: Account[]): Account[] {
  return accounts.filter((account) => !isSavingsOnly(account));
}

/**
 * Entries the Money ledger shows. Income and spending inside a savings-only
 * bank, and moves between two of them, stay on the Savings page. A move
 * between a savings-only bank and any other account stays visible, so the
 * other account's history still adds up.
 */
export function ledgerTransactions(transactions: FinanceTransaction[], accounts: Account[]): FinanceTransaction[] {
  const hidden = new Set(accounts.filter(isSavingsOnly).map((account) => account.id));
  if (hidden.size === 0) return transactions;
  return transactions.filter((tx) => {
    const fromHidden = Boolean(tx.accountId && hidden.has(tx.accountId));
    if (tx.type !== 'transfer') return !fromHidden;
    const toHidden = Boolean(tx.destinationAccountId && hidden.has(tx.destinationAccountId));
    return !(fromHidden && toHidden);
  });
}

/** Accounts offered for income and spending: active, not savings-only. */
export function spendableAccounts(accounts: Account[]): Account[] {
  return accounts.filter((account) => !account.isArchived && !isSavingsOnly(account));
}

/**
 * Destination for a quick save: the remembered bucket, or the only bucket.
 * Several buckets and no memory means the caller must ask.
 */
export function resolveSavingsDestinationId(
  accounts: Account[],
  preferredId?: string
): string | undefined {
  const buckets = bucketAccounts(accounts);
  if (preferredId && buckets.some((account) => account.id === preferredId)) return preferredId;
  if (buckets.length === 1) return buckets[0].id;
  return undefined;
}
