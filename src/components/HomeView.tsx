import React from 'react';
import {
  AlarmClock,
  BookOpen,
  ChevronRight,
  Flame,
  Receipt,
  Repeat,
  Target,
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

function toneColor(percent: number | null): string {
  if (percent === null) return 'text-slate-400 dark:text-slate-500';
  if (percent >= 80) return 'text-emerald-600 dark:text-emerald-400';
  if (percent >= 50) return 'text-indigo-600 dark:text-indigo-400';
  return 'text-amber-600 dark:text-amber-400';
}

const CARD =
  'group w-full min-w-0 text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm transition-colors hover:border-indigo-300 dark:hover:border-indigo-700 active:scale-[0.99] focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500';

const Bar: React.FC<{ percent: number; className?: string }> = ({ percent, className }) => (
  <span className="block h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
    <span
      className={cn('block h-full rounded-full transition-all duration-500', className ?? 'bg-indigo-500')}
      style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
    />
  </span>
);

/** Day score as a ring. Grey track only when nothing was due. */
const ScoreRing: React.FC<{ percent: number | null }> = ({ percent }) => {
  const size = 84;
  const stroke = 9;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <span className={cn('relative block shrink-0', toneColor(percent))} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} className="stroke-slate-100 dark:stroke-slate-800" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - filled / 100)}
          className="transition-[stroke-dashoffset] duration-700"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-xl font-black">
        {percent === null ? '—' : `${percent}%`}
      </span>
    </span>
  );
};

interface StatTileProps {
  label: string;
  icon: React.ElementType;
  iconClass: string;
  onClick: () => void;
  /** Main number or short text. */
  value: React.ReactNode;
  /** One short line under the value. */
  hint?: React.ReactNode;
}

/** A small 2×2 tile: icon + label, a big value, one hint line. Only spans inside: a <button> may not hold divs. */
const StatTile: React.FC<StatTileProps> = ({ label, icon: Icon, iconClass, onClick, value, hint }) => (
  <button type="button" onClick={onClick} className={cn(CARD, 'flex flex-col p-3')}>
    <span className="flex items-center gap-2 min-w-0">
      <span className={cn('w-7 h-7 rounded-lg flex items-center justify-center shrink-0', iconClass)}>
        <Icon className="w-4 h-4" />
      </span>
      <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 truncate">{label}</span>
    </span>
    <span className="block mt-2 text-xl font-black text-slate-900 dark:text-white leading-tight truncate">{value}</span>
    {hint && <span className="block mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 truncate">{hint}</span>}
  </button>
);

const Small: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="text-sm font-bold text-slate-400"> {children}</span>
);

