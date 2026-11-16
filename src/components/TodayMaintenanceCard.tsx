import React from 'react';
import { Wrench } from 'lucide-react';
import type { MaintenanceItem } from '../types';
import { dueMaintenance } from '../lib/maintenance';
import { formatShortDate } from '../lib/dateFormat';
import { daysUntilExpiry } from '../lib/documentVault';
import { Card } from './ui/Card';

interface TodayMaintenanceCardProps {
  items: MaintenanceItem[];
  today: string;
  /** Null when reminders notify; otherwise why they only show here. */
  reminderNote: string | null;
  onOpen: () => void;
}

const MAX_ROWS = 4;

/** Overdue maintenance and anything due within a week. Hidden when nothing is due. */
export const TodayMaintenanceCard: React.FC<TodayMaintenanceCardProps> = ({ items, today, reminderNote, onOpen }) => {
  const due = dueMaintenance(items, today, 7);
  if (due.length === 0) return null;
  const overdue = due.filter((item) => item.due < today).length;

  return (
    <section className="space-y-2" aria-label="Maintenance due">
      <div className="flex items-center justify-between gap-2 px-0.5">
        <p className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
          <Wrench className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
          Maintenance · {overdue > 0 ? `${overdue} overdue` : `${due.length} due soon`}
        </p>
        <button type="button" onClick={onOpen} className="text-[11px] font-bold text-indigo-600 dark:text-indigo-400">
          Open
        </button>
      </div>
      <Card className="p-3 space-y-2">
        <ul className="space-y-1.5">
          {due.slice(0, MAX_ROWS).map((item) => {
            const days = daysUntilExpiry(item.due, today);
            const when = days < 0 ? `${-days} ${days === -1 ? 'day' : 'days'} overdue` : days === 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : `Due ${formatShortDate(item.due)}`;
            return (
              <li key={item.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate text-slate-800 dark:text-slate-100">
                  <span className="font-semibold">{item.asset}</span> · {item.title}
                </span>
                <span className={`shrink-0 text-xs font-semibold ${days < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-amber-600 dark:text-amber-400'}`}>
                  {when}
                </span>
              </li>
            );
          })}
        </ul>
        {due.length > MAX_ROWS && (
          <p className="text-xs text-slate-500 dark:text-slate-400">+{due.length - MAX_ROWS} more</p>
        )}
        {reminderNote && <p className="text-[11px] text-slate-500 dark:text-slate-400">{reminderNote}</p>}
      </Card>
    </section>
  );
};
