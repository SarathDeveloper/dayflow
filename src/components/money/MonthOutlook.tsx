import { useState } from 'react';
import { CalendarClock, ChevronDown, Gauge, TrendingDown } from 'lucide-react';
import type { MonthForecast } from '../../lib/moneyForecast';
import { formatRupees, fromPaise, toPaise } from '../../lib/money';
import { Card } from '../ui/Card';

const shortDate = (date: string) =>
  new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

const TONE = {
  comfortable: { box: 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-900 dark:text-emerald-100', label: 'On track' },
  tight: { box: 'bg-amber-50 dark:bg-amber-950/50 text-amber-950 dark:text-amber-100', label: 'Spending faster than planned' },
  over: { box: 'bg-rose-50 dark:bg-rose-950/50 text-rose-900 dark:text-rose-100', label: 'Over budget' },
} as const;

/** "Safe to spend per day", where the month ends up, and the bills still due. */
export function MonthOutlook({ forecast }: { forecast: MonthForecast }) {
  const [open, setOpen] = useState(false);
  const tone = TONE[forecast.status];
  const overBudget = forecast.budget !== null ? fromPaise(toPaise(forecast.projectedSpend) - toPaise(forecast.budget)) : 0;
  const restOfMonth = fromPaise(Math.max(0, toPaise(forecast.projectedSpend) - toPaise(forecast.spentSoFar) - toPaise(forecast.billsDueTotal)));

  return (
    <Card className="overflow-hidden">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}
        className="w-full p-4 flex items-center gap-4 text-left">
        <div className={`rounded-2xl px-4 py-3 shrink-0 ${tone.box}`}>
          <div className="text-[11px] font-semibold flex items-center gap-1"><Gauge className="w-3.5 h-3.5" /> Safe to spend</div>
          <div className="text-xl font-black tabular-nums">{formatRupees(forecast.safePerDay)}<span className="text-xs font-semibold">/day</span></div>
        </div>
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-bold text-slate-900 dark:text-white">{tone.label}</p>
          <p className="text-xs text-slate-600 dark:text-slate-300">
            {forecast.basis === 'budget'
              ? <>Month will cost about <strong>{formatRupees(forecast.projectedSpend)}</strong> of your {formatRupees(forecast.budget ?? 0)} budget{overBudget > 0 ? ` (${formatRupees(overBudget)} over)` : ''}.</>
              : <>About <strong>{formatRupees(forecast.projectedEndBalance)}</strong> left at month end, before any more income.</>}
          </p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            {forecast.daysLeft} {forecast.daysLeft === 1 ? 'day' : 'days'} left · your pace {formatRupees(forecast.dailyPace)}/day
            {forecast.billsDue.length ? ` · ${forecast.billsDue.length} ${forecast.billsDue.length === 1 ? 'bill' : 'bills'} due` : ''}
          </p>
        </div>
        <ChevronDown className={`w-4 h-4 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="border-t border-slate-200 dark:border-slate-800 p-4 grid gap-4 sm:grid-cols-2 text-sm">
          <dl className="space-y-1.5">
            {[
              ['Spent so far', forecast.spentSoFar],
              ['Bills still due', forecast.billsDueTotal],
              ['Expected rest of month', restOfMonth],
              ['Projected month total', forecast.projectedSpend],
              ['Cash and bank now', forecast.balanceNow],
              ['Projected month-end balance', forecast.projectedEndBalance],
            ].map(([label, value]) => (
              <div key={label as string} className="flex justify-between gap-2">
                <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
                <dd className={`font-bold tabular-nums ${(value as number) < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900 dark:text-white'}`}>{formatRupees(value as number)}</dd>
              </div>
            ))}
            <p className="pt-1 text-[11px] text-slate-500 dark:text-slate-400 flex gap-1">
              <TrendingDown className="w-3.5 h-3.5 shrink-0" />
              Pace = average day-to-day spending over the last 30 days; bills and monthly repeating payments (rent, subscriptions) left out.
              {forecast.basis === 'balance' ? ' Set a monthly budget to plan against it instead of your balance.' : ''}
            </p>
          </dl>
          <div>
            <h4 className="text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5 flex items-center gap-1"><CalendarClock className="w-3.5 h-3.5" /> Bills due this month</h4>
            {forecast.billsDue.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">Nothing left to pay this month.</p>
            ) : (
              <ul className="space-y-1">
                {forecast.billsDue.map((bill) => (
                  <li key={bill.billId} className="flex justify-between gap-2 text-xs">
                    <span className="truncate">
                      {bill.name}
                      <span className={`ml-1.5 ${bill.overdue ? 'font-bold text-rose-600 dark:text-rose-400' : 'text-slate-500 dark:text-slate-400'}`}>
                        {bill.overdue ? `overdue since ${shortDate(bill.dueDate)}` : shortDate(bill.dueDate)}
                      </span>
                    </span>
                    <span className="font-bold tabular-nums">{formatRupees(bill.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
