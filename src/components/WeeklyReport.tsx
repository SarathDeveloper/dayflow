import React, { useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, CalendarRange, ChevronLeft, ChevronRight, Minus, X } from 'lucide-react';
import { Card } from './ui/Card';
import { Button } from './ui/Button';
import { cn } from '../lib/cn';
import { formatShortDate } from '../lib/dateFormat';
import { formatMinutes } from '../lib/focusSessions';
import { addDays } from '../lib/habits';
import { formatRupees } from '../lib/money';
import { buildWeeklyReport, type WeeklyReportInput } from '../lib/weeklyReport';

function weekLabel(start: string): string {
  return `${formatShortDate(start)} – ${formatShortDate(addDays(start, 6))}`;
}

/** Shown on Today when a report is ready and not yet opened. */
export const WeeklyReportCard: React.FC<{ weekStart: string; onOpen: () => void }> = ({ weekStart, onOpen }) => (
  <Card className="p-3 flex items-center gap-3 border-indigo-200 dark:border-indigo-900/60 bg-indigo-50/60 dark:bg-indigo-950/30">
    <div className="w-9 h-9 rounded-xl bg-indigo-600 text-white flex items-center justify-center shrink-0">
      <CalendarRange className="w-4 h-4" />
    </div>
    <div className="min-w-0 flex-1">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-indigo-500 dark:text-indigo-300">Weekly report</p>
      <p className="text-sm font-bold text-slate-900 dark:text-white truncate">Your week is ready to review</p>
      <p className="text-[11px] text-slate-500 dark:text-slate-400">{weekLabel(weekStart)}</p>
    </div>
    <Button type="button" onClick={onOpen}>
      Open
    </Button>
  </Card>
);

type Direction = 'higher-is-better' | 'lower-is-better';

const Delta: React.FC<{ now: number | null; before: number | null; direction?: Direction; format: (n: number) => string }> = ({
  now,
  before,
  direction = 'higher-is-better',
  format,
}) => {
  if (now === null || before === null) return <span className="text-[11px] text-slate-400">no data last week</span>;
  const diff = Math.round((now - before) * 100) / 100;
  if (diff === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[11px] text-slate-400">
        <Minus className="h-3 w-3" /> same as last week
      </span>
    );
  }
  const better = direction === 'higher-is-better' ? diff > 0 : diff < 0;
  const Icon = diff > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-[11px] font-semibold', better ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
      <Icon className="h-3 w-3" />
      {diff > 0 ? '+' : '−'}
      {format(Math.abs(diff))} vs last week
    </span>
  );
};

const Stat: React.FC<{ label: string; value: string; children: React.ReactNode }> = ({ label, value, children }) => (
  <div className="rounded-xl bg-slate-50 dark:bg-slate-800/60 p-3">
    <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
    <p className="text-lg font-extrabold text-slate-900 dark:text-white">{value}</p>
    {children}
  </div>
);

interface WeeklyReportSheetProps {
  input: WeeklyReportInput;
  today: string;
  initialWeekStart: string;
  onClose: () => void;
}

/** The full report for one week, with arrows to step through earlier weeks. */
export const WeeklyReportSheet: React.FC<WeeklyReportSheetProps> = ({ input, today, initialWeekStart, onClose }) => {
  const [weekStart, setWeekStart] = useState(initialWeekStart);
  const report = useMemo(() => buildWeeklyReport(input, weekStart, today), [input, weekStart, today]);
  const { current, previous } = report;
  const pct = (n: number) => `${Math.round(n)}%`;
  const canGoForward = addDays(weekStart, 7) <= today;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end sm:justify-center sm:items-center bg-slate-950/70 backdrop-blur-sm p-0 sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="weekly-report-title"
        className="w-full max-w-lg max-h-[92dvh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xl"
      >
        <div className="sticky top-0 flex items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 px-5 py-4 backdrop-blur">
          <div>
            <h2 id="weekly-report-title" className="text-base font-bold text-slate-900 dark:text-white">
              Weekly report
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">{weekLabel(weekStart)}</p>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => setWeekStart(addDays(weekStart, -7))} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Previous week">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setWeekStart(addDays(weekStart, 7))}
              disabled={!canGoForward}
              className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30"
              aria-label="Next week"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <button type="button" onClick={onClose} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="space-y-5 p-5">
          {report.habits.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">Your areas</h3>
              <ul className="divide-y divide-slate-100 dark:divide-slate-800 rounded-xl border border-slate-200 dark:border-slate-800">
                {report.habits.map((line) => (
                  <li key={line.habitId} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <span className="min-w-0 truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{line.title}</span>
                    <span className="text-right">
                      <span className="block text-sm font-bold text-slate-900 dark:text-white">
                        {line.total} {line.unit}
                      </span>
                      <Delta now={line.total} before={line.previous} format={(n) => `${n} ${line.unit}`} />
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="space-y-2">
            <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">The week</h3>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Habit completion" value={current.habitRate === null ? '—' : pct(current.habitRate)}>
                <Delta now={current.habitRate} before={previous.habitRate} format={pct} />
              </Stat>
              <Stat label="Daily score (avg)" value={current.progressAverage === null ? '—' : pct(current.progressAverage)}>
                <Delta now={current.progressAverage} before={previous.progressAverage} format={pct} />
              </Stat>
              <Stat label="Focus time" value={formatMinutes(current.focusMinutes)}>
                <Delta now={current.focusMinutes} before={previous.focusMinutes} format={formatMinutes} />
              </Stat>
              <Stat label="Tasks done" value={String(current.tasksDone)}>
                <Delta now={current.tasksDone} before={previous.tasksDone} format={(n) => String(n)} />
              </Stat>
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">Money</h3>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Spent" value={formatRupees(current.spent)}>
                <Delta now={current.spent} before={previous.spent} direction="lower-is-better" format={formatRupees} />
              </Stat>
              <Stat label="Saved" value={formatRupees(current.saved)}>
                <Delta now={current.saved} before={previous.saved} format={formatRupees} />
              </Stat>
            </div>
          </section>

          {report.habits.length === 0 && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Tip: habits you add, like “Gym” or “English practice”, show up here.
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
