import React, { useEffect, useState } from 'react';
import { Mountain, X } from 'lucide-react';
import type { BucketCategory, BucketItem, BucketTarget } from '../../types';
import { BUCKET_CATEGORIES, validateBucketDraft } from '../../lib/bucketList';
import { todayString } from '../../lib/ledger';
import { Button } from '../ui/Button';
import { showConfirm } from '../ui/AppDialog';

export interface BucketItemInput {
  id?: string;
  title: string;
  category: BucketCategory;
  note?: string;
  target?: BucketTarget;
  cost?: number;
  remind?: boolean;
}

interface Props {
  isOpen: boolean;
  item: BucketItem | null;
  onClose: () => void;
  onSave: (input: BucketItemInput) => void;
  onDelete: (id: string) => void;
}

const field =
  'w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2.5 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500';
const labelText = 'text-xs font-semibold text-slate-700 dark:text-slate-300';

type TargetKind = 'none' | 'year' | 'date';

/** Add or edit one Bucket List item. */
export function BucketItemModal({ isOpen, item, onClose, onSave, onDelete }: Props) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<BucketCategory>('travel');
  const [note, setNote] = useState('');
  const [kind, setKind] = useState<TargetKind>('none');
  const [year, setYear] = useState('');
  const [date, setDate] = useState('');
  const [cost, setCost] = useState('');
  const [remind, setRemind] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setTitle(item?.title ?? '');
    setCategory(item?.category ?? 'travel');
    setNote(item?.note ?? '');
    setKind(item?.target?.kind ?? 'none');
    setYear(item?.target?.kind === 'year' ? String(item.target.year) : String(new Date().getFullYear() + 1));
    setDate(item?.target?.kind === 'date' ? item.target.date : '');
    setCost(item?.cost ? String(item.cost) : '');
    setRemind(item ? item.remind !== false : true);
  }, [isOpen, item]);

  if (!isOpen) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const target: BucketTarget | undefined =
      kind === 'year' ? { kind: 'year', year: Number(year) } : kind === 'date' ? { kind: 'date', date } : undefined;
    const costText = cost.replace(/[₹,\s]/g, '');
    const costValue = costText ? Number(costText) : undefined;
    const problem = validateBucketDraft({ title, category, target, cost: costValue }, todayString(), !item);
    if (problem) return setError(problem);
    onSave({
      id: item?.id,
      title: title.trim(),
      category,
      note: note.trim() || undefined,
      target,
      cost: costValue ? Math.round(costValue * 100) / 100 : undefined,
      remind: target ? remind : undefined,
    });
    onClose();
  };

  const kindButton = (value: TargetKind, text: string) => (
    <button
      type="button"
      onClick={() => setKind(value)}
      aria-pressed={kind === value}
      className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-bold transition-colors ${
        kind === value ? 'bg-white dark:bg-slate-700 text-indigo-700 dark:text-indigo-300 shadow-sm' : 'text-slate-500 dark:text-slate-400'
      }`}
    >
      {text}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end sm:justify-center sm:items-center p-0 sm:p-4 bg-slate-950/70 backdrop-blur-sm">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-2xl w-full max-w-md max-h-[92dvh] flex flex-col shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Mountain className="w-5 h-5 text-indigo-600" />
            {item ? 'Edit item' : 'Add to Bucket List'}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="w-9 h-9 flex items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-4 overflow-y-auto text-sm">
          {error && (
            <p role="alert" className="text-xs font-semibold text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 rounded-xl px-3 py-2">
              {error}
            </p>
          )}
          <label className="block space-y-1">
            <span className={labelText}>What is it?</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="See the Northern Lights" className={field} autoFocus={!item} maxLength={120} />
          </label>
          <div className="space-y-1">
            <span className={labelText}>Category</span>
            <div className="flex flex-wrap gap-1.5">
              {BUCKET_CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCategory(c.id)}
                  aria-pressed={category === c.id}
                  className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                    category === c.id
                      ? 'border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300'
                      : 'border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-300'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <span className={labelText}>When</span>
            <div className="flex gap-1 rounded-xl bg-slate-100 dark:bg-slate-800 p-1">
              {kindButton('none', 'Someday')}
              {kindButton('year', 'By a year')}
              {kindButton('date', 'By a date')}
            </div>
            {kind === 'year' && (
              <input value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" placeholder="2028" className={field} aria-label="Year" />
            )}
            {kind === 'date' && <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={field} aria-label="Date" />}
          </div>
          <label className="block space-y-1">
            <span className={labelText}>Rough cost ₹ (optional)</span>
            <input value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" placeholder={category === 'buy' ? '80000' : '0'} className={field} />
          </label>
          <label className="block space-y-1">
            <span className={labelText}>Notes (optional)</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Why it matters, links, who to go with" className={field} />
          </label>
          {kind !== 'none' && (
            <label className="flex items-center justify-between gap-3">
              <span>
                <span className={`block ${labelText}`}>Remind me</span>
                <span className="block text-[11px] text-slate-500 dark:text-slate-400">30 and 7 days before, at 9 AM.</span>
              </span>
              <input type="checkbox" checked={remind} onChange={(e) => setRemind(e.target.checked)} className="h-5 w-5 accent-indigo-600" />
            </label>
          )}
          <div className="flex gap-2 pt-1">
            {item && (
              <Button
                type="button"
                variant="ghost"
                onClick={async () => {
                  const ok = await showConfirm({
                    title: `Delete "${item.title}"?`,
                    message: item.photo || item.memory
                      ? 'Its memory and photo are deleted too. Linked goals stay.'
                      : 'Linked savings goals and goals stay.',
                    tone: 'danger',
                    confirmLabel: 'Delete',
                  });
                  if (!ok) return;
                  onDelete(item.id);
                  onClose();
                }}
              >
                Delete
              </Button>
            )}
            <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" className="flex-1">
              Save
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
