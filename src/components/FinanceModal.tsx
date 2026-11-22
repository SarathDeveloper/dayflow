import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownCircle, ArrowUpCircle, Calendar, Repeat, X } from 'lucide-react';
import {
  Account,
  FinanceCategory,
  FinanceRecurrenceType,
  FinanceTransaction,
  LedgerSettings,
  PaymentMethod,
  TransactionType,
} from '../types';
import {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  PAYMENT_METHODS,
  financeCategoryNames,
  isCustomFinanceCategory,
  paymentMethodLabel,
} from '../data/financeCategories';
import { Button } from './ui/Button';
import { CategorySelect } from './ui/CategorySelect';
import { AccountPicker } from './ledger/AccountPicker';
import {
  computeAccountBalances,
  nowTimeString,
  todayString,
  resolveDefaultAccountId,
  isLedgerError,
  validateEntry,
  type EntryDraft,
} from '../lib/ledger';
import { formatPaise, isAmountParseOk, parseAmountInput } from '../lib/money';
import { evaluateAmount, isAmountExpression } from '../lib/quickEntry';
import { recentCategories } from '../lib/financeRecurrence';

interface FinanceModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Return false to keep the modal open (validation refused the entry). */
  /** `allowOverdraft`: the money already left the account, so save below zero. */
  onSave: (tx: Partial<FinanceTransaction>, options?: { allowOverdraft?: boolean }) => boolean | void;
  initialTransaction?: FinanceTransaction | null;
  selectedDate: string;
  accounts: Account[];
  transactions: FinanceTransaction[];
  ledgerSettings: LedgerSettings[];
  financeCategories: FinanceCategory[];
  onAddFinanceCategory: (kind: 'income' | 'expense', name: string) => string | null;
  onDeleteFinanceCategory: (kind: 'income' | 'expense', name: string) => void;
  /** Pre-select income/expense when opened from the ledger actions. */
  initialType?: 'income' | 'expense';
  /** Pre-select the funding/receiving account. */
  initialAccountId?: string;
  onAddAccount?: () => void;
}

