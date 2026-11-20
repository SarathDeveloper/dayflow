import { describe, expect, it } from 'vitest';
import type { Account, FinanceTransaction } from '../types';
import { computeAccountBalances, resolveDefaultAccountId, selectableAccounts, totalActiveBalancePaise } from './ledger';
import {
  accountsById,
  bucketAccounts,
  classifySavingsTransfer,
  countedSavingsAmounts,
  ledgerAccounts,
  ledgerTransactions,
  resolveSavingsDestinationId,
  savingsOnlyCandidates,
  spendableAccounts,
} from './savingsLedger';
import { forecastMonth } from './moneyForecast';

const STAMP = '2026-11-01T00:00:00.000Z';

const account = (over: Partial<Account>): Account => ({
  id: 'acct',
  name: 'Account',
  type: 'savings',
  openingBalance: 0,
  isArchived: false,
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
});

const tx = (over: Partial<FinanceTransaction>): FinanceTransaction => ({
  id: 'tx',
  type: 'expense',
  amount: 100,
  category: 'Food',
  date: '2026-11-10',
  recurrence: { type: 'none' },
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
});

const wallet = account({ id: 'wallet', name: 'Wallet', type: 'cash', openingBalance: 1000 });
const yes = account({ id: 'yes', name: 'YesBank', openingBalance: 5000 });
const cub = account({ id: 'cub', name: 'CUB-Savings', savingsOnly: true, openingBalance: 2000 });
const ind = account({ id: 'ind', name: 'IND-Bank', savingsOnly: true });
const gold = account({ id: 'gold', name: 'Gold', type: 'gold' });
const accounts = [wallet, yes, cub, ind, gold];

const save = tx({ id: 'save', type: 'transfer', category: 'Transfer', accountId: 'yes', destinationAccountId: 'cub', amount: 500 });
const withdraw = tx({ id: 'withdraw', type: 'transfer', category: 'Transfer', accountId: 'cub', destinationAccountId: 'wallet', amount: 200 });
const between = tx({ id: 'between', type: 'transfer', category: 'Transfer', accountId: 'cub', destinationAccountId: 'ind', amount: 300 });
const interest = tx({ id: 'interest', type: 'income', category: 'Interest', accountId: 'cub', amount: 40 });
const lunch = tx({ id: 'lunch', type: 'expense', accountId: 'yes', amount: 50 });
const all = [save, withdraw, between, interest, lunch];

describe('savings-only banks on the Money ledger', () => {
  it('leaves savings-only banks out of the ledger accounts', () => {
    expect(ledgerAccounts(accounts).map((a) => a.id)).toEqual(['wallet', 'yes', 'gold']);
  });

  it('hides their own entries but keeps moves to and from other accounts', () => {
    expect(ledgerTransactions(all, accounts).map((t) => t.id)).toEqual(['save', 'withdraw', 'lunch']);
  });

  it('changes nothing when no bank is picked', () => {
    const plain = accounts.map((a) => ({ ...a, savingsOnly: undefined }));
    expect(ledgerTransactions(all, plain)).toBe(all);
  });

  it('keeps the other accounts balances right from the visible entries alone', () => {
    const full = computeAccountBalances(accounts, all);
    const visible = computeAccountBalances(ledgerAccounts(accounts), ledgerTransactions(all, accounts));
    for (const id of ['wallet', 'yes', 'gold']) expect(visible.get(id)).toBe(full.get(id));
  });

  it('counts only spendable money in the ledger total', () => {
    // wallet 1000 + 200, yes 5000 - 500 - 50, gold 0
    expect(totalActiveBalancePaise(ledgerAccounts(accounts), ledgerTransactions(all, accounts))).toBe(565_000);
  });
});

describe('savings-only banks in pickers', () => {
  it('are not offered for income or spending', () => {
    expect(spendableAccounts(accounts).map((a) => a.id)).toEqual(['wallet', 'yes', 'gold']);
    expect(selectableAccounts(accounts).some((a) => a.savingsOnly)).toBe(false);
  });

  it('are never the default account, even when set as the default', () => {
    expect(resolveDefaultAccountId(accounts, { defaultAccountId: 'cub' })).toBe('wallet');
  });

  it('can be picked from any active account except cash', () => {
    expect(savingsOnlyCandidates(accounts).map((a) => a.id)).toEqual(['cub', 'gold', 'ind', 'yes']);
  });
});

describe('savings buckets once a bank is picked', () => {
  const byId = accountsById(accounts);

  it('are the picked banks plus gold and stocks', () => {
    expect(bucketAccounts(accounts).map((a) => a.id)).toEqual(['cub', 'gold', 'ind']);
  });

  it('count money from a normal savings-type bank as a new save', () => {
    expect(classifySavingsTransfer(save, byId)?.kind).toBe('save');
  });

  it('treat moves between picked banks as a reallocation', () => {
    expect(classifySavingsTransfer(between, byId)?.kind).toBe('reallocation');
  });

  it('do not count money leaving savings', () => {
    expect(classifySavingsTransfer(withdraw, byId)).toBeNull();
    expect(countedSavingsAmounts([], all, accounts)).toEqual([{ date: '2026-11-10', amount: 500 }]);
  });

  it('pick the only savings bank for quick add when there is one', () => {
    expect(resolveSavingsDestinationId([wallet, yes, cub])).toBe('cub');
  });

  it('keep the old rule before any bank is picked', () => {
    const plain = [wallet, yes, { ...cub, savingsOnly: false }];
    expect(bucketAccounts(plain).map((a) => a.id)).toEqual(['cub', 'yes']);
    expect(classifySavingsTransfer(save, accountsById(plain))?.kind).toBe('reallocation');
  });
});

describe('month forecast', () => {
  it('leaves savings-only banks out of the money left', () => {
    const input = { today: '2026-11-20', transactions: [], billTemplates: [], billPayments: [], budget: null };
    const withPick = forecastMonth({ ...input, accounts: [yes, cub] });
    const without = forecastMonth({ ...input, accounts: [yes, { ...cub, savingsOnly: false }] });
    expect(without.balanceNow - withPick.balanceNow).toBe(2000);
  });
});
