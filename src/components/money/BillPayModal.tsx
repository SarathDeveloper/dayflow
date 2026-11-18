import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { X } from 'lucide-react';
import type { Account, BillPayment, BillTemplate, PaymentMethod } from '../../types';
import { evaluateAmount } from '../../lib/quickEntry';
import { formatRupees } from '../../lib/money';
import { PAYMENT_METHODS } from '../../data/financeCategories';
import { Button } from '../ui/Button';

const field = 'mt-1 w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500';

interface Props {
  payment: BillPayment | null;
  template?: BillTemplate;
  accounts: Account[];
  defaultAccountId?: string;
  today: string;
  onClose: () => void;
  /** False keeps the form open (the account could not cover it). */
  onPay: (payment: BillPayment, details: { amount: number; accountId: string; date: string; paymentMethod?: PaymentMethod }) => boolean;
}

/** Paying a bill: what was paid, from which account, on which day. */
export function BillPayModal({ payment, template, accounts, defaultAccountId, today, onClose, onPay }: Props) {
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [date, setDate] = useState(today);
  const [method, setMethod] = useState<PaymentMethod | ''>('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!payment) return;
    setAmount(String(payment.amount));
    setAccountId(template?.accountId && accounts.some((a) => a.id === template.accountId) ? template.accountId : defaultAccountId ?? accounts[0]?.id ?? '');
    // Paying before the due date is normal; a past month's bill defaults to its due date.
    setDate(payment.dueDate < today.slice(0, 7) + '-01' ? payment.dueDate : today);
    setMethod(template?.paymentMethod ?? '');
    setError('');
  }, [payment, template, accounts, defaultAccountId, today]);

  if (!payment) return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = evaluateAmount(amount);
    if (value === null) {
      setError('Enter the amount paid.');
      return;
    }
    if (!accountId) {
      setError('Choose the account it was paid from.');
      return;
    }
    if (onPay(payment, { amount: value, accountId, date, paymentMethod: method || undefined })) onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end sm:justify-center sm:items-center bg-slate-950/70 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="bill-pay-title">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 rounded-t-2xl sm:rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <h2 id="bill-pay-title" className="text-lg font-bold">Pay {template?.name ?? 'bill'}</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">Due {payment.dueDate} · usually {formatRupees(payment.amount)}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="w-9 h-9 flex items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-4 text-sm">
          <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
            Amount paid
            <input value={amount} onChange={(event) => { setAmount(event.target.value); setError(''); }} inputMode="decimal" autoFocus className={`${field} font-bold text-lg`} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              Paid from
              <select value={accountId} onChange={(event) => setAccountId(event.target.value)} className={field} required>
                {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
              </select>
            </label>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              Paid on
              <input type="date" value={date} max={today} onChange={(event) => setDate(event.target.value)} className={field} required />
            </label>
          </div>
          <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
            Paid with
            <select value={method} onChange={(event) => setMethod(event.target.value as PaymentMethod | '')} className={field}>
              <option value="">Default</option>
              {PAYMENT_METHODS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <p className="text-xs text-slate-500 dark:text-slate-400">This adds the expense to the ledger. Already entered it yourself? Cancel; Dayflow offers to link a matching expense when you save it.</p>
          {error && <p role="alert" className="rounded-xl bg-rose-50 dark:bg-rose-950 px-3 py-2 text-xs text-rose-700 dark:text-rose-200">{error}</p>}
          <div className="flex gap-2">
            <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>Cancel</Button>
            <Button type="submit" className="flex-1">Mark paid</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
