import React from 'react';
import {
  AlarmClock,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  Flame,
  Receipt,
  Repeat,
  Target,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import type { ActiveTab, Alarm } from '../types';
import type { HomeSummary } from '../lib/homeSummary';
import type { DailyProgress, WeeklyConsistency } from '../lib/progressScore';
import { formatAlarmWhen, nextEnabledAlarm } from '../lib/alarms';
import { formatClockTime, formatShortDate } from '../lib/dateFormat';
import { formatRupees } from '../lib/money';
import { cn } from '../lib/cn';

interface HomeViewProps {
  summary: HomeSummary;
  /** Today's score (not the date picked on the Today tab). */
  progress: DailyProgress;
  weekly: WeeklyConsistency;
  alarms: Alarm[];
  onOpen: (tab: ActiveTab) => void;
}

function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 5) return 'Good night';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function percentOf(done: number, total: number): number {
  return total === 0 ? 0 : Math.min(100, Math.round((done / total) * 100));
}

function toneColor(percent: number | null): string {
  if (percent === null) return 'text-slate-400 dark:text-slate-500';
  if (percent >= 80) return 'text-emerald-600 dark:text-emerald-400';
  if (percent >= 50) return 'text-indigo-600 dark:text-indigo-400';
  return 'text-amber-600 dark:text-amber-400';
}

const Bar: React.FC<{ percent: number; className?: string }> = ({ percent, className }) => (
  <span className="block h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
    <span
      className={cn('block h-full rounded-full transition-all duration-500', className ?? 'bg-indigo-500')}
      style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
     />
  </span>
);

interface TileProps {
  title: string;
  icon: React.ElementType;
  iconClass: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}

/** A whole-card button that opens its section. Only phrasing content (spans) inside: a <button> may not hold div/p/ul. */
const Tile: React.FC<TileProps> = ({ title, icon: Icon, iconClass, onClick, className, children }) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      'group flex flex-col justify-start w-full min-w-0 text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm p-4 transition-colors hover:border-indigo-300 dark:hover:border-indigo-700 active:scale-[0.99] focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
      className,
    )}
  >
    <span className="flex w-full items-center gap-2 mb-3">
      <span className={cn('w-8 h-8 rounded-xl flex items-center justify-center shrink-0', iconClass)}>
        <Icon className="w-4 h-4" />
      </span>
      <span className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400 flex-1 min-w-0 truncate">
        {title}
      </span>
      <ChevronRight className="w-4 h-4 text-slate-300 dark:text-slate-600 group-hover:text-indigo-500 shrink-0" />
    </span>
    {children}
  </button>
);

const Muted: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="block text-sm text-slate-500 dark:text-slate-400">{children}</span>
);

