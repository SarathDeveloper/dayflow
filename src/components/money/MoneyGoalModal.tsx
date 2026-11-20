import React, { useEffect, useState } from 'react';
import { Target, X } from 'lucide-react';
import type { Account, MoneyGoal } from '../../types';
import { Button } from '../ui/Button';
import { showConfirm } from '../ui/AppDialog';

interface Props {
  isOpen: boolean;
  goal: MoneyGoal | null;
  /** Accounts a goal can follow: savings-only banks first, then other savings accounts. */
  accounts: Account[];
  onClose: () => void;
  onSave: (goal: Partial<MoneyGoal>) => boolean;
  onDelete: (id: string) => void;
}

const field =
  'w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2.5 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500';

/** Add or edit a named savings goal, e.g. "Emergency fund ₹1,00,000 by March". */
export function MoneyGoalModal({ isOpen, goal, accounts, onClose, onSave, onDelete }: Props) {
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [accountId, setAccountId] = useState('');
  const [saved, setSaved] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setName(goal?.name ?? '');
    setTarget(goal ? String(goal.target) : '');
    setTargetDate(goal?.targetDate ?? '');
    setAccountId(goal?.accountId ?? (goal ? '' : accounts.find((a) => a.savingsOnly)?.id ?? ''));
    setSaved(goal?.savedAmount ? String(goal.savedAmount) : '');
  }, [isOpen, goal, accounts]);

  if (!isOpen) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const amount = Number(target.replace(/[₹,\s]/g, ''));
    if (!name.trim()) return setError('Give the goal a name.');
    if (!(amount > 0)) return setError('Enter the amount to reach.');
    const savedAmount = Number(saved.replace(/[₹,\s]/g, '')) || 0;
    const ok = onSave({
      id: goal?.id,
      name: name.trim(),
      target: Math.round(amount * 100) / 100,
      targetDate: targetDate || undefined,
      accountId: accountId || undefined,
      savedAmount: accountId ? undefined : Math.max(0, Math.round(savedAmount * 100) / 100),
    });
    if (ok) onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end sm:justify-center sm:items-center p-0 sm:p-4 bg-slate-950/70 backdrop-blur-sm">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-2xl w-full max-w-md max-h-[92dvh] flex flex-col shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Target className="w-5 h-5 text-emerald-600" />
            {goal ? 'Edit goal' : 'New savings goal'}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="w-9 h-9 flex items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-4 overflow-y-auto text-sm">
          {error && (
            <p role="alert" className="text-xs font-semibold text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 rounded-xl px-3 py-2">
              {error}
            </p>
          )}
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Emergency fund" className={field} autoFocus />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">Amount ₹</span>
              <input value={target} onChange={(e) => setTarget(e.target.value)} inputMode="decimal" placeholder="100000" className={field} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">By (optional)</span>
              <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} className={field} />
            </label>
          </div>
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">Saved in</span>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={field}>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                  {account.savingsOnly ? ' (future savings)' : ''}
                </option>
              ))}
              <option value="">No account, I'll type it</option>
            </select>
            <span className="block text-[11px] text-slate-500 dark:text-slate-400">
              {accountId ? "That account's balance counts as saved." : 'Update the saved amount yourself.'}
            </span>
          </label>
          {!accountId && (
            <label className="block space-y-1">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">Saved so far ₹</span>
              <input value={saved} onChange={(e) => setSaved(e.target.value)} inputMode="decimal" placeholder="0" className={field} />
            </label>
          )}
          <div className="flex gap-2 pt-1">
            {goal && (
              <Button
                type="button"
                variant="ghost"
                onClick={async () => {
                  const ok = await showConfirm({
                    title: `Delete "${goal.name}"?`,
                    message: 'Only the goal goes; money and entries stay.',
                    tone: 'danger',
                    confirmLabel: 'Delete',
                  });
                  if (!ok) return;
                  onDelete(goal.id);
                  onClose();
                }}
              >
                Delete
              </Button>
            )}
            <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" className="flex-1">
              Save
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
