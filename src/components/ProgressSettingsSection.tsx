import React from 'react';
import { Gauge } from 'lucide-react';
import type { NotificationSettings } from '../types';
import { DEFAULT_FOCUS_GOAL_MINUTES, focusGoalMinutes } from '../lib/progressScore';
import { availableMinutesByWeekday } from '../lib/dailyPlan';

interface ProgressSettingsSectionProps {
  settings: NotificationSettings;
  onUpdateSettings: (next: NotificationSettings) => void;
  /** Extra rows (e.g. planning hours) rendered inside the same section. */
  children?: React.ReactNode;
}

const FOCUS_CHOICES = [0, 25, 50, 75, 100, 150, 200];
// 0 to 12 hours in half-hour steps.
const HOUR_CHOICES = Array.from({ length: 25 }, (_, i) => i * 30);
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function hoursLabel(minutes: number): string {
  if (minutes === 0) return '0';
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

/** Settings for the Daily Progress Score and planning. */
export const ProgressSettingsSection: React.FC<ProgressSettingsSectionProps> = ({ settings, onUpdateSettings, children }) => {
  const goal = focusGoalMinutes(settings);
  const hours = availableMinutesByWeekday(settings);
  return (
    <div className="space-y-4">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        <Gauge className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
        Progress & Planning
      </h3>
      <label className="flex items-center justify-between gap-3 text-xs">
        <span className="text-slate-600 dark:text-slate-300">
          Daily focus goal
          <span className="block text-[10px] text-slate-400">Focus Room minutes that count as a full focus day</span>
        </span>
        <select
          value={FOCUS_CHOICES.includes(goal) ? goal : DEFAULT_FOCUS_GOAL_MINUTES}
          onChange={(event) => onUpdateSettings({ ...settings, dailyFocusGoalMinutes: Number(event.target.value) })}
          className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1.5 text-slate-800 dark:text-white"
        >
          {FOCUS_CHOICES.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes === 0 ? 'Off' : `${minutes} min`}
            </option>
          ))}
        </select>
      </label>
      <div className="space-y-2 border-t border-slate-200 pt-4 dark:border-slate-800">
        <p className="text-xs text-slate-600 dark:text-slate-300">
          Time available for tasks
          <span className="block text-[10px] text-slate-400">The morning plan keeps your picks within these hours</span>
        </p>
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
          {DAY_LABELS.map((label, day) => (
            <label key={label} className="flex flex-col items-center gap-0.5 text-[10px] font-semibold text-slate-500 dark:text-slate-400">
              {label}
              <select
                value={HOUR_CHOICES.includes(hours[day]) ? hours[day] : 240}
                onChange={(event) => {
                  const next = [...hours];
                  next[day] = Number(event.target.value);
                  onUpdateSettings({ ...settings, availableMinutesByWeekday: next });
                }}
                aria-label={`Hours available on ${label}`}
                className="min-h-10 w-full min-w-0 rounded-lg border border-slate-200 bg-slate-50 px-1 text-center text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
              >
                {HOUR_CHOICES.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {hoursLabel(minutes)}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </div>
      {children}
    </div>
  );
};
