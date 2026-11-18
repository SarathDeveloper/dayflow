import React, { useState } from 'react';
import { CheckCircle2, ChevronDown, Flame, Target, Timer, Trophy } from 'lucide-react';
import { Card } from './ui/Card';
import { cn } from '../lib/cn';
import { formatShortDate } from '../lib/dateFormat';
import type { DailyProgress, ProgressAreaKey, WeeklyConsistency } from '../lib/progressScore';

interface TodayProgressCardProps {
  progress: DailyProgress;
  weekly: WeeklyConsistency;
  /** Where the selected date sits relative to today. */
  when: 'past' | 'today' | 'future';
}

const AREA_ICON: Record<ProgressAreaKey, React.ElementType> = {
  habits: Flame,
  tasks: CheckCircle2,
  focus: Timer,
  goals: Target,
};

function scoreColor(percent: number | null): string {
  if (percent === null) return 'text-slate-300 dark:text-slate-600';
  if (percent >= 80) return 'text-emerald-500';
  if (percent >= 50) return 'text-indigo-500';
  return 'text-amber-500';
}

function barColor(percent: number | null): string {
  if (percent === null) return 'bg-slate-200 dark:bg-slate-800';
  if (percent >= 80) return 'bg-emerald-500';
  if (percent >= 50) return 'bg-indigo-500';
  return 'bg-amber-400';
}

// Upbeat, action-first lines for today. One is picked per date so it stays
// put while the day's score is in the same band.
const TODAY_LINES: Record<'start' | 'going' | 'half' | 'close', string[]> = {
  start: ['Start with one small win', 'Pick one task and begin', 'Your day, your move. Go!'],
  going: ['Great start. Keep it rolling!', 'Momentum is building. Next one!', 'Nice work. Tackle the next task'],
  half: ['Over halfway. Keep pushing!', 'You’re on a roll. Keep going!', 'Strong progress. Finish a few more'],
  close: ['Almost there. Finish strong!', 'Just a little more to go!', 'So close. Wrap it up!'],
};

function headline(percent: number | null, isToday: boolean, date: string): string {
  if (percent === null) return isToday ? 'A clear day. Plan something great' : 'Nothing was due';
  if (percent >= 100) return isToday ? 'All done. You crushed it!' : 'Everything done. Great day!';
  if (!isToday) {
    if (percent >= 80) return 'Almost a perfect day';
    if (percent >= 50) return 'A solid day';
    return 'A lighter day. Tomorrow is fresh';
  }
  const band = percent >= 80 ? 'close' : percent >= 50 ? 'half' : percent > 0 ? 'going' : 'start';
  const lines = TODAY_LINES[band];
  const seed = [...date].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  return lines[seed % lines.length];
}

// The user's own headline for today (device-only preference). Empty = automatic.
const CUSTOM_LINE_KEY = 'dayflow_progress_headline_v1';

