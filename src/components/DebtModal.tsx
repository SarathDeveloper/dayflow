import React, { useState, useEffect } from 'react';
import { X, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { Account, Debt, DebtDirection, PaymentMethod } from '../types';
import { addMonths, emiAmount } from '../lib/debtPlanner';
import { formatRupees } from '../lib/money';
import { PAYMENT_METHODS } from '../data/financeCategories';
import { Button } from './ui/Button';

interface DebtModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** With `ledger`, the borrowed / lent money is also recorded in that account. False keeps the form open. */
  onSave: (debt: Partial<Debt>, ledger?: { accountId: string; paymentMethod?: PaymentMethod }) => boolean | void;
  initialDebt?: Debt | null;
  selectedDate: string;
  /** Active accounts the money can move through. */
  accounts?: Account[];
  defaultAccountId?: string;
}

export const DebtModal: React.FC<DebtModalProps> = ({
  isOpen,
  onClose,
  onSave,
  initialDebt,
  selectedDate,
  accounts = [],
  defaultAccountId,
}) => {
  const [recordInLedger, setRecordInLedger] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | ''>('');
  const [direction, setDirection] = useState<DebtDirection>('lent');
  const [personName, setPersonName] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(selectedDate);
  const [dueDate, setDueDate] = useState('');
  const [note, setNote] = useState('');
  const [isLoan, setIsLoan] = useState(false);
  const [rate, setRate] = useState('');
  const [tenure, setTenure] = useState('');
  const [firstEmi, setFirstEmi] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    if (initialDebt) {
      setDirection(initialDebt.direction);
      setPersonName(initialDebt.personName);
      setAmount(String(initialDebt.amount));
      setDate(initialDebt.date);
      setDueDate(initialDebt.dueDate || '');
      setNote(initialDebt.note || '');
      setIsLoan(Boolean(initialDebt.loan));
      setRate(initialDebt.loan ? String(initialDebt.loan.annualRate) : '');
      setTenure(initialDebt.loan ? String(initialDebt.loan.tenureMonths) : '');
      setFirstEmi(initialDebt.loan?.firstEmiDate ?? '');
      // A linked debt keeps its entry in step; an older one can be linked now.
      setRecordInLedger(Boolean(initialDebt.transactionId));
      setAccountId(initialDebt.accountId ?? defaultAccountId ?? accounts[0]?.id ?? '');
      setPaymentMethod('');
    } else {
      setRecordInLedger(accounts.length > 0);
      setAccountId(defaultAccountId ?? accounts[0]?.id ?? '');
      setPaymentMethod('');
      setDirection('lent');
      setPersonName('');
      setAmount('');
      setDate(selectedDate);
      setDueDate('');
      setNote('');
      setIsLoan(false);
      setRate('');
      setTenure('');
      setFirstEmi('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDebt, selectedDate, isOpen]);

  if (!isOpen) return null;

  const rateValue = Number(rate || 0);
  const tenureValue = Math.round(Number(tenure));
  const loanValid = isLoan && rateValue >= 0 && rateValue <= 60 && tenureValue >= 1 && tenureValue <= 480;
  const previewEmi = loanValid ? emiAmount(parseFloat(amount) || 0, rateValue, tenureValue) : 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseFloat(amount);
    if (!parsed || parsed <= 0 || Number.isNaN(parsed)) return;
    if (!personName.trim()) return;
    if (isLoan && !loanValid) return;

    if (recordInLedger && !accountId) return;

    const saved = onSave(
      {
        loan: isLoan
          ? { annualRate: rateValue, tenureMonths: tenureValue, firstEmiDate: firstEmi || addMonths(date, 1) }
          : undefined,
        id: initialDebt?.id,
        direction,
        personName: personName.trim(),
        amount: Math.round(parsed * 100) / 100,
        date,
        dueDate: dueDate || undefined,
        note: note.trim() || undefined,
      },
      recordInLedger && accountId ? { accountId, paymentMethod: paymentMethod || undefined } : undefined
    );
    if (saved !== false) onClose();
  };

  const linked = Boolean(initialDebt?.transactionId);
  const moneyWord = direction === 'owed' ? 'Received into' : 'Paid from';

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end sm:justify-center sm:items-center p-0 sm:p-4 bg-slate-950/70 backdrop-blur-sm overflow-y-auto">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 rounded-t-2xl sm:rounded-2xl w-full min-w-0 max-w-md max-h-[92dvh] sm:max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/80 dark:bg-slate-900/90 shrink-0">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">
            {initialDebt ? 'Edit Debt' : 'Add Debt'}
          </h2>
          <button
            onClick={onClose}
            className="w-9 h-9 flex items-center justify-center rounded-xl text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 overflow-y-auto flex-1 text-sm">
          {/* Direction toggle */}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setDirection('lent')}
              className={`flex items-center justify-center gap-2 py-2.5 rounded-xl border font-bold text-sm transition-colors ${
                direction === 'lent'
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300'
                  : 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400'
              }`}
            >
              <ArrowUpRight className="w-4 h-4" />
              Lent (receivable)
            </button>
            <button
              type="button"
              onClick={() => setDirection('owed')}
              className={`flex items-center justify-center gap-2 py-2.5 rounded-xl border font-bold text-sm transition-colors ${
                direction === 'owed'
                  ? 'bg-rose-50 dark:bg-rose-950/40 border-rose-300 dark:border-rose-700 text-rose-700 dark:text-rose-300'
                  : 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400'
              }`}
            >
              <ArrowDownRight className="w-4 h-4" />
              Owed (payable)
            </button>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              Person Name *
            </label>
            <input
              type="text"
              required
              value={personName}
              onChange={(e) => setPersonName(e.target.value)}
              placeholder="e.g. Rahul, Priya..."
              className="w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3.5 py-2.5 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-medium"
              autoFocus
            />
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
                type="number"
                required
                min="0.01"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl pl-8 pr-3.5 py-2.5 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-bold text-lg"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Date
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
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Due Date (optional)
              </label>
              <input
                type="date"
                value={dueDate}
                min={date}
                onChange={(e) => setDueDate(e.target.value)}
                className="w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2.5 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>

          {accounts.length > 0 && (
            <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3 space-y-3">
              <label className="flex items-start gap-2 font-semibold text-slate-700 dark:text-slate-300">
                <input type="checkbox" checked={recordInLedger} disabled={linked}
                  onChange={(e) => setRecordInLedger(e.target.checked)} className="w-4 h-4 mt-0.5" />
                <span>
                  {linked ? 'Recorded in the ledger' : initialDebt ? 'Add this money to the ledger now' : 'Record the money in the ledger'}
                  <span className="block text-xs font-normal text-slate-500 dark:text-slate-400">
                    {direction === 'owed'
                      ? 'Goes into the account. Not counted as income.'
                      : 'Leaves the account. Not counted as spending.'}
                  </span>
                </span>
              </label>
              {recordInLedger && (
                <div className="grid grid-cols-2 gap-3">
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                    {moneyWord}
                    <select value={accountId} onChange={(e) => setAccountId(e.target.value)} required
                      className="mt-1 w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2.5 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
                      {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
                    </select>
                  </label>
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                    Via
                    <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod | '')}
                      className="mt-1 w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2.5 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
                      <option value="">Default</option>
                      {PAYMENT_METHODS.map((method) => <option key={method.value} value={method.value}>{method.label}</option>)}
                    </select>
                  </label>
                </div>
              )}
            </div>
          )}

          <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3 space-y-3">
            <label className="flex items-center gap-2 font-semibold text-slate-700 dark:text-slate-300">
              <input type="checkbox" checked={isLoan} onChange={(e) => setIsLoan(e.target.checked)} className="w-4 h-4" />
              Loan repaid in EMIs (home, car, personal, credit card)
            </label>
            {isLoan && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                    Interest (% per year)
                    <input type="number" inputMode="decimal" min="0" max="60" step="0.01" value={rate}
                      onChange={(e) => setRate(e.target.value)} placeholder="10.5"
                      className="mt-1 w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2.5 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  </label>
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                    Tenure (months)
                    <input type="number" inputMode="numeric" min="1" max="480" step="1" required value={tenure}
                      onChange={(e) => setTenure(e.target.value)} placeholder="24"
                      className="mt-1 w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2.5 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  </label>
                </div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                  First EMI date
                  <input type="date" value={firstEmi || addMonths(date, 1)} min={date}
                    onChange={(e) => setFirstEmi(e.target.value)}
                    className="mt-1 w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2.5 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </label>
                <p className="text-xs text-slate-600 dark:text-slate-300" aria-live="polite">
                  {previewEmi > 0 ? <>EMI: <strong>{formatRupees(previewEmi)}</strong> per month for {tenureValue} months</> : 'Enter the amount, interest and tenure to see the EMI.'}
                </p>
              </>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              Note (optional)
            </label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. For dinner, loan for bike..."
              className="w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3.5 py-2.5 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div className="flex gap-2 pt-2 pb-1">
            <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" className="flex-1">
              {initialDebt ? 'Save Changes' : 'Add Debt'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};