export const HomeView: React.FC<HomeViewProps> = ({ summary, progress, weekly, alarms, onOpen }) => {
  const { tasks, habits, streak, money, goals, diary } = summary;
  const nextAlarm = nextEnabledAlarm(alarms);
  const budgetPercent = money.monthBudget > 0 ? (money.spentMonth / money.monthBudget) * 100 : 0;
  const overBudget = money.monthBudget > 0 && money.spentMonth > money.monthBudget;
  const todayLabel = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div className="space-y-4">
      <div className="px-0.5">
        <h2 className="text-xl font-extrabold tracking-tight text-slate-900 dark:text-white">{greeting()}</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">{todayLabel}</p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {/* Today */}
        <Tile
          title="Today"
          icon={CheckCircle2}
          iconClass="bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-300"
          onClick={() => onOpen('today')}
          className="sm:col-span-2 lg:col-span-1"
        >
          <span className="flex items-end justify-between gap-3">
            <span className="block min-w-0">
              <span className="block text-2xl font-black text-slate-900 dark:text-white leading-none">
                {tasks.done}
                <span className="text-base font-bold text-slate-400"> / {tasks.total}</span>
              </span>
              <span className="block text-xs text-slate-500 dark:text-slate-400 mt-1">tasks done</span>
            </span>
            <span className="block text-right shrink-0">
              <span className={cn('block text-2xl font-black leading-none', toneColor(progress.percent))}>
                {progress.percent === null ? '—' : `${progress.percent}%`}
              </span>
              <span className="block text-xs text-slate-500 dark:text-slate-400 mt-1">day score</span>
            </span>
          </span>
          <span className="block mt-3">
            <Bar percent={percentOf(tasks.done, tasks.total)} />
          </span>
          <span className="block mt-3 text-sm text-slate-700 dark:text-slate-200 truncate">
            {tasks.next ? (
              <>
                <span className="text-slate-400">
                  Next{tasks.next.time ? ` · ${formatClockTime(tasks.next.time)}` : ''}:{' '}
                </span>
                {tasks.next.title}
              </>
            ) : tasks.total > 0 ? (
              <span className="text-emerald-600 dark:text-emerald-400 font-semibold">All done for today</span>
            ) : (
              <span className="text-slate-500 dark:text-slate-400">Nothing planned yet</span>
            )}
          </span>
        </Tile>

        {/* Habits */}
        <Tile
          title="Habits"
          icon={Repeat}
          iconClass="bg-emerald-50 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-300"
          onClick={() => onOpen('habits')}
        >
          {habits.due === 0 ? (
            <Muted>No habits due today</Muted>
          ) : (
            <>
              <span className="block text-2xl font-black text-slate-900 dark:text-white leading-none">
                {habits.done}
                <span className="text-base font-bold text-slate-400"> / {habits.due}</span>
              </span>
              <span className="block text-xs text-slate-500 dark:text-slate-400 mt-1 mb-3">done today</span>
              <Bar percent={percentOf(habits.done, habits.due)} className="bg-emerald-500" />
            </>
          )}
        </Tile>

        {/* Streak */}
        <Tile
          title="Streak"
          icon={TrendingUp}
          iconClass="bg-orange-50 dark:bg-orange-950 text-orange-600 dark:text-orange-300"
          onClick={() => onOpen('stats')}
        >
          <span className="flex items-center gap-2">
            <Flame className={cn('w-6 h-6', streak.taskDays > 0 ? 'text-orange-500' : 'text-slate-300 dark:text-slate-600')} />
            <span className="block text-2xl font-black text-slate-900 dark:text-white leading-none">
              {streak.taskDays}
              <span className="text-sm font-bold text-slate-400"> {streak.taskDays === 1 ? 'day' : 'days'}</span>
            </span>
          </span>
          <span className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <span className="block">
              <span className="block text-slate-500 dark:text-slate-400">Best habit</span>
              <span className="block font-bold text-slate-800 dark:text-slate-100">
                {streak.bestHabit} {streak.bestHabit === 1 ? streak.bestHabitUnit.slice(0, -1) : streak.bestHabitUnit}
              </span>
            </span>
            <span className="block">
              <span className="block text-slate-500 dark:text-slate-400">Last 7 days</span>
              <span className={cn('block font-bold', toneColor(weekly.percent))}>
                {weekly.percent === null ? '—' : `${weekly.percent}%`}
              </span>
            </span>
          </span>
        </Tile>

        {/* Money */}
        <Tile
          title="Money"
          icon={Wallet}
          iconClass="bg-sky-50 dark:bg-sky-950 text-sky-600 dark:text-sky-300"
          onClick={() => onOpen('finance')}
        >
          <span className="flex items-end justify-between gap-3">
            <span className="block min-w-0">
              <span className="block text-xs text-slate-500 dark:text-slate-400">Spent this month</span>
              <span className={cn('block text-xl font-black leading-tight truncate', overBudget ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900 dark:text-white')}>
                {formatRupees(money.spentMonth)}
              </span>
            </span>
            <span className="block text-right shrink-0">
              <span className="block text-xs text-slate-500 dark:text-slate-400">Today</span>
              <span className="block text-sm font-bold text-slate-800 dark:text-slate-100">{formatRupees(money.spentToday)}</span>
            </span>
          </span>
          {money.monthBudget > 0 && (
            <span className="block mt-2 space-y-1">
              <Bar percent={budgetPercent} className={overBudget ? 'bg-rose-500' : budgetPercent >= 80 ? 'bg-amber-500' : 'bg-sky-500'} />
              <span className="block text-[11px] text-slate-500 dark:text-slate-400">
                {overBudget
                  ? `${formatRupees(money.spentMonth - money.monthBudget)} over the ${formatRupees(money.monthBudget)} budget`
                  : `of ${formatRupees(money.monthBudget)} budget`}
              </span>
            </span>
          )}
          <span className="mt-3 flex items-center gap-1.5 text-xs">
            <Receipt className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            {money.unpaidBills === 0 ? (
              <span className="text-slate-500 dark:text-slate-400">No unpaid bills this month</span>
            ) : (
              <span className="min-w-0 text-slate-700 dark:text-slate-200 truncate">
                {money.unpaidBills} unpaid · {formatRupees(money.unpaidBillsAmount)}
                {money.overdueBills > 0 ? (
                  <span className="text-rose-600 dark:text-rose-400 font-semibold"> · {money.overdueBills} overdue</span>
                ) : (
                  money.nextBillDue && <span className="text-slate-400"> · due {formatShortDate(money.nextBillDue)}</span>
                )}
              </span>
            )}
          </span>
        </Tile>

        {/* Next alarm */}
        <Tile
          title="Next alarm"
          icon={AlarmClock}
          iconClass="bg-violet-50 dark:bg-violet-950 text-violet-600 dark:text-violet-300"
          onClick={() => onOpen('alarms')}
        >
          {nextAlarm ? (
            <>
              <span className="block text-base font-bold text-slate-900 dark:text-white truncate">{nextAlarm.alarm.label || 'Alarm'}</span>
              <span className="block text-sm text-slate-500 dark:text-slate-400">{formatAlarmWhen(nextAlarm.fireAt)}</span>
            </>
          ) : (
            <Muted>No alarms on</Muted>
          )}
        </Tile>

        {/* Goals */}
        <Tile
          title="Goals"
          icon={Target}
          iconClass="bg-rose-50 dark:bg-rose-950 text-rose-600 dark:text-rose-300"
          onClick={() => onOpen('goals')}
        >
          {goals.length === 0 ? (
            <Muted>No active goals</Muted>
          ) : (
            <span className="block space-y-2.5">
              {goals.map((goal) => (
                <span key={goal.id} className="block space-y-1">
                  <span className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 font-semibold text-slate-800 dark:text-slate-100 truncate">{goal.title}</span>
                    <span className="text-xs font-bold text-slate-500 dark:text-slate-400 shrink-0">{goal.percent}%</span>
                  </span>
                  <Bar percent={goal.percent} className="bg-rose-500" />
                </span>
              ))}
            </span>
          )}
        </Tile>

        {/* Diary */}
        <Tile
          title="Diary"
          icon={BookOpen}
          iconClass="bg-amber-50 dark:bg-amber-950 text-amber-600 dark:text-amber-300"
          onClick={() => onOpen('diary')}
        >
          {diary.notesToday > 0 ? (
            <span className="block text-sm font-semibold text-emerald-600 dark:text-emerald-400">
              {diary.notesToday} {diary.notesToday === 1 ? 'note' : 'notes'} written today
            </span>
          ) : (
            <Muted>Nothing written today yet. Tap to write.</Muted>
          )}
        </Tile>
      </div>
    </div>
  );
};
