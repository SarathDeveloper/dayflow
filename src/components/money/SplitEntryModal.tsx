import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import type { Account, PaymentMethod } from '../../types';
import { checkSplit, evaluateAmount, splitRemainder } from '../../lib/quickEntry';
import type { SplitLine } from '../../lib/quickEntry';
import { formatRupees } from '../../lib/money';
import { PAYMENT_METHODS } from '../../data/financeCategories';
import { Button } from '../ui/Button';

interface Props {
  isOpen: boolean;
  accounts: Account[];
  expenseCategories: string[];
  defaultAccountId?: string;
  today: string;
  onClose: () => void;
  onSave: (split: { accountId: string; date: string; note?: string; paymentMethod?: PaymentMethod; lines: SplitLine[] }) => boolean;
}

const field = 'w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500';

/** One payment (a supermarket bill) split across categories, saved as one entry per part. */
export function SplitEntryModal({ isOpen, accounts, expenseCategories, defaultAccountId, today, onClose, onSave }: Props) {
  const [total, setTotal] = useState('');
  const [accountId, setAccountId] = useState('');
  const [date, setDate] = useState(today);
  const [note, setNote] = useState('');
  const [method, setMethod] = useState<PaymentMethod | ''>('');
  const [lines, setLines] = useState<{ category: string; amount: string }[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setTotal('');
    setAccountId(defaultAccountId ?? accounts[0]?.id ?? '');
    setDate(today);
    setNote('');
    setMethod('');
    setLines([{ category: expenseCategories[0] ?? 'Other', amount: '' }, { category: expenseCategories[1] ?? 'Other', amount: '' }]);
    setError('');
  }, [isOpen, defaultAccountId, accounts, expenseCategories, today]);

  const totalValue = evaluateAmount(total) ?? 0;
  const parsedLines: SplitLine[] = useMemo(
    () => lines.map((line) => ({ category: line.category, amount: evaluateAmount(line.amount) ?? 0 })),
    [lines],
  );
  const remainder = splitRemainder(totalValue, parsedLines);

  if (!isOpen) return null;

  const update = (index: number, patch: Partial<{ category: string; amount: string }>) => {
    setLines((current) => current.map((line, at) => (at === index ? { ...line, ...patch } : line)));
    setError('');
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problem = checkSplit(totalValue, parsedLines);
    if (problem) {
      setError(problem);
      return;
    }
    if (!accountId) {
      setError('Choose the account it was paid from.');
      return;
    }
    const ok = onSave({
      accountId,
      date,
      note: note.trim() || undefined,
      paymentMethod: method || undefined,
      lines: parsedLines.filter((line) => line.amount > 0),
    });
    if (ok) onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end sm:justify-center sm:items-center bg-slate-950/70 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="split-title">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 rounded-t-2xl sm:rounded-2xl w-full max-w-md max-h-[92dvh] flex flex-col shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h2 id="split-title" className="text-lg font-bold">Split a payment</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="w-9 h-9 flex items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-4 overflow-y-auto text-sm">
          <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
            Total paid
            <input value={total} onChange={(event) => { setTotal(event.target.value); setError(''); }} inputMode="decimal"
              placeholder="1,850 or 1200+650" className={`${field} mt-1 font-bold text-lg`} autoFocus required />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              Paid from
              <select value={accountId} onChange={(event) => setAccountId(event.target.value)} className={`${field} mt-1`} required>
                {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
              </select>
            </label>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              Paid with
              <select value={method} onChange={(event) => setMethod(event.target.value as PaymentMethod | '')} className={`${field} mt-1`}>
                <option value="">Default</option>
                {PAYMENT_METHODS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              Date
              <input type="date" value={date} onChange={(event) => setDate(event.target.value)} className={`${field} mt-1`} required />
            </label>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              Note
              <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="DMart" maxLength={200} className={`${field} mt-1`} />
            </label>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">Parts</legend>
            {lines.map((line, index) => (
              <div key={index} className="flex gap-2">
                <select aria-label={`Category for part ${index + 1}`} value={line.category} onChange={(event) => update(index, { category: event.target.value })} className={`${field} flex-1 min-w-0`}>
                  {expenseCategories.map((category) => <option key={category} value={category}>{category}</option>)}
                </select>
                <input aria-label={`Amount for part ${index + 1}`} value={line.amount} inputMode="decimal" placeholder="0"
                  onChange={(event) => update(index, { amount: event.target.value })} className={`${field} w-28`} />
                {lines.length > 2 && (
                  <button type="button" aria-label={`Remove part ${index + 1}`} onClick={() => setLines((current) => current.filter((_, at) => at !== index))}
                    className="w-10 shrink-0 flex items-center justify-center rounded-xl text-slate-400 hover:text-rose-600 hover:bg-slate-100 dark:hover:bg-slate-800">
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button type="button" size="sm" variant="ghost" disabled={lines.length >= 8}
                onClick={() => setLines((current) => [...current, { category: expenseCategories[0] ?? 'Other', amount: remainder > 0 ? String(remainder) : '' }])}>
                <Plus className="w-4 h-4" /> Add part
              </Button>
              {totalValue > 0 && (
                <span className={`text-xs font-semibold ${remainder > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'}`}>
                  {remainder > 0 ? `${formatRupees(remainder)} left to assign` : 'All assigned'}
                </span>
              )}
            </div>
          </fieldset>

          {error && <p role="alert" className="rounded-xl bg-rose-50 dark:bg-rose-950 px-3 py-2 text-xs text-rose-700 dark:text-rose-200">{error}</p>}
          <div className="flex gap-2">
            <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>Cancel</Button>
            <Button type="submit" className="flex-1">Save {parsedLines.filter((line) => line.amount > 0).length || ''} entries</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
