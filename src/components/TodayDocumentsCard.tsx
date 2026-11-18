import React, { useEffect, useState } from 'react';
import { FileLock2 } from 'lucide-react';
import { readDocumentReminders, subscribeDocumentReminders } from '../services/documentReminderStore';
import { daysUntilExpiry } from '../lib/documentVault';
import { Card } from './ui/Card';

interface TodayDocumentsCardProps {
  today: string;
  reminderNote: string | null;
  onOpen: () => void;
}

/** How long after expiry a document keeps showing here. */
const SHOW_EXPIRED_DAYS = 30;

interface DueDocument {
  key: string;
  expiresOn: string;
  label?: string;
}

/**
 * Documents whose reminder date has arrived, from the plaintext reminder schedule
 * only (no vault access). Titles appear only when the user opted in; otherwise the
 * card stays generic: open Documents to see which ones.
 */
export function dueDocuments(today: string): DueDocument[] {
  const byKey = new Map<string, DueDocument>();
  for (const entry of readDocumentReminders().entries) {
    if (entry.date > today) continue;
    if (daysUntilExpiry(entry.expiresOn, today) < -SHOW_EXPIRED_DAYS) continue;
    byKey.set(entry.key, { key: entry.key, expiresOn: entry.expiresOn, label: entry.label });
  }
  return [...byKey.values()].sort((a, b) => a.expiresOn.localeCompare(b.expiresOn));
}

function phrase(days: number): string {
  if (days < 0) return 'expired';
  if (days === 0) return 'expires today';
  if (days === 1) return 'expires tomorrow';
  return `expires in ${days} days`;
}

export const TodayDocumentsCard: React.FC<TodayDocumentsCardProps> = ({ today, reminderNote, onOpen }) => {
  const [due, setDue] = useState(() => dueDocuments(today));
  useEffect(() => {
    setDue(dueDocuments(today));
    return subscribeDocumentReminders(() => setDue(dueDocuments(today)));
  }, [today]);
  if (due.length === 0) return null;
  const expired = due.filter((doc) => doc.expiresOn < today).length;

  return (
    <section className="space-y-2" aria-label="Document reminders">
      <div className="flex items-center justify-between gap-2 px-0.5">
        <p className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
          <FileLock2 className="w-3.5 h-3.5 text-violet-600 dark:text-violet-400" />
          Documents · {due.length} need attention
        </p>
        <button type="button" onClick={onOpen} className="text-[11px] font-bold text-indigo-600 dark:text-indigo-400">
          Open vault
        </button>
      </div>
      <Card className="p-3 space-y-1.5">
        {due.some((doc) => doc.label) ? (
          <ul className="space-y-1">
            {due.slice(0, 4).map((doc) => {
              const days = daysUntilExpiry(doc.expiresOn, today);
              return (
                <li key={doc.key} className="flex items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate text-slate-800 dark:text-slate-100">{doc.label ?? 'A document'}</span>
                  <span className={`shrink-0 text-xs font-semibold ${days < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-amber-600 dark:text-amber-400'}`}>{phrase(days)}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-slate-700 dark:text-slate-200">
            {due.length === 1 ? 'A document in your vault' : `${due.length} documents in your vault`}{' '}
            {expired > 0 && expired === due.length ? (due.length === 1 ? 'has expired' : 'have expired') : 'expire soon'}.
            {' '}Open Documents to see {due.length === 1 ? 'it' : 'them'}.
          </p>
        )}
        {reminderNote && <p className="text-[11px] text-slate-500 dark:text-slate-400">{reminderNote}</p>}
      </Card>
    </section>
  );
};
