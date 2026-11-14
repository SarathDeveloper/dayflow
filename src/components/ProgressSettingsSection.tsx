import React from 'react';
import { Gauge } from 'lucide-react';
import type { NotificationSettings } from '../types';
import { DEFAULT_FOCUS_GOAL_MINUTES, focusGoalMinutes } from '../lib/progressScore';

interface ProgressSettingsSectionProps {
  settings: NotificationSettings;
  onUpdateSettings: (next: NotificationSettings) => void;
  /** Extra rows (e.g. planning hours) rendered inside the same section. */
  children?: React.ReactNode;
}

const FOCUS_CHOICES = [0, 25, 50, 75, 100, 150, 200];

/** Settings for the Daily Progress Score and planning. */
export const ProgressSettingsSection: React.FC<ProgressSettingsSectionProps> = ({ settings, onUpdateSettings, children }) => {
  const goal = focusGoalMinutes(settings);
  return (
    <div className="space-y-3 bg-slate-50 dark:bg-slate-950/60 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800">
      <h3 className="font-bold text-slate-800 dark:text-slate-200 text-xs flex items-center gap-1.5">
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
      {children}
    </div>
  );
};