export const HomeView: React.FC<HomeViewProps> = ({ summary, progress, weekly, alarms, onOpen }) => {
  const { tasks, habits, streak, money, goals, diary } = summary;
  const nextAlarm = nextEnabledAlarm(alarms);
  const budgetPercent = money.monthBudget > 0 ? (money.spentMonth / money.monthBudget) * 100 : 0;
  const overBudget = money.monthBudget > 0 && money.spentMonth > money.monthBudget;
  const todayLabel = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
  const bestHabitUnit = streak.bestHabit === 1 ? streak.bestHabitUnit.slice(0, -1) : streak.bestHabitUnit;

  const dueLine = [
    tasks.total > 0 ? `${tasks.done} of ${tasks.total} tasks` : null,
    habits.due > 0 ? `${habits.done} of ${habits.due} habits` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="space-y-3">
      <div className="px-0.5 pb-1">
        <h2 className="text-xl font-extrabold tracking-tight text-slate-900 dark:text-white">{greeting()}</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">{todayLabel}</p>
      </div>

      {/* Day score */}
      <button type="button" onClick={() => onOpen('today')} className={cn(CARD, 'flex items-center gap-4 p-4')}>
        <ScoreRing percent={progress.percent} />
        <span className="block flex-1 min-w-0">
          <span className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Day score</span>
            <ChevronRight className="w-4 h-4 text-slate-300 dark:text-slate-600 group-hover:text-indigo-500 shrink-0" />
          </span>
          <span className="block mt-0.5 text-[15px] font-bold text-slate-900 dark:text-white truncate">
            {dueLine || 'Nothing due today'}
          </span>
          <span className="block mt-1 text-sm truncate">
            {tasks.next ? (
              <span className="text-slate-700 dark:text-slate-200">
                <span className="text-slate-400">Next{tasks.next.time ? ` ${formatClockTime(tasks.next.time)}` : ''} · </span>
                {tasks.next.title}
              </span>
            ) : tasks.total > 0 ? (
              <span className="text-emerald-600 dark:text-emerald-400 font-semibold">All tasks done</span>
            ) : (
              <span className="text-slate-500 dark:text-slate-400">Tap to plan your day</span>
            )}
          </span>
          <span className="block mt-1 text-xs text-slate-500 dark:text-slate-400">
            Last 7 days{' '}
            <span className={cn('font-bold', toneColor(weekly.percent))}>
              {weekly.percent === null ? '—' : `${weekly.percent}%`}
            </span>
          </span>
        </span>
      </button>

      {/* 2×2 tiles (one row of four on wider screens) */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Habits"
          icon={Repeat}
          iconClass="bg-emerald-50 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-300"
          onClick={() => onOpen('habits')}
          value={habits.due === 0 ? <span className="text-base text-slate-400">None due</span> : <>{habits.done}<Small>/ {habits.due}</Small></>}
          hint={habits.due === 0 ? 'Rest day' : habits.done === habits.due ? 'All done' : 'done today'}
        />
        <StatTile
          label="Streak"
          icon={Flame}
          iconClass={cn(
            'bg-orange-50 dark:bg-orange-950',
            streak.taskDays > 0 ? 'text-orange-500 dark:text-orange-300' : 'text-slate-400 dark:text-slate-500',
          )}
          onClick={() => onOpen('stats')}
          value={<>{streak.taskDays}<Small>{streak.taskDays === 1 ? 'day' : 'days'}</Small></>}
          hint={streak.bestHabit > 0 ? `Best habit ${streak.bestHabit} ${bestHabitUnit}` : 'days with tasks done'}
        />
        <StatTile
          label="Spent today"
          icon={Wallet}
          iconClass="bg-sky-50 dark:bg-sky-950 text-sky-600 dark:text-sky-300"
          onClick={() => onOpen('finance')}
          value={formatRupees(money.spentToday)}
          hint={`${formatRupees(money.spentMonth)} this month`}
        />
        <StatTile
          label="Bills"
          icon={Receipt}
          iconClass={
            money.overdueBills > 0
              ? 'bg-rose-50 dark:bg-rose-950 text-rose-600 dark:text-rose-300'
              : 'bg-violet-50 dark:bg-violet-950 text-violet-600 dark:text-violet-300'
          }
          onClick={() => onOpen('finance')}
          value={money.unpaidBills === 0 ? <span className="text-base text-emerald-600 dark:text-emerald-400">All paid</span> : <>{money.unpaidBills}<Small>unpaid</Small></>}
          hint={
            money.unpaidBills === 0 ? (
              'this month'
            ) : money.overdueBills > 0 ? (
              <span className="text-rose-600 dark:text-rose-400 font-semibold">{money.overdueBills} overdue · {formatRupees(money.unpaidBillsAmount)}</span>
            ) : (
              `${formatRupees(money.unpaidBillsAmount)}${money.nextBillDue ? ` · due ${formatShortDate(money.nextBillDue)}` : ''}`
            )
          }
        />
      </div>

      {/* Month budget */}
      {money.monthBudget > 0 && (
        <button type="button" onClick={() => onOpen('finance')} className={cn(CARD, 'block px-4 py-3')}>
          <span className="flex items-baseline justify-between gap-2 text-xs">
            <span className="font-semibold text-slate-500 dark:text-slate-400">Month budget</span>
            <span className={cn('font-bold', overBudget ? 'text-rose-600 dark:text-rose-400' : 'text-slate-700 dark:text-slate-200')}>
              {formatRupees(money.spentMonth)}
              <span className="font-medium text-slate-400"> / {formatRupees(money.monthBudget)}</span>
            </span>
          </span>
          <span className="block mt-2">
            <Bar percent={budgetPercent} className={overBudget ? 'bg-rose-500' : budgetPercent >= 80 ? 'bg-amber-500' : 'bg-indigo-500'} />
          </span>
          {overBudget && (
            <span className="block mt-1.5 text-[11px] text-rose-600 dark:text-rose-400">
              {formatRupees(money.spentMonth - money.monthBudget)} over budget
            </span>
          )}
        </button>
      )}

      {/* Goals */}
      <button type="button" onClick={() => onOpen('goals')} className={cn(CARD, 'block px-4 py-3')}>
        <span className="flex items-center gap-2">
          <Target className="w-4 h-4 text-rose-500 shrink-0" />
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 flex-1">Goals</span>
          <ChevronRight className="w-4 h-4 text-slate-300 dark:text-slate-600 group-hover:text-indigo-500 shrink-0" />
        </span>
        {goals.length === 0 ? (
          <span className="block mt-1.5 text-sm text-slate-500 dark:text-slate-400">No active goals</span>
        ) : (
          <span className="block mt-2 space-y-2.5">
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
      </button>

      {/* Alarm and diary */}
      <div className="grid grid-cols-2 gap-3">
        <StatTile
          label="Next alarm"
          icon={AlarmClock}
          iconClass="bg-violet-50 dark:bg-violet-950 text-violet-600 dark:text-violet-300"
          onClick={() => onOpen('alarms')}
          value={<span className="text-base">{nextAlarm ? nextAlarm.alarm.label || 'Alarm' : 'None on'}</span>}
          hint={nextAlarm ? formatAlarmWhen(nextAlarm.fireAt) : 'Tap to add one'}
        />
        <StatTile
          label="Diary"
          icon={BookOpen}
          iconClass="bg-amber-50 dark:bg-amber-950 text-amber-600 dark:text-amber-300"
          onClick={() => onOpen('diary')}
          value={
            <span className={cn('text-base', diary.notesToday > 0 && 'text-emerald-600 dark:text-emerald-400')}>
              {diary.notesToday > 0 ? `${diary.notesToday} ${diary.notesToday === 1 ? 'note' : 'notes'}` : 'Write today'}
            </span>
          }
          hint={diary.notesToday > 0 ? 'written today' : 'Nothing yet'}
        />
      </div>
    </div>
  );
};
