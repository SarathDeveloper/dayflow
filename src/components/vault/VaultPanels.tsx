import { useMemo, useState } from 'react';
import type { FC, ReactNode } from 'react';
import type { FormEvent } from 'react';
import {
  AlertTriangle, ArrowLeft, Clock, Download, Fingerprint, HeartPulse, KeyRound, Plus, RotateCcw, Search, Settings2,
  ShieldCheck, Star, Trash2, Upload, UserRound,
} from 'lucide-react';
import type { VaultEntry, VaultItemKind } from '../../lib/passwordVault';
import { STRENGTH_LABEL, passwordStrength } from '../../lib/vaultHealth';
import type { VaultHealth } from '../../lib/vaultHealth';
import { AUTO_LOCK_CHOICES } from '../../services/vaultPrefs';
import type { AutoLockMinutes } from '../../services/vaultPrefs';
import type { QuickUnlockStatus } from '../../services/vaultQuickUnlock';
import { MIN_VAULT_PASSPHRASE } from '../../lib/passwordVault';
import { beginExternalActivity, endExternalActivity } from '../../lib/externalActivity';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { cn } from '../../lib/cn';
import { CopyButton, inputClass, ItemAvatar, itemSubtitle, KIND_PLURAL, kindOf, labelClass } from './VaultParts';

export const TRASH_DAYS = 30;

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

type Filter = 'all' | 'favorites' | VaultItemKind | `category:${string}`;

interface ListProps {
  entries: VaultEntry[];
  health: VaultHealth;
  trashCount: number;
  backupDue: boolean;
  busy: boolean;
  onOpen: (entry: VaultEntry) => void;
  onAdd: () => void;
  onCopy: (text: string) => Promise<void>;
  onHealth: () => void;
  onTrash: () => void;
  onSettings: () => void;
  onBackup: () => void;
}

const Chip: FC<{ active: boolean; onClick: () => void; children: ReactNode }> = ({ active, onClick, children }) => {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}
      className={cn('inline-flex min-h-9 shrink-0 items-center gap-1 rounded-full border px-3 text-xs font-semibold',
        active ? 'border-transparent bg-indigo-600 text-white'
          : 'border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800')}>
      {children}
    </button>
  );
};

