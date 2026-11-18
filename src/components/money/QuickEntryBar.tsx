import { useMemo, useState } from 'react';
import { Check, Scissors, Zap } from 'lucide-react';
import type { Account, FinanceTransaction } from '../../types';
import { parseQuickEntry, repeatableEntries } from '../../lib/quickEntry';
import type { QuickEntry } from '../../lib/quickEntry';
import { formatRupees } from '../../lib/money';
import { ALL_PAYMENT_METHODS } from '../../data/financeCategories';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';

interface Props {
  accounts: Account[];
  transactions: FinanceTransaction[];
  expenseCategories: string[];
  incomeCategories: string[];
  today: string;
  /** Saves through the same checks as the full form. False when it was refused. */
  onSave: (entry: QuickEntry) => boolean;
  onSplit: () => void;
}

/** One-line entry ("250 lunch upi") plus one-tap repeats of frequent entries. */
export function QuickEntryBar({ accounts, transactions, expenseCategories, incomeCategories, today, onSave, onSplit }: Props) {
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const context = useMemo(() => ({ expenseCategories, incomeCategories, accounts }), [expenseCategories, incomeCategories, accounts]);
  const parsed = useMemo(() => parseQuickEntry(text, context), [text, context]);
  const repeats = useMemo(() => repeatableEntries(transactions, today), [transactions, today]);
  const accountName = parsed?.accountId ? accounts.find((account) => account.id === parsed.accountId)?.name : undefined;
  const method = parsed?.paymentMethod ? ALL_PAYMENT_METHODS.find((item) => item.value === parsed.paymentMethod)?.label : undefined;

  const save = (entry: QuickEntry, label: string) => {
    if (onSave(entry)) {
      setSaved(`Added ${label}`);
      window.setTimeout(() => setSaved(''), 2500);
      return true;
    }
    return false;
  };

  const submit = () => {
    if (!parsed) return;
    const label = `${parsed.type === 'income' ? '+' : ''}${formatRupees(parsed.amount)} ${parsed.note || parsed.category}`;
    if (save(parsed, label)) setText('');
  };

  return (
    <Card className="p-3 space-y-2.5">
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <label className="relative flex-1 min-w-0">
          <span className="sr-only">Quick add</span>
          <Zap className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-indigo-500" />
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="250 lunch upi · +5000 salary · 120+45 petrol hdfc"
            autoComplete="off"
            spellCheck={false}
            className="w-full min-h-11 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl pl-9 pr-3 text-sm text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </label>
        <Button type="submit" size="sm" disabled={!parsed} className="min-h-11">Add</Button>
        <Button type="button" size="sm" variant="secondary" onClick={onSplit} className="min-h-11" title="Split one payment across categories">
          <Scissors className="w-4 h-4" /><span className="hidden sm:inline">Split</span>
        </Button>
      </form>

      <div className="min-h-5 text-xs" aria-live="polite">
        {saved ? (
          <span className="inline-flex items-center gap-1 font-semibold text-emerald-700 dark:text-emerald-300"><Check className="w-3.5 h-3.5" /> {saved}</span>
        ) : parsed ? (
          <span className="flex flex-wrap items-center gap-1.5 text-slate-600 dark:text-slate-300">
            <span className={`rounded-full px-2 py-0.5 font-bold ${parsed.type === 'income'
              ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
              : 'bg-rose-50 text-rose-800 dark:bg-rose-950 dark:text-rose-200'}`}>
              {parsed.type === 'income' ? 'Income' : 'Expense'} {formatRupees(parsed.amount)}
            </span>
            <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5">{parsed.category}</span>
            {method && <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5">{method}</span>}
            {accountName && <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5">{accountName}</span>}
            {parsed.note && <span className="truncate">“{parsed.note}”</span>}
          </span>
        ) : text.trim() ? (
          <span className="text-slate-500 dark:text-slate-400">Add an amount, like “250 lunch”.</span>
        ) : (
          <span className="text-slate-500 dark:text-slate-400">Type amount and words in any order. “+” or “salary” makes it income.</span>
        )}
      </div>

      {repeats.length > 0 && (
        <div className="flex gap-2 overflow-x-auto no-scrollbar pb-0.5">
          <span className="shrink-0 self-center text-[11px] font-semibold text-slate-400">Again:</span>
          {repeats.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => save(
                { type: item.type, amount: item.amount, category: item.category, note: item.note ?? '', paymentMethod: item.paymentMethod, accountId: item.accountId },
                `${formatRupees(item.amount)} ${item.note || item.category}`,
              )}
              title={`${item.category} · used ${item.count} times`}
              className="shrink-0 inline-flex min-h-9 items-center gap-1 rounded-full border border-slate-200 dark:border-slate-700 px-3 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <span className={item.type === 'income' ? 'text-emerald-600 dark:text-emerald-400' : ''}>
                {item.type === 'income' ? '+' : ''}{formatRupees(item.amount)}
              </span>
              <span className="max-w-[9rem] truncate text-slate-500 dark:text-slate-400">{item.note || item.category}</span>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}