function readCustomLine(): string {
  try {
    return localStorage.getItem(CUSTOM_LINE_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeCustomLine(line: string): void {
  try {
    if (line) localStorage.setItem(CUSTOM_LINE_KEY, line);
    else localStorage.removeItem(CUSTOM_LINE_KEY);
  } catch {
    // Storage blocked: the line still shows until the app reloads.
  }
}

const ScoreRing: React.FC<{ percent: number | null }> = ({ percent }) => {
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const value = percent ?? 0;
  return (
    <div className="relative h-16 w-16 shrink-0">
      <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90" aria-hidden="true">
        <circle cx="32" cy="32" r={radius} className="fill-none stroke-slate-100 dark:stroke-slate-800" strokeWidth="7" />
        <circle
          cx="32"
          cy="32"
          r={radius}
          className={cn('fill-none transition-all duration-500', scoreColor(percent))}
          stroke="currentColor"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - (value / 100) * circumference}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-base font-extrabold text-slate-900 dark:text-white">
        {percent === null ? '—' : `${percent}%`}
      </span>
    </div>
  );
};

/** One daily score from habits, tasks, focus time and goals, with the week's consistency. */
export const TodayProgressCard: React.FC<TodayProgressCardProps> = ({ progress, weekly, when }) => {
  const [showMissed, setShowMissed] = useState(false);
  const { percent, areas, best, missed } = progress;
  const isToday = when === 'today';
  const [customLine, setCustomLine] = useState(readCustomLine);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const saveCustom = () => {
    const line = draft.trim();
    setCustomLine(line);
    writeCustomLine(line);
    setEditing(false);
  };

  // A future day has nothing to score yet: show what is planned instead.
  if (when === 'future') {
    return (
      <Card className="p-4 space-y-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          Planned for {formatShortDate(progress.date)}
        </p>
        {missed.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">Nothing planned yet.</p>
        ) : (
          <ul className="space-y-1">
            {missed.map((item) => (
              <li key={`${item.kind}-${item.id}`} className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                <span className="rounded bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 text-[9px] font-bold uppercase text-slate-500">
                  {item.kind}
                </span>
                <span className="truncate">{item.title}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    );
  }

  const title = isToday ? 'Today’s progress' : `Progress on ${formatShortDate(progress.date)}`;
  const missedLabel = isToday ? 'Still open' : 'Missed';

  return (
    <Card className="p-4 space-y-4">
      <div className="flex items-center gap-4">
        <ScoreRing percent={percent} />
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{title}</p>
          {editing ? (
            <input
              autoFocus
              value={draft}
              maxLength={60}
              placeholder="Your own line (empty = automatic)"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={saveCustom}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveCustom();
                if (e.key === 'Escape') setEditing(false);
              }}
              className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-transparent px-2 py-0.5 text-sm font-bold text-slate-900 dark:text-white outline-none focus:border-indigo-400"
            />
          ) : (
            <button
              type="button"
              title="Tap to write your own line"
              onClick={() => {
                setDraft(customLine);
                setEditing(true);
              }}
              className="block max-w-full truncate text-left text-sm font-bold text-slate-900 dark:text-white"
            >
              {isToday && customLine ? customLine : headline(percent, isToday, progress.date)}
            </button>
          )}
          {best && (
            <p className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400">
              <Trophy className="h-3 w-3 text-amber-500" />
              Best area: {best.label} ({best.percent}%)
            </p>
          )}
        </div>
      </div>

      {areas.length > 0 && (
        <ul className="grid grid-cols-2 gap-2 [&>li:last-child:nth-child(odd)]:col-span-2">
          {areas.map((area) => {
            const Icon = AREA_ICON[area.key];
            return (
              <li key={area.key} className="rounded-xl bg-slate-50 dark:bg-slate-800/60 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200">
                    <Icon className="h-3.5 w-3.5 text-slate-400" />
                    {area.label}
                  </span>
                  <span className="text-xs font-bold text-slate-900 dark:text-white">{area.percent}%</span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                  <div className={cn('h-full rounded-full transition-all', barColor(area.percent))} style={{ width: `${area.percent}%` }} />
                </div>
                <p className="mt-1 truncate text-[10px] text-slate-500 dark:text-slate-400">{area.detail}</p>
              </li>
            );
          })}
        </ul>
      )}

      {missed.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowMissed((value) => !value)}
            className="flex w-full items-center justify-between text-xs font-semibold text-slate-600 dark:text-slate-300"
            aria-expanded={showMissed}
          >
            <span>
              {missedLabel}: {missed.length}
            </span>
            <ChevronDown className={cn('h-4 w-4 transition-transform', showMissed && 'rotate-180')} />
          </button>
          {showMissed && (
            <ul className="mt-2 space-y-1">
              {missed.map((item) => (
                <li key={`${item.kind}-${item.id}`} className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                  <span className="rounded bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 text-[9px] font-bold uppercase text-slate-500">
                    {item.kind}
                  </span>
                  <span className="truncate">{item.title}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="border-t border-slate-100 dark:border-slate-800 pt-3">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-slate-600 dark:text-slate-300">7-day consistency</span>
          <span className="font-bold text-slate-900 dark:text-white">{weekly.percent === null ? '—' : `${weekly.percent}%`}</span>
        </div>
        <div className="mt-2 flex items-end gap-1.5 h-10" aria-label="Daily scores for the last 7 days">
          {weekly.days.map((day) => (
            <div key={day.date} className="flex flex-1 flex-col items-center gap-1">
              <div className="flex h-7 w-full items-end overflow-hidden rounded-md bg-slate-100 dark:bg-slate-800">
                <div
                  className={cn('w-full rounded-md', barColor(day.percent))}
                  style={{ height: `${day.percent === null ? 0 : Math.max(8, day.percent)}%` }}
                  title={`${formatShortDate(day.date)}: ${day.percent === null ? 'nothing due' : `${day.percent}%`}`}
                />
              </div>
              <span className="text-[9px] text-slate-400">
                {new Date(`${day.date}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'narrow' })}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
};
