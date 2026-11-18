import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { ChevronDown, Landmark, Target } from 'lucide-react';
import type { Account, Debt } from '../../types';
import { debtOutstanding, emiSchedule, loanSummary, nextPayment, payoffPlan } from '../../lib/debtPlanner';
import type { PayoffStrategy } from '../../lib/debtPlanner';
import { evaluateAmount } from '../../lib/quickEntry';
import { formatRupees, fromPaise, toPaise } from '../../lib/money';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';

const shortDate = (date: string) =>
  new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

const field = 'bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500';

/** Under each debt: progress, next payment, EMI details and schedule, and recording a part payment. */
export function DebtLoanPanel({ debt, today, accounts, defaultAccountId, onAddPayment }: {
  debt: Debt;
  today: string;
  /** Active accounts a payment can move through. */
  accounts: Account[];
  defaultAccountId?: string;
  onAddPayment: (id: string, amount: number, date: string, ledger?: { accountId: string }) => boolean;
}) {
  const [showSchedule, setShowSchedule] = useState(false);
  const [paying, setPaying] = useState(false);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today);
  const [error, setError] = useState('');
  const [inLedger, setInLedger] = useState(accounts.length > 0);
  const [accountId, setAccountId] = useState(debt.accountId ?? defaultAccountId ?? accounts[0]?.id ?? '');
  const outstanding = debtOutstanding(debt, today);
  const next = nextPayment(debt, today);
  const summary = loanSummary(debt, today);
  const schedule = useMemo(
    () => (debt.loan && showSchedule ? emiSchedule(debt.amount, debt.loan.annualRate, debt.loan.tenureMonths, debt.loan.firstEmiDate) : []),
    [debt, showSchedule],
  );
  if (debt.paid) return null;
  const paidPaise = toPaise(debt.amount) - toPaise(outstanding);
  const progress = debt.amount > 0 ? Math.min(100, Math.max(0, Math.round((paidPaise / toPaise(debt.amount)) * 100))) : 0;
  const hasDetails = Boolean(debt.loan || debt.payments?.length || next);
  const lent = debt.direction === 'lent';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = evaluateAmount(amount);
    if (value === null) {
      setError('Enter an amount.');
      return;
    }
    if (toPaise(value) > toPaise(outstanding) && !debt.loan) {
      setError(`Only ${formatRupees(outstanding)} is left.`);
      return;
    }
    const saved = onAddPayment(debt.id, value, date, inLedger && accountId ? { accountId } : undefined);
    if (!saved) return;
    setPaying(false);
    setAmount('');
    setError('');
  };

  return (
    <div className="-mt-1 mx-1 rounded-b-xl border border-t-0 border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40 px-3 py-2.5 space-y-2 text-xs">
      {hasDetails && (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-600 dark:text-slate-300">
              {lent ? 'Still to get back' : 'Still to pay'}: <strong className="text-slate-900 dark:text-white tabular-nums">{formatRupees(outstanding)}</strong>
              {paidPaise > 0 && <span className="text-slate-500"> of {formatRupees(debt.amount)}</span>}
            </span>
            {next && (
              <span className={next.overdue ? 'font-bold text-rose-600 dark:text-rose-400' : 'text-slate-500 dark:text-slate-400'}>
                {next.number ? `EMI ${next.number}: ` : next.overdue ? 'Overdue since ' : 'Due '}
                {next.number ? `${formatRupees(next.amount)} on ` : ''}{shortDate(next.date)}
              </span>
            )}
          </div>
          <div className="h-1.5 rounded-full bg-slate-200 dark:bg-slate-800" aria-label={`${progress}% repaid`}>
            <div className="h-1.5 rounded-full bg-emerald-500" style={{ width: `${progress}%` }} />
          </div>
        </>
      )}
      {summary && debt.loan && (
        <p className="text-slate-600 dark:text-slate-300">
          EMI {formatRupees(summary.emi)} · {debt.loan.annualRate}% · {summary.emisPaid}/{summary.emisPaid + summary.emisLeft} paid · ends {shortDate(summary.endDate)} · total interest {formatRupees(summary.totalInterest)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {!paying && (
          <Button size="sm" variant="secondary" onClick={() => setPaying(true)}>
            {debt.loan ? 'Record prepayment' : lent ? 'Record money received' : 'Record part payment'}
          </Button>
        )}
        {debt.loan && (
          <Button size="sm" variant="ghost" onClick={() => setShowSchedule((value) => !value)} aria-expanded={showSchedule}>
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showSchedule ? 'rotate-180' : ''}`} /> EMI schedule
          </Button>
        )}
      </div>
      {paying && (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <label className="font-semibold text-slate-700 dark:text-slate-300">
            Amount
            <input value={amount} onChange={(event) => { setAmount(event.target.value); setError(''); }} inputMode="decimal" autoFocus
              placeholder={debt.loan ? '10000' : String(outstanding)} className={`${field} mt-1 block w-32`} />
          </label>
          <label className="font-semibold text-slate-700 dark:text-slate-300">
            Date
            <input type="date" value={date} max={today} onChange={(event) => setDate(event.target.value)} className={`${field} mt-1 block`} />
          </label>
          {accounts.length > 0 && (
            <>
              <label className="flex items-center gap-1.5 font-semibold text-slate-700 dark:text-slate-300 min-h-9">
                <input type="checkbox" checked={inLedger} onChange={(event) => setInLedger(event.target.checked)} className="w-4 h-4" />
                {lent ? 'Into' : 'From'}
              </label>
              <select aria-label={lent ? 'Received into account' : 'Paid from account'} value={accountId} disabled={!inLedger}
                onChange={(event) => setAccountId(event.target.value)} className={`${field} disabled:opacity-50`}>
                {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
              </select>
            </>
          )}
          <Button type="submit" size="sm">Save</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => { setPaying(false); setError(''); }}>Cancel</Button>
          {accounts.length > 0 && !inLedger && (
            <p className="w-full text-slate-500 dark:text-slate-400">Only the debt changes; no account balance moves.</p>
          )}
          {error && <p role="alert" className="w-full text-rose-600 dark:text-rose-400">{error}</p>}
        </form>
      )}
      {showSchedule && schedule.length > 0 && (
        <div className="max-h-64 overflow-auto rounded-lg border border-slate-200 dark:border-slate-800">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
              <tr><th className="p-1.5 text-left">#</th><th className="p-1.5 text-left">Date</th><th className="p-1.5 text-right">Interest</th><th className="p-1.5 text-right">Principal</th><th className="p-1.5 text-right">Left</th></tr>
            </thead>
            <tbody>
              {schedule.map((row) => (
                <tr key={row.number} className={`border-t border-slate-100 dark:border-slate-800 ${row.dueDate < today ? 'text-slate-400' : ''}`}>
                  <td className="p-1.5">{row.number}</td>
                  <td className="p-1.5">{shortDate(row.dueDate)}</td>
                  <td className="p-1.5 text-right tabular-nums">{formatRupees(row.interest)}</td>
                  <td className="p-1.5 text-right tabular-nums">{formatRupees(row.principal)}</td>
                  <td className="p-1.5 text-right tabular-nums">{formatRupees(row.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** How fast you can be debt-free, and what an extra amount each month changes. */
export function DebtPayoffPlanner({ debts, today }: { debts: Debt[]; today: string }) {
  const [extra, setExtra] = useState('');
  const [strategy, setStrategy] = useState<PayoffStrategy>('avalanche');
  const owed = debts.filter((debt) => debt.direction === 'owed' && !debt.paid && debtOutstanding(debt, today) > 0);
  const extraValue = evaluateAmount(extra) ?? 0;
  const base = useMemo(() => payoffPlan(owed, today, 0, strategy), [owed, today, strategy]);
  const plan = useMemo(() => payoffPlan(owed, today, extraValue, strategy), [owed, today, extraValue, strategy]);
  if (owed.length === 0) return null;
  const hasLoans = owed.some((debt) => debt.loan);
  const monthsSaved = base.months - plan.months;
  const interestSaved = fromPaise(toPaise(base.totalInterest) - toPaise(plan.totalInterest));
  const noSchedule = !hasLoans && extraValue === 0;

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-300 flex items-center justify-center shrink-0"><Target className="w-5 h-5" /></div>
        <div>
          <h4 className="text-sm font-bold text-slate-900 dark:text-white">Debt-free plan</h4>
          <p className="text-xs text-slate-500 dark:text-slate-400">EMIs keep going; an extra amount each month goes to one debt at a time.</p>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
          Extra per month
          <input value={extra} onChange={(event) => setExtra(event.target.value)} inputMode="decimal" placeholder="0" className={`${field} mt-1 block w-32`} />
        </label>
        <div role="radiogroup" aria-label="Order" className="inline-flex p-1 rounded-xl bg-slate-100 dark:bg-slate-800">
          {([['avalanche', 'Highest interest first'], ['snowball', 'Smallest first']] as const).map(([value, label]) => (
            <button key={value} type="button" role="radio" aria-checked={strategy === value} onClick={() => setStrategy(value)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold ${strategy === value ? 'bg-white dark:bg-slate-700 text-indigo-700 dark:text-indigo-300 shadow-sm' : 'text-slate-500 dark:text-slate-400'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {noSchedule ? (
        <p className="text-xs text-slate-600 dark:text-slate-300">No EMI set. Enter a monthly payment to see your payoff date.</p>
      ) : (
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl bg-slate-50 dark:bg-slate-800/60 p-2">
            <div className="text-[11px] text-slate-500 dark:text-slate-400">Debt-free by</div>
            <div className="text-sm font-black text-slate-900 dark:text-white">{plan.months >= 600 ? 'Never' : shortDate(plan.debtFreeDate)}</div>
          </div>
          <div className="rounded-xl bg-slate-50 dark:bg-slate-800/60 p-2">
            <div className="text-[11px] text-slate-500 dark:text-slate-400">Interest to pay</div>
            <div className="text-sm font-black text-slate-900 dark:text-white tabular-nums">{formatRupees(plan.totalInterest)}</div>
          </div>
          <div className="rounded-xl bg-emerald-50 dark:bg-emerald-950/50 p-2">
            <div className="text-[11px] text-emerald-800 dark:text-emerald-200">Extra saves</div>
            <div className="text-sm font-black text-emerald-800 dark:text-emerald-200">
              {extraValue > 0 && hasLoans ? `${monthsSaved} mo · ${formatRupees(interestSaved)}` : '–'}
            </div>
          </div>
        </div>
      )}
      {!noSchedule && plan.order.length > 1 && (
        <ol className="flex flex-wrap gap-1.5 text-[11px]">
          {plan.order.map((item, index) => (
            <li key={item.id} className="inline-flex items-center gap-1 rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-1">
              <Landmark className="w-3 h-3" /> {index + 1}. {item.name} · month {item.month}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
