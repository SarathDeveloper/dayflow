import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Repeat, TrendingDown, TrendingUp } from 'lucide-react';
import type { Account, BillPayment, Debt, FinanceTransaction } from '../../types';
import { categoryTrends, netWorthSeries, yearReport } from '../../lib/moneyReports';
import { findSubscriptions } from '../../lib/moneyForecast';
import { formatRupees, formatRupeesCompact, fromPaise, toPaise } from '../../lib/money';
import { monthKeyOf } from '../../lib/ledger';
import { Card } from '../ui/Card';

interface Props {
  /** Spending view: without savings-only banks' own entries. */
  transactions: FinanceTransaction[];
  /** Every entry, for net worth. */
  allTransactions?: FinanceTransaction[];
  accounts: Account[];
  debts: Debt[];
  billPayments: BillPayment[];
  today: string;
}

const MONTH_LETTERS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const monthShort = (key: string) =>
  new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1).toLocaleDateString('en-IN', { month: 'short' });

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <Card className="p-3">
      <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`text-base sm:text-lg font-black tabular-nums truncate ${tone === 'good' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'bad' ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900 dark:text-white'}`}>{value}</div>
    </Card>
  );
}

/** Year view, category trends, net worth over time and likely subscriptions. */
export function MoneyReports({ transactions, allTransactions, accounts, debts, billPayments, today }: Props) {
  const thisYear = Number(today.slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const report = useMemo(() => yearReport(transactions, year), [transactions, year]);
  const lastMonth = year === thisYear ? monthKeyOf(today) : `${year}-12`;
  const trends = useMemo(() => categoryTrends(transactions, lastMonth, 6), [transactions, lastMonth]);
  // Net worth counts every account, savings-only banks included.
  const worth = useMemo(() => netWorthSeries(accounts, allTransactions ?? transactions, debts, lastMonth, today, 12), [accounts, allTransactions, transactions, debts, lastMonth, today]);
  const subscriptions = useMemo(() => findSubscriptions(transactions, billPayments, today), [transactions, billPayments, today]);
  const maxMonth = Math.max(1, ...report.months.map((month) => Math.max(month.income, month.expense)));
  const firstYear = useMemo(() => transactions.reduce((min, tx) => Math.min(min, Number(tx.date.slice(0, 4)) || min), thisYear), [transactions, thisYear]);

  // Net worth line in a 300×90 box.
  const worthValues = worth.map((point) => point.netWorth);
  const low = Math.min(...worthValues, 0);
  const high = Math.max(...worthValues, 1);
  const points = worth.map((point, index) => {
    const x = (index / Math.max(1, worth.length - 1)) * 300;
    const y = 85 - ((point.netWorth - low) / (high - low || 1)) * 80;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const latest = worth[worth.length - 1];
  const first = worth.find((point) => point.netWorth !== 0) ?? worth[0];
  const worthChange = latest && first ? fromPaise(toPaise(latest.netWorth) - toPaise(first.netWorth)) : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-900 dark:text-white">Year {year}</h3>
        <div className="flex gap-1">
          <button type="button" aria-label="Previous year" disabled={year <= firstYear} onClick={() => setYear((value) => value - 1)}
            className="w-9 h-9 flex items-center justify-center rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30"><ChevronLeft className="w-4 h-4" /></button>
          <button type="button" aria-label="Next year" disabled={year >= thisYear} onClick={() => setYear((value) => value + 1)}
            className="w-9 h-9 flex items-center justify-center rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30"><ChevronRight className="w-4 h-4" /></button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Kpi label="Income" value={formatRupees(report.income)} />
        <Kpi label="Spent" value={formatRupees(report.expense)} />
        <Kpi label="Left over" value={formatRupees(report.net)} tone={report.net >= 0 ? 'good' : 'bad'} />
        <Kpi label="Savings rate" value={`${report.savingsRate}%`} tone={report.savingsRate >= 20 ? 'good' : undefined} />
      </div>

      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-xs font-bold text-slate-700 dark:text-slate-300">Income and spending by month</h4>
          <div className="flex gap-3 text-[11px] text-slate-500 dark:text-slate-400">
            <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" />Income</span>
            <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-rose-500" />Spent</span>
          </div>
        </div>
        <div className="flex items-end gap-1 sm:gap-2 h-36" role="img" aria-label={`Monthly income and spending for ${year}`}>
          {report.months.map((month, index) => (
            <div key={month.monthKey} className="flex-1 flex flex-col items-center gap-1 h-full justify-end"
              title={`${monthShort(month.monthKey)}: income ${formatRupees(month.income)}, spent ${formatRupees(month.expense)}`}>
              <div className="w-full flex items-end justify-center gap-0.5 flex-1">
                <div className="w-1/2 max-w-3 rounded-t bg-emerald-500" style={{ height: `${(month.income / maxMonth) * 100}%` }} />
                <div className="w-1/2 max-w-3 rounded-t bg-rose-500" style={{ height: `${(month.expense / maxMonth) * 100}%` }} />
              </div>
              <span className="text-[10px] text-slate-500 dark:text-slate-400">{MONTH_LETTERS[index]}</span>
            </div>
          ))}
        </div>
        {report.biggestMonth && (
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            Highest spending: {monthShort(report.biggestMonth.monthKey)} ({formatRupees(report.biggestMonth.expense)}).
          </p>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h4 className="text-xs font-bold text-slate-700 dark:text-slate-300 mb-2">Net worth</h4>
          {latest && (
            <>
              <div className="flex items-baseline gap-2">
                <span className="text-xl font-black tabular-nums text-slate-900 dark:text-white">{formatRupees(latest.netWorth)}</span>
                {worthChange !== 0 && (
                  <span className={`text-xs font-bold inline-flex items-center gap-0.5 ${worthChange > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                    {worthChange > 0 ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                    {formatRupeesCompact(Math.abs(worthChange))} in 12 months
                  </span>
                )}
              </div>
              <svg viewBox="0 0 300 90" className="w-full h-24 mt-2" role="img" aria-label="Net worth over the last 12 months">
                <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" className="text-indigo-500" vectorEffect="non-scaling-stroke" />
              </svg>
              <div className="flex justify-between text-[10px] text-slate-500 dark:text-slate-400">
                <span>{monthShort(worth[0].monthKey)}</span><span>{monthShort(latest.monthKey)}</span>
              </div>
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                Accounts {formatRupees(latest.accounts)} + lent {formatRupees(latest.lent)} − owed {formatRupees(latest.owed)}
              </p>
            </>
          )}
        </Card>

        <Card className="p-4">
          <h4 className="text-xs font-bold text-slate-700 dark:text-slate-300 mb-2">Where it went in {year}</h4>
          {report.topCategories.length === 0 ? <p className="text-xs text-slate-500">No spending recorded.</p> : (
            <ul className="space-y-2">
              {report.topCategories.map((item) => (
                <li key={item.category}>
                  <div className="flex justify-between text-xs"><span className="truncate">{item.category}</span><span className="font-bold tabular-nums">{formatRupees(item.amount)} · {item.share}%</span></div>
                  <div className="mt-1 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800"><div className="h-1.5 rounded-full bg-indigo-500" style={{ width: `${item.share}%` }} /></div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="p-4 overflow-x-auto">
        <h4 className="text-xs font-bold text-slate-700 dark:text-slate-300 mb-2">Category trends (6 months)</h4>
        {trends.trends.length === 0 ? <p className="text-xs text-slate-500">No spending in these months.</p> : (
          <table className="w-full text-xs min-w-[420px]">
            <thead>
              <tr className="text-slate-500 dark:text-slate-400">
                <th className="text-left font-semibold py-1">Category</th>
                {trends.months.map((month) => <th key={month} className="text-right font-semibold py-1">{monthShort(month)}</th>)}
                <th className="text-right font-semibold py-1">Change</th>
              </tr>
            </thead>
            <tbody>
              {trends.trends.slice(0, 8).map((trend) => (
                <tr key={trend.category} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="py-1.5 pr-2 font-semibold truncate max-w-[8rem]">{trend.category}</td>
                  {trend.amounts.map((amount, index) => (
                    <td key={trends.months[index]} className="py-1.5 text-right tabular-nums text-slate-700 dark:text-slate-300">{amount ? formatRupeesCompact(amount) : '–'}</td>
                  ))}
                  <td className={`py-1.5 text-right font-bold tabular-nums ${trend.change === null ? 'text-slate-400' : trend.change > 15 ? 'text-rose-600 dark:text-rose-400' : trend.change < -15 ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500'}`}>
                    {trend.change === null ? 'new' : `${trend.change > 0 ? '+' : ''}${trend.change}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">Change compares the latest month with the average of the five before it.</p>
      </Card>

      <Card className="p-4">
        <h4 className="text-xs font-bold text-slate-700 dark:text-slate-300 mb-2 flex items-center gap-1"><Repeat className="w-3.5 h-3.5" /> Repeating payments</h4>
        {subscriptions.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">No monthly repeating payments found in the last 6 months.</p>
        ) : (
          <>
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {subscriptions.map((item) => (
                <li key={`${item.name}-${item.amount}`} className="flex items-center justify-between gap-2 py-2 text-xs">
                  <span className="min-w-0">
                    <span className="block font-semibold truncate">{item.name}</span>
                    <span className="text-slate-500 dark:text-slate-400">{item.category} · seen in {item.months.length} months</span>
                  </span>
                  <span className="text-right shrink-0">
                    <span className="block font-bold tabular-nums">{formatRupees(item.amount)}/mo</span>
                    <span className="text-slate-500 dark:text-slate-400">{formatRupees(item.yearly)}/yr</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">Cancel unused ones, or add the rest as Bills for your forecast.</p>
          </>
        )}
      </Card>
    </div>
  );
}