export function VaultList({ entries, health, trashCount, backupDue, busy, onOpen, onAdd, onCopy, onHealth, onTrash, onSettings, onBackup }: ListProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const categories = useMemo(
    () => [...new Set(entries.map((entry) => entry.category).filter((value): value is string => Boolean(value)))].sort(),
    [entries],
  );
  const kinds = useMemo(() => new Set(entries.map(kindOf)), [entries]);
  const weak = new Set(health.weak);
  const reused = new Set(health.reused);

  const visible = entries.filter((entry) => {
    if (filter === 'favorites' && !entry.favorite) return false;
    if (filter.startsWith('category:') && entry.category !== filter.slice(9)) return false;
    if ((['login', 'card', 'wifi', 'note'] as string[]).includes(filter) && kindOf(entry) !== filter) return false;
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return [entry.title, entry.website, entry.username, entry.category ?? '', entry.notes]
      .some((value) => value.toLowerCase().includes(needle));
  }).sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) ||
    a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <button type="button" onClick={onHealth} className="rounded-xl bg-slate-100 p-3 text-left dark:bg-slate-800">
          <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">Health</div>
          <div className="text-xl font-bold">{health.score}<span className="text-xs font-normal text-slate-500">/100</span></div>
        </button>
        <button type="button" onClick={onHealth} className={cn('rounded-xl p-3 text-left',
          health.weak.length ? 'bg-rose-50 text-rose-800 dark:bg-rose-950 dark:text-rose-100' : 'bg-slate-100 dark:bg-slate-800')}>
          <div className="text-xs font-semibold">Weak</div>
          <div className="text-xl font-bold">{health.weak.length}</div>
        </button>
        <button type="button" onClick={onHealth} className={cn('rounded-xl p-3 text-left',
          health.reused.length ? 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100' : 'bg-slate-100 dark:bg-slate-800')}>
          <div className="text-xs font-semibold">Reused</div>
          <div className="text-xl font-bold">{health.reused.length}</div>
        </button>
      </div>

      {backupDue && entries.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-indigo-50 p-3 text-sm text-indigo-900 dark:bg-indigo-950 dark:text-indigo-100">
          <Clock className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">No backup in 30 days. Save one in case you lose access.</span>
          <Button size="sm" variant="secondary" disabled={busy} onClick={onBackup}><Download className="size-4" /> Save backup</Button>
        </div>
      )}

      <div className="flex gap-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search vault</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input type="search" placeholder="Search" className={cn(inputClass, 'pl-9')} value={query}
            onChange={(event) => setQuery(event.target.value)} />
        </label>
        <Button disabled={busy} onClick={onAdd} aria-label="Add item"><Plus className="size-4" /><span className="hidden sm:inline">Add</span></Button>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        <Chip active={filter === 'all'} onClick={() => setFilter('all')}>All {entries.length}</Chip>
        <Chip active={filter === 'favorites'} onClick={() => setFilter('favorites')}><Star className="size-3.5" /> Favourites</Chip>
        {(['card', 'wifi', 'note'] as const).filter((kind) => kinds.has(kind)).map((kind) => (
          <Chip key={kind} active={filter === kind} onClick={() => setFilter(kind)}>{KIND_PLURAL[kind]}</Chip>
        ))}
        {categories.map((category) => (
          <Chip key={category} active={filter === `category:${category}`} onClick={() => setFilter(`category:${category}`)}>{category}</Chip>
        ))}
      </div>

      <Card className="divide-y divide-slate-200 p-1 dark:divide-slate-800">
        {visible.length === 0 && (
          <p className="p-4 text-sm text-slate-500 dark:text-slate-400">
            {entries.length ? 'Nothing matches.' : 'Your vault is empty. Add your first login, card, Wi-Fi password or note.'}
          </p>
        )}
        {visible.map((entry) => {
          const kind = kindOf(entry);
          const copyValue = kind === 'card' ? entry.card?.number : kind === 'note' ? entry.notes : entry.password;
          return (
            <div key={entry.id} className="flex items-center gap-2 px-2 py-2">
              <button type="button" onClick={() => onOpen(entry)} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-1 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50">
                <ItemAvatar entry={entry} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-semibold">{entry.title}</span>
                    {entry.favorite && <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-500" />}
                    {weak.has(entry.id) && <span className="shrink-0 rounded-full bg-rose-50 px-2 text-[11px] font-semibold text-rose-700 dark:bg-rose-950 dark:text-rose-200">Weak</span>}
                    {!weak.has(entry.id) && reused.has(entry.id) && <span className="shrink-0 rounded-full bg-amber-50 px-2 text-[11px] font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-100">Reused</span>}
                  </span>
                  <span className="block truncate text-xs text-slate-500 dark:text-slate-400">{itemSubtitle(entry)}</span>
                </span>
              </button>
              {kind === 'login' && entry.username && <CopyButton icon={UserRound} label={`Copy username for ${entry.title}`} onCopy={() => onCopy(entry.username)} />}
              {copyValue && <CopyButton label={`Copy ${kind === 'card' ? 'card number' : kind === 'note' ? 'note' : 'password'} for ${entry.title}`} onCopy={() => onCopy(copyValue)} />}
            </div>
          );
        })}
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" size="sm" onClick={onHealth}><HeartPulse className="size-4" /> Password health</Button>
        <Button variant="ghost" size="sm" onClick={onTrash}><Trash2 className="size-4" /> Trash{trashCount ? ` (${trashCount})` : ''}</Button>
        <Button variant="ghost" size="sm" onClick={onSettings}><Settings2 className="size-4" /> Vault settings</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export function VaultHealthPanel({ entries, health, onBack, onOpen }: {
  entries: VaultEntry[];
  health: VaultHealth;
  onBack: () => void;
  onOpen: (entry: VaultEntry) => void;
}) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const group = (title: string, hint: string, ids: string[], tone: string) => ids.length ? (
    <Card className="space-y-2 p-4">
      <h3 className={cn('font-bold', tone)}>{title} ({ids.length})</h3>
      <p className="text-sm text-slate-600 dark:text-slate-300">{hint}</p>
      <ul className="divide-y divide-slate-200 dark:divide-slate-800">
        {ids.map((id) => byId.get(id)).filter((entry): entry is VaultEntry => Boolean(entry)).map((entry) => (
          <li key={entry.id}>
            <button type="button" onClick={() => onOpen(entry)} className="flex w-full items-center gap-3 py-2 text-left">
              <ItemAvatar entry={entry} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{entry.title}</span>
                <span className="block text-xs text-slate-500 dark:text-slate-400">{STRENGTH_LABEL[passwordStrength(entry.password)]} password</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  ) : null;
  return (
    <div className="space-y-3">
      <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="size-4" /> All items</Button>
      <Card className="flex items-center gap-4 p-4">
        <div className={cn('flex size-16 shrink-0 items-center justify-center rounded-2xl text-2xl font-bold',
          health.score >= 80 ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
            : health.score >= 50 ? 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100'
              : 'bg-rose-50 text-rose-800 dark:bg-rose-950 dark:text-rose-100')}>
          {health.score}
        </div>
        <div>
          <h3 className="text-lg font-bold">Password health</h3>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {health.checked === 0 ? 'Add passwords to check them.'
              : health.weak.length + health.reused.length + health.old.length === 0 ? `All ${health.checked} passwords look good.`
                : `Checked ${health.checked} passwords on this device. Fix the ones below by editing them and generating a new password.`}
          </p>
        </div>
      </Card>
      {health.checked > 0 && health.weak.length + health.reused.length + health.old.length === 0 && (
        <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300"><ShieldCheck className="size-4" /> Nothing to fix.</p>
      )}
      {group('Weak', 'Short or easy to guess. Change these first.', health.weak, 'text-rose-700 dark:text-rose-300')}
      {group('Reused', 'If one site leaks it, the others are open too. Give each a different password.', health.reused, 'text-amber-800 dark:text-amber-200')}
      {group('Old', 'Not changed for over a year.', health.old, 'text-slate-700 dark:text-slate-200')}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trash
// ---------------------------------------------------------------------------

export function VaultTrashPanel({ entries, busy, now, onBack, onRestore, onDelete }: {
  entries: VaultEntry[];
  busy: boolean;
  now: number;
  onBack: () => void;
  onRestore: (entry: VaultEntry) => void;
  onDelete: (entry: VaultEntry) => void;
}) {
  const [confirming, setConfirming] = useState<string>();
  return (
    <div className="space-y-3">
      <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="size-4" /> All items</Button>
      <Card className="space-y-1 p-4">
        <h3 className="text-lg font-bold">Trash</h3>
        <p className="text-sm text-slate-600 dark:text-slate-300">Items here are deleted for good {TRASH_DAYS} days after you trash them, on all your devices.</p>
      </Card>
      {entries.length === 0 && <p className="text-sm text-slate-500 dark:text-slate-400">The trash is empty.</p>}
      {entries.map((entry) => {
        const daysLeft = Math.max(0, TRASH_DAYS - Math.floor((now - Date.parse(entry.trashedAt ?? '')) / 86_400_000));
        return (
          <Card key={entry.id} className="space-y-2 p-3">
            <div className="flex items-center gap-3">
              <ItemAvatar entry={entry} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{entry.title}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">{itemSubtitle(entry)} · deleted in {daysLeft} {daysLeft === 1 ? 'day' : 'days'}</div>
              </div>
            </div>
            {confirming === entry.id ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm">Delete for good on all devices?</span>
                <Button size="sm" variant="destructive" disabled={busy} onClick={() => onDelete(entry)}>Delete forever</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(undefined)}>Cancel</Button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => onRestore(entry)}><RotateCcw className="size-4" /> Restore</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(entry.id)}>Delete forever</Button>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function VaultSettingsPanel({
  busy, autoLock, quick, lastBackup, onBack, onAutoLock, onEnableQuick, onDisableQuick, onBackup, onImportBackup, onImportCsv,
}: {
  busy: boolean;
  autoLock: AutoLockMinutes;
  quick: QuickUnlockStatus | null;
  lastBackup: string | undefined;
  onBack: () => void;
  onAutoLock: (minutes: AutoLockMinutes) => void;
  onEnableQuick: () => void;
  onDisableQuick: () => void;
  onBackup: (password: string) => void;
  onImportBackup: (file: File) => void;
  onImportCsv: (file: File) => void;
}) {
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [backupError, setBackupError] = useState('');
  const quickName = quick?.method === 'fingerprint' ? 'fingerprint' : 'passkey';
  const submitBackup = (event: FormEvent) => {
    event.preventDefault();
    if (password.length < MIN_VAULT_PASSPHRASE) {
      setBackupError(`Use at least ${MIN_VAULT_PASSPHRASE} characters.`);
      return;
    }
    if (password !== repeat) {
      setBackupError('The two passwords do not match.');
      return;
    }
    setBackupError('');
    setPassword('');
    setRepeat('');
    onBackup(password);
  };
  const filePicker = (label: string, accept: string, onPick: (file: File) => void) => (
    <label className={labelClass}>
      <span>{label}</span>
      <input className={inputClass} type="file" accept={accept} disabled={busy}
        onClick={() => beginExternalActivity()}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) onPick(file);
          else endExternalActivity();
        }} />
    </label>
  );

  return (
    <div className="space-y-3">
      <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="size-4" /> All items</Button>

      <Card className="space-y-3 p-4">
        <h3 className="flex items-center gap-2 font-bold"><Fingerprint className="size-5" /> Ask for {quickName} to open</h3>
        {!quick ? <p className="text-sm">Checking this device…</p> : !quick.available ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {quick.method === 'fingerprint'
              ? 'Set up a fingerprint in the phone’s settings to use it here. On older app versions, update the app first.'
              : 'This browser has no fingerprint, face or screen lock it can use for passkeys.'}
          </p>
        ) : quick.enabled ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <p className="flex-1 text-sm">On for this device: the vault asks for your {quickName} each time it opens.</p>
              <Button size="sm" variant="secondary" disabled={busy} onClick={onDisableQuick}>Turn off</Button>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-semibold">Lock again after</p>
              <div role="radiogroup" aria-label="Auto-lock after" className="flex gap-2">
                {AUTO_LOCK_CHOICES.map((minutes) => (
                  <button key={minutes} type="button" role="radio" aria-checked={autoLock === minutes} onClick={() => onAutoLock(minutes)}
                    className={cn('min-h-10 flex-1 rounded-xl border text-sm font-semibold',
                      autoLock === minutes ? 'border-indigo-500 bg-indigo-50 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200'
                        : 'border-slate-300 dark:border-slate-700')}>
                    {minutes} min
                  </button>
                ))}
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">The Android app also locks the vault when you leave the app.</p>
            </div>
          </>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {quick.method === 'fingerprint'
                ? 'Off: anyone who can open Dayflow on this phone can open the vault. Turn this on to ask for your fingerprint first.'
                : 'Off: anyone who can open Dayflow in this browser can open the vault. Turn this on to ask for Windows Hello, Touch ID or your phone’s screen lock first (needs a current Chrome or Edge).'}
            </p>
            <Button disabled={busy} onClick={onEnableQuick}><Fingerprint className="size-4" /> Turn on</Button>
          </div>
        )}
      </Card>

      <Card className="space-y-3 p-4">
        <h3 className="flex items-center gap-2 font-bold"><Download className="size-5" /> Backup file</h3>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {lastBackup ? `Last saved on this device: ${lastBackup.slice(0, 10)}.` : 'No backup saved from this device yet.'}
          {' '}Your vault already syncs with your account. A backup file is an extra copy, locked with a password you choose now.
        </p>
        <form className="space-y-2" onSubmit={submitBackup} autoComplete="off">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className={labelClass}>
              <span>Backup password</span>
              <input className={inputClass} type="password" maxLength={256} autoComplete="new-password" value={password}
                disabled={busy} onChange={(event) => setPassword(event.target.value)} />
            </label>
            <label className={labelClass}>
              <span>Repeat password</span>
              <input className={inputClass} type="password" maxLength={256} autoComplete="new-password" value={repeat}
                disabled={busy} onChange={(event) => setRepeat(event.target.value)} />
            </label>
          </div>
          {backupError && <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">{backupError}</p>}
          <Button type="submit" variant="secondary" disabled={busy}><Download className="size-4" /> Save backup file</Button>
        </form>
      </Card>

      <Card className="space-y-3 p-4">
        <h3 className="flex items-center gap-2 font-bold"><Upload className="size-5" /> Import</h3>
        {filePicker('Dayflow backup file (.json)', '.json,application/json', onImportBackup)}
        {filePicker('Chrome, Google Password Manager or Bitwarden export (.csv)', '.csv,text/csv', onImportCsv)}
        <p className="flex gap-2 text-xs text-amber-800 dark:text-amber-200">
          <AlertTriangle className="size-4 shrink-0" /> A CSV export holds your passwords unencrypted. Delete the file after importing.
        </p>
      </Card>
    </div>
  );
}