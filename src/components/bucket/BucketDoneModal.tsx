import React, { useEffect, useState } from 'react';
import { ImagePlus, PartyPopper, Trash2, X } from 'lucide-react';
import type { BucketItem, DiaryImage } from '../../types';
import { compressDiaryImage } from '../../lib/diaryImages';
import { beginExternalActivity, endExternalActivity } from '../../lib/externalActivity';
import { todayString } from '../../lib/ledger';
import { isValidLocalDate } from '../../lib/bucketList';
import { Button } from '../ui/Button';

interface Props {
  item: BucketItem | null;
  onClose: () => void;
  onSave: (id: string, done: { doneOn: string; memory?: string; photo?: DiaryImage }) => void;
}

const field =
  'w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2.5 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500';

/** Ticks an item off (or edits a done one): the day, a short memory and one photo. */
export function BucketDoneModal({ item, onClose, onSave }: Props) {
  const [doneOn, setDoneOn] = useState('');
  const [memory, setMemory] = useState('');
  const [photo, setPhoto] = useState<DiaryImage | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!item) return;
    setDoneOn(item.doneOn ?? todayString());
    setMemory(item.memory ?? '');
    setPhoto(item.photo);
    setError(null);
  }, [item]);

  if (!item) return null;

  const pick = async (event: React.ChangeEvent<HTMLInputElement>) => {
    endExternalActivity();
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      setPhoto(await compressDiaryImage(file));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read that photo.");
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValidLocalDate(doneOn)) return setError('Choose a valid date.');
    if (doneOn > todayString()) return setError('The day it happened cannot be in the future.');
    onSave(item.id, { doneOn, memory: memory.trim() || undefined, photo });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end sm:justify-center sm:items-center p-0 sm:p-4 bg-slate-950/70 backdrop-blur-sm">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-2xl w-full max-w-md max-h-[92dvh] flex flex-col shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2 min-w-0">
            <PartyPopper className="w-5 h-5 shrink-0 text-emerald-600" />
            <span className="truncate">{item.title}</span>
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="w-9 h-9 shrink-0 flex items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-4 overflow-y-auto text-sm">
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">Done on</span>
            <input type="date" value={doneOn} max={todayString()} onChange={(e) => setDoneOn(e.target.value)} className={field} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">Memory (optional)</span>
            <textarea value={memory} onChange={(e) => setMemory(e.target.value)} rows={3} placeholder="What made it special?" className={field} />
          </label>
          <div className="space-y-2">
            {photo ? (
              <div className="relative">
                <img src={photo.dataUrl} alt="" className="w-full max-h-64 rounded-xl object-cover" />
                <button
                  type="button"
                  onClick={() => setPhoto(undefined)}
                  aria-label="Remove photo"
                  className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full bg-slate-950/70 text-white"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <label className={`relative inline-flex min-h-[40px] items-center gap-2 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 px-3 py-2 text-xs font-bold text-slate-700 dark:text-slate-200 ${busy ? 'opacity-50 pointer-events-none' : 'cursor-pointer'}`}>
                <ImagePlus className="h-4 w-4" />
                {busy ? 'Adding photo...' : 'Add a photo'}
                <input
                  type="file"
                  accept="image/*"
                  className="absolute inset-0 cursor-pointer opacity-0"
                  disabled={busy}
                  onClick={() => beginExternalActivity()}
                  onChange={(event) => void pick(event)}
                />
              </label>
            )}
          </div>
          {error && <p role="alert" className="text-xs font-semibold text-rose-600 dark:text-rose-400">{error}</p>}
          <div className="flex gap-2 pt-1">
            <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" className="flex-1" disabled={busy}>
              {item.doneOn ? 'Save' : 'Mark done'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