export const FinanceModal: React.FC<FinanceModalProps> = ({
  isOpen,
  onClose,
  onSave,
  initialTransaction,
  selectedDate,
  accounts,
  transactions,
  ledgerSettings,
  financeCategories,
  onAddFinanceCategory,
  onDeleteFinanceCategory,
  initialType,
  initialAccountId,
  onAddAccount,
}) => {
  const settings = ledgerSettings[0];
  const [type, setType] = useState<TransactionType>(() => {
    if (initialTransaction) return initialTransaction.type === 'transfer' ? 'expense' : initialTransaction.type;
    return initialType || 'expense';
  });
  const [amount, setAmount] = useState<string>(() => {
    return initialTransaction ? String(initialTransaction.amount) : '';
  });
  const [category, setCategory] = useState<string>(() => {
    if (initialTransaction) return initialTransaction.category;
    const startType = initialType || 'expense';
    return (
      recentCategories(transactions, startType, 1)[0] ??
      (startType === 'expense' ? EXPENSE_CATEGORIES[0] : INCOME_CATEGORIES[0])
    );
  });
  const [note, setNote] = useState<string>(() => initialTransaction?.note || '');
  const [date, setDate] = useState<string>(() => initialTransaction?.date || selectedDate || todayString());
  const [time, setTime] = useState<string>(() => initialTransaction?.time || nowTimeString());
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(() => {
    if (initialTransaction?.paymentMethod) return initialTransaction.paymentMethod;
    const acctId = initialAccountId || resolveDefaultAccountId(accounts, settings);
    const selected = accounts.find((a) => a.id === acctId);
    return selected?.type === 'cash' ? 'cash' : 'bank_transfer';
  });
  const [accountId, setAccountId] = useState<string | undefined>(() => {
    if (initialTransaction?.accountId) return initialTransaction.accountId;
    return initialAccountId || resolveDefaultAccountId(accounts, settings);
  });
  const [recurrenceType, setRecurrenceType] = useState<FinanceRecurrenceType>(() => {
    return initialTransaction?.recurrence?.type || 'none';
  });
  const [recurrenceEndDate, setRecurrenceEndDate] = useState<string>(() => {
    return initialTransaction?.recurrence?.endDate || '';
  });
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const selectable = useMemo(
    () =>
      accounts
        // Savings-only banks take savings moves, not income or spending.
        .filter((a) => (!a.isArchived && !a.savingsOnly) || a.id === initialTransaction?.accountId)
        .sort((a, b) => {
          if (a.type === 'cash' && b.type !== 'cash') return -1;
          if (b.type === 'cash' && a.type !== 'cash') return 1;
          return a.name.localeCompare(b.name);
        }),
    [accounts, initialTransaction?.accountId]
  );

  const prevOpenRef = useRef(isOpen);
  const prevInitialTxIdRef = useRef<string | undefined>(initialTransaction?.id);

  useEffect(() => {
    const justOpened = !prevOpenRef.current && isOpen;
    const txChanged = prevInitialTxIdRef.current !== initialTransaction?.id;
    prevOpenRef.current = isOpen;
    prevInitialTxIdRef.current = initialTransaction?.id;

    if (!isOpen) return;

    // Only populate or reset the form when the modal is freshly opened,
    // or when editing a different transaction. Never wipe active user input on prop re-renders!
    if (justOpened || txChanged) {
      setError(null);
      setIsSubmitting(false);

      if (initialTransaction) {
        setType(initialTransaction.type === 'transfer' ? 'expense' : initialTransaction.type);
        setAmount(String(initialTransaction.amount));
        setCategory(initialTransaction.category);
        setNote(initialTransaction.note || '');
        setDate(initialTransaction.date);
        setTime(initialTransaction.time || nowTimeString());
        setPaymentMethod(initialTransaction.paymentMethod || 'cash');
        setAccountId(initialTransaction.accountId);
        setRecurrenceType(initialTransaction.recurrence?.type || 'none');
        setRecurrenceEndDate(initialTransaction.recurrence?.endDate || '');
      } else if (justOpened) {
        const startType = initialType || 'expense';
        const account = resolveDefaultAccountId(accounts, settings) || initialAccountId;
        setType(startType);
        setAmount('');
        setCategory(
          recentCategories(transactions, startType, 1)[0] ??
            (startType === 'expense' ? EXPENSE_CATEGORIES[0] : INCOME_CATEGORIES[0])
        );
        setNote('');
        setDate(selectedDate || todayString());
        setTime(nowTimeString());
        setAccountId(initialAccountId || account);
        const selected = accounts.find((a) => a.id === (initialAccountId || account));
        setPaymentMethod(selected?.type === 'cash' ? 'cash' : 'bank_transfer');
        setRecurrenceType('none');
        setRecurrenceEndDate('');
      }
    }
  }, [isOpen, initialTransaction?.id]);

  useEffect(() => {
    if (!accountId && selectable.length > 0) {
      const def = resolveDefaultAccountId(accounts, settings) || selectable[0]?.id;
      if (def) {
        setAccountId(def);
        const selected = accounts.find((a) => a.id === def);
        setPaymentMethod(selected?.type === 'cash' ? 'cash' : 'bank_transfer');
      }
    }
  }, [accounts, accountId, settings, selectable]);

  const categoryKind = type === 'income' ? 'income' : 'expense';
  const categories = useMemo(() => {
    const live = initialTransaction
      ? transactions.find((tx) => tx.id === initialTransaction.id) ?? initialTransaction
      : undefined;
    const liveKind = live ? (live.type === 'transfer' ? 'expense' : live.type) : undefined;
    const preserved = live && liveKind === categoryKind ? [live.category] : [];
    return financeCategoryNames(categoryKind, financeCategories, preserved);
  }, [categoryKind, financeCategories, initialTransaction, transactions]);

  // Up to 4 recently used categories of this kind, as one-tap chips.
  const recent = useMemo(
    () =>
      recentCategories(transactions, categoryKind, 4).filter((name) =>
        categories.some((option) => option.toLowerCase() === name.toLowerCase())
      ),
    [transactions, categoryKind, categories]
  );

  useEffect(() => {
    if (categories.some((name) => name.toLowerCase() === category.toLowerCase())) return;
    setCategory(recent[0] || categories[0] || (categoryKind === 'income' ? INCOME_CATEGORIES[0] : EXPENSE_CATEGORIES[0]));
  }, [categories, category, categoryKind, recent]);

  const balances = useMemo(
    () => computeAccountBalances(accounts, transactions),
    [accounts, transactions]
  );

  const amountPaise = useMemo(() => {
    const parsed = parseAmountInput(isAmountExpression(amount) ? String(evaluateAmount(amount) ?? '') : amount);
    return isAmountParseOk(parsed) ? parsed.paise : 0;
  }, [amount]);

  const projected = useMemo(() => {
    const map = new Map<string, number>();
    if (!accountId || amountPaise === 0) return map;
    const current = balances.get(accountId) || 0;
    map.set(accountId, type === 'income' ? current + amountPaise : current - amountPaise);
    return map;
  }, [balances, accountId, amountPaise, type]);

  if (!isOpen) return null;

  const handleSelectAccount = (id: string) => {
    setAccountId(id);
    const account = accounts.find((a) => a.id === id);
    // Keep the payment method aligned with the funding account unless the user
    // already picked a UPI app / card.
    if (account?.type === 'cash' && paymentMethod !== 'cash') {
      setPaymentMethod('cash');
    }
    if (account && account.type !== 'cash' && paymentMethod === 'cash') {
      setPaymentMethod('bank_transfer');
    }
  };

  // Set when the save was refused for low balance: the form offers "Save anyway".
  const [overdraft, setOverdraft] = useState(false);

  const handleSubmit = (e: React.FormEvent | null, allowOverdraft = false) => {
    e?.preventDefault();
    if (isSubmitting) return;
    setOverdraft(false);

    const parsed = parseAmountInput(isAmountExpression(amount) ? String(evaluateAmount(amount) ?? amount) : amount);
    if (!isAmountParseOk(parsed)) {
      setError(parsed.error);
      return;
    }

    if (selectable.length === 0) {
      setError('Add a bank account or cash wallet first before saving an entry.');
      return;
    }

    const draft: EntryDraft = {
      id: initialTransaction?.id,
      type: type === 'income' ? 'income' : 'expense',
      amount: parsed.rupees,
      accountId,
      category,
      note,
      paymentMethod,
      date,
      time,
      recurrence: {
        type: recurrenceType,
        endDate:
          recurrenceType !== 'none' && recurrenceEndDate ? recurrenceEndDate : undefined,
      },
    };

    const validation = validateEntry(draft, {
      accounts,
      transactions,
      settings: settings || { allowNegativeBalance: false },
    });
    if (isLedgerError(validation) && !(allowOverdraft && validation.code === 'insufficient-balance')) {
      setError(validation.message);
      setOverdraft(validation.code === 'insufficient-balance');
      return;
    }

    setIsSubmitting(true);
    const saved = onSave({
      id: initialTransaction?.id,
      type: draft.type,
      amount: draft.amount,
      category,
      note: note.trim() || undefined,
      date,
      time,
      paymentMethod,
      accountId,
      recurrence: draft.recurrence,
    }, allowOverdraft ? { allowOverdraft: true } : undefined);
    if (saved === false) {
      setIsSubmitting(false);
      return;
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end sm:justify-center sm:items-center p-0 sm:p-4 bg-slate-950/70 backdrop-blur-sm overflow-y-auto">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 rounded-t-2xl sm:rounded-2xl w-full min-w-0 max-w-md max-h-[92dvh] sm:max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/80 dark:bg-slate-900/90 shrink-0">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">
            {initialTransaction
              ? 'Edit Transaction'
              : type === 'income'
              ? 'Add Income'
              : 'Add Expense'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="w-9 h-9 flex items-center justify-center rounded-xl text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 overflow-y-auto flex-1 text-sm">

          {/* Type toggle */}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setType('expense')}
              className={`flex items-center justify-center gap-2 py-2.5 rounded-xl border font-bold text-sm transition-colors ${
                type === 'expense'
                  ? 'bg-rose-50 dark:bg-rose-950/40 border-rose-300 dark:border-rose-700 text-rose-700 dark:text-rose-300'
                  : 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400'
              }`}
            >
              <ArrowDownCircle className="w-4 h-4" />
              Expense
            </button>
            <button
              type="button"
              onClick={() => setType('income')}
              className={`flex items-center justify-center gap-2 py-2.5 rounded-xl border font-bold text-sm transition-colors ${
                type === 'income'
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300'
                  : 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400'
              }`}
            >
              <ArrowUpCircle className="w-4 h-4" />
              Income
            </button>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              Amount *
            </label>
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400 font-bold">
                ₹
              </span>
              <input
                type="text"
                inputMode="decimal"
                required
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setError(null);
                }}
                onBlur={() => {
                  // "120+45*2" becomes 210 when the field is left.
                  if (isAmountExpression(amount)) {
                    const total = evaluateAmount(amount);
                    if (total !== null) setAmount(String(total));
                  }
                }}
                placeholder="0.00 or 120+45"
                aria-describedby="amount-sum"
                className="w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl pl-8 pr-3.5 py-2.5 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-bold text-lg"
                autoFocus
              />
            </div>
            <div className="mt-1.5 flex items-center gap-1.5">
              {(['+', '-', '×', '÷'] as const).map((operator) => (
                <button key={operator} type="button" aria-label={`Insert ${operator}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onTouchStart={(event) => event.preventDefault()}
                  onClick={() => setAmount((value) => `${value}${operator === '×' ? '*' : operator === '÷' ? '/' : operator}`)}
                  className="min-h-9 min-w-9 rounded-lg bg-slate-100 dark:bg-slate-800 text-sm font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700">
                  {operator}
                </button>
              ))}
              <span id="amount-sum" className="ml-1 text-xs font-semibold text-slate-500 dark:text-slate-400" aria-live="polite">
                {isAmountExpression(amount)
                  ? evaluateAmount(amount) !== null ? `= ${formatPaise(Math.round((evaluateAmount(amount) ?? 0) * 100))}` : 'Check the sum'
                  : 'Type a sum like 120+45'}
              </span>
            </div>
          </div>

          <AccountPicker
            label={type === 'income' ? 'Received into *' : 'Paid from *'}
            accounts={selectable}
            balances={balances}
            value={accountId}
            onChange={handleSelectAccount}
            projectedBalances={projected}
            emptyHint="No active accounts. Add a cash wallet or bank account in the Money Ledger first."
            onAddAccount={onAddAccount}
          />

          {accountId && amountPaise > 0 && (
            <p className="text-[11px] text-slate-500 dark:text-slate-400 -mt-1">
              {accounts.find((a) => a.id === accountId)?.name}:{' '}
              {formatPaise(balances.get(accountId) || 0)} →{' '}
              <span
                className={`font-semibold ${
                  (projected.get(accountId) || 0) < 0
                    ? 'text-rose-600 dark:text-rose-400'
                    : 'text-slate-700 dark:text-slate-200'
                }`}
              >
                {formatPaise(projected.get(accountId) || 0)}
              </span>
            </p>
          )}

          <div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Category
              </label>
              {recent.length > 1 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {recent.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setCategory(name)}
                      aria-pressed={name.toLowerCase() === category.toLowerCase()}
                      className={`px-2.5 py-1 min-h-[32px] rounded-full border text-xs font-semibold transition-colors ${
                        name.toLowerCase() === category.toLowerCase()
                          ? 'bg-indigo-50 dark:bg-indigo-950/40 border-indigo-300 dark:border-indigo-700 text-indigo-700 dark:text-indigo-300'
                          : 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              )}
              <CategorySelect
                value={category}
                options={categories}
                onChange={setCategory}
                onAdd={(name) => onAddFinanceCategory(categoryKind, name)}
                canDelete={isCustomFinanceCategory(category, categoryKind, financeCategories)}
                onDelete={() => {
                  onDeleteFinanceCategory(categoryKind, category);
                  setCategory('Other');
                }}
                className="w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2.5 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1 flex items-center gap-1.5">
                Date
                {date !== todayString() && (
                  <span className="rounded-full bg-amber-100 dark:bg-amber-950/50 px-1.5 py-0.5 text-[10px] font-bold text-amber-800 dark:text-amber-200">
                    Not today
                  </span>
                )}
              </label>
              <input
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2.5 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1 flex items-center gap-1">
                <Calendar className="w-3 h-3" /> Time
              </label>
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2.5 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>

          {type === 'expense' && (
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Payment method
              </label>
              <div className="grid grid-cols-3 gap-1.5">
                {PAYMENT_METHODS.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => setPaymentMethod(m.value)}
                    aria-pressed={paymentMethod === m.value}
                    className={`flex items-center justify-center gap-1 py-2 rounded-xl border text-[11px] font-bold transition-colors min-h-[38px] ${
                      paymentMethod === m.value
                        ? 'bg-indigo-50 dark:bg-indigo-950/40 border-indigo-300 dark:border-indigo-700 text-indigo-700 dark:text-indigo-300'
                        : 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    <span className="text-base leading-none">{m.emoji}</span>
                    {m.label}
                  </button>
                ))}
                {initialTransaction?.paymentMethod &&
                  !PAYMENT_METHODS.some((m) => m.value === initialTransaction.paymentMethod) && (
                    <button
                      type="button"
                      onClick={() =>
                        setPaymentMethod(initialTransaction.paymentMethod as PaymentMethod)
                      }
                      className={`flex items-center justify-center gap-1 py-2 rounded-xl border text-[11px] font-bold transition-colors min-h-[38px] ${
                        paymentMethod === initialTransaction.paymentMethod
                          ? 'bg-indigo-50 dark:bg-indigo-950/40 border-indigo-300 dark:border-indigo-700 text-indigo-700 dark:text-indigo-300'
                          : 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400'
                      }`}
                    >
                      {paymentMethodLabel(initialTransaction.paymentMethod)}
                    </button>
                  )}
              </div>
              <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1">
                Paid from the account selected above.
              </p>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              {type === 'expense' ? 'Description / merchant' : 'Source / description'}
            </label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={
                type === 'expense' ? 'e.g. Lunch at Anandhas' : 'e.g. October salary'
              }
              className="w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3.5 py-2.5 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">
              <Repeat className="w-3.5 h-3.5" />
              Repeat
            </label>
            <div className="grid grid-cols-4 gap-1.5">
              {(['none', 'daily', 'weekly', 'monthly'] as FinanceRecurrenceType[]).map((r) => {
                const labels: Record<FinanceRecurrenceType, string> = {
                  none: 'Once',
                  daily: 'Daily',
                  weekly: 'Weekly',
                  monthly: 'Monthly',
                };
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRecurrenceType(r)}
                    className={`py-2 rounded-xl border text-[11px] font-bold transition-colors ${
                      recurrenceType === r
                        ? 'bg-indigo-50 dark:bg-indigo-950/40 border-indigo-300 dark:border-indigo-700 text-indigo-700 dark:text-indigo-300'
                        : 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
                    }`}
                  >
                    {labels[r]}
                  </button>
                );
              })}
            </div>
            {recurrenceType !== 'none' && (
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                  End Date (optional)
                </label>
                <input
                  type="date"
                  value={recurrenceEndDate}
                  min={date}
                  onChange={(e) => setRecurrenceEndDate(e.target.value)}
                  className="w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
            )}
          </div>

          {/* Stays above the keyboard and the fold while the form scrolls; the reason a save
              was refused shows here too, where the person just tapped. */}
          <div className="sticky -bottom-5 -mx-5 px-5 py-3 space-y-2 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800">
          {error && (
            <div role="alert" className="text-xs font-semibold text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-xl px-3 py-2 space-y-1.5">
              <p>{error}</p>
              {overdraft && (
                <button
                  type="button"
                  onClick={() => handleSubmit(null, true)}
                  className="font-bold text-rose-700 dark:text-rose-300 underline"
                >
                  Already paid? Save anyway
                </button>
              )}
            </div>
          )}
          <div className="flex gap-2">
            <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" className="flex-1" disabled={isSubmitting}>
              {initialTransaction ? 'Save Changes' : type === 'income' ? 'Add Income' : 'Add Expense'}
            </Button>
          </div>
          </div>
        </form>
      </div>
    </div>
  );
};
